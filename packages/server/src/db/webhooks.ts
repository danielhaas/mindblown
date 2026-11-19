/**
 * Outgoing webhook subscriptions — rows of `webhook_subscriptions`.
 * The secret never leaves this module in a list/get; `getDeliveryTargets`
 * is the one read that hands it out, to the delivery code.
 */
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { WebhookEvent, WebhookSubscription } from '@mindblown/core';
import { db } from './connection.js';
import { maps, webhookSubscriptions, workspaces } from './schema.js';

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
