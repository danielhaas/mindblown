/**
 * Outgoing webhook subscriptions — rows of `webhook_subscriptions`.
 * The secret never leaves this module in a list/get; `getDeliveryTargets`
 * is the one read that hands it out, to the delivery code.
 */
import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { WebhookEvent, WebhookEventStat, WebhookSubscription } from '@mindblown/core';
import { db } from './connection.js';
import { maps, webhookEventStats, webhookSent, webhookSubscriptions, workspaces } from './schema.js';

type Row = typeof webhookSubscriptions.$inferSelect;

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

export function rowToSubscription(r: Row): WebhookSubscription {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    mapId: r.mapId,
    url: r.url,
    events: (r.events as WebhookEvent[]) ?? [],
    active: r.active,
    description: r.description,
    createdAt: iso(r.createdAt)!,
    lastDeliveryAt: iso(r.lastDeliveryAt),
    lastStatus: r.lastStatus,
    lastError: r.lastError,
  };
}

export interface CreateSubscriptionRow {
  workspaceId: string;
  mapId: string | null;
  url: string;
  /** Stored as given — the service encrypts. */
  secret: string;
  events: WebhookEvent[];
  description: string | null;
  createdBy: string | null;
}

export async function createSubscription(input: CreateSubscriptionRow): Promise<WebhookSubscription> {
  const [row] = await db.insert(webhookSubscriptions).values(input).returning();
  return rowToSubscription(row);
}

/** The map's own subscriptions plus its workspace's map-wide ones. */
export async function listForMap(mapId: string, workspaceId: string): Promise<WebhookSubscription[]> {
  const rows = await db
    .select()
    .from(webhookSubscriptions)
    .where(
      and(
        eq(webhookSubscriptions.workspaceId, workspaceId),
        or(eq(webhookSubscriptions.mapId, mapId), isNull(webhookSubscriptions.mapId)),
      ),
    )
    .orderBy(asc(webhookSubscriptions.createdAt));
  return rows.map(rowToSubscription);
}

export async function getSubscription(id: string): Promise<WebhookSubscription | null> {
  const [row] = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id));
  return row ? rowToSubscription(row) : null;
}

export interface UpdateSubscriptionPatch {
  url?: string;
  events?: WebhookEvent[];
  active?: boolean;
  description?: string | null;
}

export async function updateSubscription(id: string, patch: UpdateSubscriptionPatch): Promise<WebhookSubscription | null> {
  const [row] = await db.update(webhookSubscriptions).set(patch).where(eq(webhookSubscriptions.id, id)).returning();
  return row ? rowToSubscription(row) : null;
}

export async function deleteSubscription(id: string): Promise<boolean> {
  const rows = await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, id)).returning({ id: webhookSubscriptions.id });
  return rows.length > 0;
}

/** What a delivery needs: active subscriptions covering the map, with their secret. */
export interface DeliveryTarget {
  id: string;
  url: string;
  secret: string;
  events: WebhookEvent[];
}

export async function getDeliveryTargets(mapId: string, workspaceId: string): Promise<DeliveryTarget[]> {
  const rows = await db
    .select({ id: webhookSubscriptions.id, url: webhookSubscriptions.url, secret: webhookSubscriptions.secret, events: webhookSubscriptions.events })
    .from(webhookSubscriptions)
    .where(
      and(
        eq(webhookSubscriptions.workspaceId, workspaceId),
        eq(webhookSubscriptions.active, true),
        or(eq(webhookSubscriptions.mapId, mapId), isNull(webhookSubscriptions.mapId)),
      ),
    );
  return rows.map((r) => ({ ...r, events: (r.events as WebhookEvent[]) ?? [] }));
}

/** The one target by id, active or not — for the test delivery. */
export async function getDeliveryTarget(id: string): Promise<DeliveryTarget | null> {
  const [r] = await db
    .select({ id: webhookSubscriptions.id, url: webhookSubscriptions.url, secret: webhookSubscriptions.secret, events: webhookSubscriptions.events })
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, id));
  return r ? { ...r, events: (r.events as WebhookEvent[]) ?? [] } : null;
}

/** Scope and events of every active subscription — the dispatcher's "is anyone listening" cache. */
export async function activeScopes(): Promise<Array<{ workspaceId: string; mapId: string | null; events: WebhookEvent[] }>> {
  const rows = await db
    .select({ workspaceId: webhookSubscriptions.workspaceId, mapId: webhookSubscriptions.mapId, events: webhookSubscriptions.events })
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.active, true));
  return rows.map((r) => ({ ...r, events: (r.events as WebhookEvent[]) ?? [] }));
}

/** The workspace a map lives in; null = no such map. */
export async function workspaceOfMap(mapId: string): Promise<string | null> {
  const [r] = await db.select({ workspaceId: maps.workspaceId }).from(maps).where(eq(maps.id, mapId));
  return r?.workspaceId ?? null;
}

export async function workspaceOwner(workspaceId: string): Promise<string | null> {
  const [r] = await db.select({ ownerId: workspaces.ownerId }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return r?.ownerId ?? null;
}

/** Unarchived maps of these workspaces. */
export async function mapsOfWorkspaces(workspaceIds: string[]): Promise<string[]> {
  if (workspaceIds.length === 0) return [];
  const rows = await db
    .select({ id: maps.id })
    .from(maps)
    .where(and(inArray(maps.workspaceId, workspaceIds), isNull(maps.archivedAt)));
  return rows.map((r) => r.id);
}

export async function recordDelivery(id: string, status: number | null, error: string | null, at = new Date()): Promise<void> {
  await db
    .update(webhookSubscriptions)
    .set({ lastDeliveryAt: at, lastStatus: status, lastError: error })
    .where(eq(webhookSubscriptions.id, id));
}

// ── Dedupe ledger + traffic stats ───────────────────────────────

export const DEDUPE_WINDOW_HOURS = 24;

/**
 * Which of these keys may go out now: those not sent for (event, map)
 * within the window. Claims them in the same statement (sent_at = now), so
 * two pushes racing for one key send it once.
 */
export async function claimSends(event: WebhookEvent, mapId: string, keys: string[], now = new Date()): Promise<Set<string>> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return new Set();
  const rows = await db
    .insert(webhookSent)
    .values(unique.map((dedupeKey) => ({ event, mapId, dedupeKey, sentAt: now })))
    .onConflictDoUpdate({
      target: [webhookSent.event, webhookSent.mapId, webhookSent.dedupeKey],
      set: { sentAt: sql`excluded.sent_at` },
      setWhere: sql`${webhookSent.sentAt} <= excluded.sent_at - make_interval(hours => ${DEDUPE_WINDOW_HOURS})`,
    })
    .returning({ key: webhookSent.dedupeKey });
  return new Set(rows.map((r) => r.key));
}

/** The state behind these keys was reset (answered, granted, unblocked): the next one is news. */
export async function forgetSends(event: WebhookEvent, mapId: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db
    .delete(webhookSent)
    .where(and(eq(webhookSent.event, event), eq(webhookSent.mapId, mapId), inArray(webhookSent.dedupeKey, keys)));
}

/** Add to this hour's sent / suppressed count of (map, event). */
export async function countEvent(mapId: string, event: WebhookEvent, sent: number, suppressed: number, now = new Date()): Promise<void> {
  if (sent === 0 && suppressed === 0) return;
  const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  await db
    .insert(webhookEventStats)
    .values({ mapId, event, hour, sent, suppressed })
    .onConflictDoUpdate({
      target: [webhookEventStats.mapId, webhookEventStats.event, webhookEventStats.hour],
      set: {
        sent: sql`${webhookEventStats.sent} + excluded.sent`,
        suppressed: sql`${webhookEventStats.suppressed} + excluded.suppressed`,
      },
    });
}

/** The map's traffic per event: sent in the current hour, sent and suppressed over the last 24 h. */
export async function eventStats(mapId: string, now = new Date()): Promise<WebhookEventStat[]> {
  const hourStart = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
  const since = new Date(hourStart - 23 * 3_600_000);
  const rows = await db
    .select()
    .from(webhookEventStats)
    .where(and(eq(webhookEventStats.mapId, mapId), gte(webhookEventStats.hour, since)));
  const byEvent = new Map<string, WebhookEventStat>();
  for (const r of rows) {
    const s = byEvent.get(r.event) ?? { event: r.event as WebhookEvent, sentLastHour: 0, sent24h: 0, suppressed24h: 0 };
    s.sent24h += r.sent;
    s.suppressed24h += r.suppressed;
    if (new Date(r.hour).getTime() === hourStart) s.sentLastHour += r.sent;
    byEvent.set(r.event, s);
  }
  return [...byEvent.values()].sort((a, b) => b.sent24h + b.suppressed24h - (a.sent24h + a.suppressed24h) || a.event.localeCompare(b.event));
}

/** Ledger rows past the window and stats older than a week carry nothing — drop them. */
export async function pruneLedger(now = new Date()): Promise<void> {
  await db.delete(webhookSent).where(lt(webhookSent.sentAt, new Date(now.getTime() - DEDUPE_WINDOW_HOURS * 3_600_000)));
  await db.delete(webhookEventStats).where(lt(webhookEventStats.hour, new Date(now.getTime() - 7 * 86_400_000)));
}
