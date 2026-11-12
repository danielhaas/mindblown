/**
 * Outgoing webhooks — a map or a whole workspace subscribes a URL to its
 * events; first consumer: the Tracer avatar's session hub.
 *
 * Where the events come from:
 *
 *   node.status_changed / node.done / node.claimed / node.released /
 *   node.blocked — every `node:updated` the server broadcasts to map
 *     viewers (ws.ts `onBroadcast`). Every writer — routes, MCP, pulls,
 *     the stale-claim sweeper, GitHub ingest — already broadcasts, so
 *     tapping the broadcast covers them all without touching each.
 *   queue.empty   — a pull that found nothing claimable (orchestration
 *     announcePull → `noteQueueState`). Edge-triggered per map: once when
 *     the queue runs dry, again only after a grant from that map.
 *   node.question — an ask that is new (or re-opened) in a collector push
 *     (routes/asks → `emitOpenedAsks`).
 *   node.behind   — health is time-driven, so a sweep (`runBehindSweep`)
 *     compares each watched map's leaves against the last sweep. The first
 *     sweep after a start only seeds — a restart does not re-announce
 *     every overdue ticket.
 *
 * Delivery: POST JSON, headers
 *   X-MindBlown-Event, X-MindBlown-Delivery (payload id, stable across
 *   retries), X-MindBlown-Timestamp (unix seconds of this attempt),
 *   X-MindBlown-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>.
 * 2xx = delivered. Network error, timeout, 408, 429 and 5xx are retried
 * after 10 s, 1 min, 5 min, 30 min; any other status is final. Retries
 * live in this process — a restart drops the pending ones. The outcome of
 * the latest attempt lands on the subscription (lastStatus / lastError).
 *
 * Nothing is sent until `startWebhooks()` (index.ts) — imported in tests,
 * the emitters are no-ops.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { buildIsDonePredicate, isWebhookEvent, leafHealth, webhookEventsForNodeUpdate, webhookNodeRef, WEBHOOK_EVENTS, WEBHOOK_PING_EVENT } from '@mindblown/core';
import type { Ask, Node as CoreNode, StatusDef, WebhookEvent, WebhookPayload, WebhookSubscription } from '@mindblown/core';
import * as hookDb from '../db/webhooks.js';
import * as mapDb from '../db/maps.js';
import { decrypt, encrypt, isEncrypted } from '../crypto.js';

export const RETRY_DELAYS_MS = [10_000, 60_000, 5 * 60_000, 30 * 60_000];
const ATTEMPT_TIMEOUT_MS = 10_000;
const BEHIND_SWEEP_MS = 5 * 60_000;

let started = false;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Turn delivery on (index.ts, once the server listens). */
export function startWebhooks(opts: { sweepMs?: number } = {}): void {
  started = true;
  if (sweepTimer) return;
  const ms = opts.sweepMs ?? BEHIND_SWEEP_MS;
  if (ms > 0) {
    sweepTimer = setInterval(() => {
      runBehindSweep().catch((err) => console.warn('[webhooks] behind sweep failed:', err instanceof Error ? err.message : err));
    }, ms);
    sweepTimer.unref?.();
  }
}

/** Tests: back to the imported state. */
export function resetWebhooksForTests(): void {
  started = false;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  scopeCache = null;
  emptyQueues.clear();
  behindByMap.clear();
}

// ── Subscriptions ───────────────────────────────────────────────

export class WebhookValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'WebhookValidationError';
  }
}

/** A workspace-wide subscription hears maps the caller may not see — only the workspace owner manages one. */
export class WebhookForbiddenError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'WebhookForbiddenError';
  }
}

async function requireWorkspaceOwner(workspaceId: string, userId: string | null): Promise<void> {
  if (!userId || (await hookDb.workspaceOwner(workspaceId)) !== userId) {
    throw new WebhookForbiddenError('Only the workspace owner may manage a workspace-wide webhook');
  }
}

export function validateUrl(url: unknown): string {
  if (typeof url !== 'string' || !url.trim()) throw new WebhookValidationError('url is required');
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new WebhookValidationError(`url is not a URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new WebhookValidationError('url must be http(s)');
  if (parsed.username || parsed.password) throw new WebhookValidationError('url must not carry credentials — the signature authenticates');
  return parsed.toString();
}

export function validateEvents(events: unknown): WebhookEvent[] {
  if (events === undefined || events === null) return [];
  if (!Array.isArray(events)) throw new WebhookValidationError('events must be an array');
  const bad = events.filter((e) => typeof e !== 'string' || !isWebhookEvent(e));
  if (bad.length > 0) throw new WebhookValidationError(`Unknown event(s): ${bad.join(', ')}. Known: ${WEBHOOK_EVENTS.join(', ')}`);
  return [...new Set(events as WebhookEvent[])];
}

function sealSecret(secret: string): string {
  return process.env.ENCRYPTION_KEY ? encrypt(secret) : secret;
}

function openSecret(stored: string): string {
  return isEncrypted(stored) ? decrypt(stored) : stored;
}

export interface CreateWebhookInput {
  url: unknown;
  events?: unknown;
  /** 'workspace' = every map of the map's workspace. Default 'map'. */
  scope?: unknown;
  description?: unknown;
  /** Bring your own; else generated. Min 16 chars. */
  secret?: unknown;
}

/** The new subscription plus its secret — the only time the secret is shown. */
export async function createWebhook(
  mapId: string,
  input: CreateWebhookInput,
  userId: string | null,
): Promise<WebhookSubscription & { secret: string }> {
  const url = validateUrl(input.url);
  const events = validateEvents(input.events);
  const scope = input.scope ?? 'map';
  if (scope !== 'map' && scope !== 'workspace') throw new WebhookValidationError("scope must be 'map' or 'workspace'");
  if (input.secret !== undefined && (typeof input.secret !== 'string' || input.secret.length < 16)) {
    throw new WebhookValidationError('secret must be a string of at least 16 characters');
  }
  const workspaceId = await hookDb.workspaceOfMap(mapId);
  if (!workspaceId) throw new WebhookValidationError(`Map ${mapId} not found`);
  if (scope === 'workspace') await requireWorkspaceOwner(workspaceId, userId);
  const secret = (input.secret as string | undefined) ?? randomBytes(32).toString('hex');
  const sub = await hookDb.createSubscription({
    workspaceId,
    mapId: scope === 'map' ? mapId : null,
    url,
    secret: sealSecret(secret),
    events,
    description: typeof input.description === 'string' && input.description.trim() ? input.description.trim().slice(0, 500) : null,
    createdBy: userId,
  });
  scopeCache = null;
  return { ...sub, secret };
}

/** A subscription seen through a map: its own, or one of its workspace. Null = not visible there. */
export async function getWebhookForMap(mapId: string, id: string): Promise<WebhookSubscription | null> {
  const sub = await hookDb.getSubscription(id);
  if (!sub) return null;
  if (sub.mapId === mapId) return sub;
  if (sub.mapId === null && sub.workspaceId === (await hookDb.workspaceOfMap(mapId))) return sub;
  return null;
}

export async function listWebhooks(mapId: string): Promise<WebhookSubscription[]> {
  const workspaceId = await hookDb.workspaceOfMap(mapId);
  return workspaceId ? hookDb.listForMap(mapId, workspaceId) : [];
}

export async function updateWebhook(
  sub: WebhookSubscription,
  patch: { url?: unknown; events?: unknown; active?: unknown; description?: unknown },
  userId: string | null,
): Promise<WebhookSubscription | null> {
  if (sub.mapId === null) await requireWorkspaceOwner(sub.workspaceId, userId);
  const out: hookDb.UpdateSubscriptionPatch = {};
  if (patch.url !== undefined) out.url = validateUrl(patch.url);
  if (patch.events !== undefined) out.events = validateEvents(patch.events);
  if (patch.active !== undefined) {
    if (typeof patch.active !== 'boolean') throw new WebhookValidationError('active must be a boolean');
    out.active = patch.active;
  }
  if (patch.description !== undefined) {
    out.description = typeof patch.description === 'string' && patch.description.trim() ? patch.description.trim().slice(0, 500) : null;
  }
  if (Object.keys(out).length === 0) throw new WebhookValidationError('Nothing to update (url, events, active, description)');
  const updated = await hookDb.updateSubscription(sub.id, out);
  scopeCache = null;
  return updated;
}

export async function deleteWebhook(sub: WebhookSubscription, userId: string | null): Promise<boolean> {
  if (sub.mapId === null) await requireWorkspaceOwner(sub.workspaceId, userId);
  const ok = await hookDb.deleteSubscription(sub.id);
  scopeCache = null;
  return ok;
}

// ── Delivery ────────────────────────────────────────────────────

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export interface AttemptResult {
  ok: boolean;
  /** Worth another try (network error, timeout, 408, 429, 5xx). */
  retry: boolean;
  status: number | null;
  error: string | null;
}

async function attempt(target: hookDb.DeliveryTarget, payload: WebhookPayload, body: string): Promise<AttemptResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  let result: AttemptResult;
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'MindBlown-Webhooks/1',
        'x-mindblown-event': payload.event,
        'x-mindblown-delivery': payload.id,
        'x-mindblown-timestamp': String(timestamp),
        'x-mindblown-signature': signWebhook(openSecret(target.secret), timestamp, body),
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    const ok = res.status >= 200 && res.status < 300;
    result = {
      ok,
      retry: !ok && (res.status === 408 || res.status === 429 || res.status >= 500),
      status: res.status,
      error: ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    result = { ok: false, retry: true, status: null, error: err instanceof Error ? err.message : String(err) };
  }
  await hookDb.recordDelivery(target.id, result.status, result.error).catch(() => {});
  return result;
}

/** One target, with the retry schedule. Resolves after the first attempt; retries run on timers. */
function deliver(target: hookDb.DeliveryTarget, payload: WebhookPayload, tryNo = 0): Promise<AttemptResult> {
  const body = JSON.stringify(payload);
  return attempt(target, payload, body).then((r) => {
    if (!r.ok && r.retry && tryNo < RETRY_DELAYS_MS.length) {
      const t = setTimeout(() => {
        if (started) void deliver(target, payload, tryNo + 1);
      }, RETRY_DELAYS_MS[tryNo]);
      t.unref?.();
    } else if (!r.ok) {
      console.warn(`[webhooks] ${payload.event} ${payload.id} → ${target.url} failed for good: ${r.error}`);
    }
    return r;
  });
}

/** A `ping` to one subscription, now, no retries — the "is it wired up" button. */
export async function pingWebhook(id: string, mapId: string): Promise<AttemptResult | null> {
  const target = await hookDb.getDeliveryTarget(id);
  const workspaceId = await hookDb.workspaceOfMap(mapId);
  if (!target || !workspaceId) return null;
  const payload: WebhookPayload = {
    id: randomUUID(),
    event: WEBHOOK_PING_EVENT,
    occurredAt: new Date().toISOString(),
    workspaceId,
    mapId,
    data: { subscriptionId: id },
  };
  return attempt(target, payload, JSON.stringify(payload));
}

// "Is anyone listening on this map?" — answered from memory so the hot
// path (every node:updated) costs no query when nobody subscribed.
// Dropped on every subscription write in this process.
let scopeCache: { maps: Set<string>; workspaces: Set<string> } | null = null;
const workspaceByMap = new Map<string, string>();

async function listened(mapId: string): Promise<string | null> {
  if (!scopeCache) {
    const rows = await hookDb.activeScopes();
    scopeCache = {
      maps: new Set(rows.filter((r) => r.mapId).map((r) => r.mapId!)),
      workspaces: new Set(rows.filter((r) => !r.mapId).map((r) => r.workspaceId)),
    };
  }
  if (scopeCache.maps.size === 0 && scopeCache.workspaces.size === 0) return null;
  let ws = workspaceByMap.get(mapId);
  if (!ws) {
    ws = (await hookDb.workspaceOfMap(mapId)) ?? undefined;
    if (!ws) return null;
    workspaceByMap.set(mapId, ws);
  }
  return scopeCache.maps.has(mapId) || scopeCache.workspaces.has(ws) ? ws : null;
}

/**
 * Send these events of one map to every subscription that wants them.
 * Never throws — an event source must not fail because a receiver did.
 */
export async function emitWebhookEvents(mapId: string, items: Array<{ event: WebhookEvent; data: Record<string, unknown> }>): Promise<void> {
  if (!started || items.length === 0) return;
  try {
    const workspaceId = await listened(mapId);
    if (!workspaceId) return;
    const targets = await hookDb.getDeliveryTargets(mapId, workspaceId);
    const occurredAt = new Date().toISOString();
    for (const { event, data } of items) {
      const payload: WebhookPayload = { id: randomUUID(), event, occurredAt, workspaceId, mapId, data };
      for (const t of targets) {
        if (t.events.length === 0 || t.events.includes(event)) void deliver(t, payload).catch(() => {});
      }
    }
  } catch (err) {
    console.warn(`[webhooks] emit on map ${mapId} failed:`, err instanceof Error ? err.message : err);
  }
}

// ── Event sources ───────────────────────────────────────────────

/** ws.ts broadcast tap: node:updated → status / claim / blocker events. */
export async function handleBroadcast(mapId: string, message: unknown): Promise<void> {
  if (!started) return;
  const m = message as { type?: unknown; fields?: unknown; node?: unknown };
  if (m?.type !== 'node:updated' || !Array.isArray(m.fields) || !m.node) return;
  try {
    if (!(await listened(mapId))) return;
    const fields = m.fields as string[];
    const workflow = fields.includes('status') ? ((await mapDb.getStatusWorkflow(mapId)) ?? []) : [];
    await emitWebhookEvents(mapId, webhookEventsForNodeUpdate(fields, m.node as CoreNode, workflow));
  } catch (err) {
    console.warn(`[webhooks] node:updated on map ${mapId} failed:`, err instanceof Error ? err.message : err);
  }
}

/** Maps whose queue last read empty — queue.empty fires on the edge into this set. */
const emptyQueues = new Set<string>();

/** A pull's verdict for one map: empty (nothing claimable) or not (a ticket was granted). */
export function noteQueueState(mapId: string, empty: boolean, data: Record<string, unknown> = {}): void {
  if (!empty) {
    emptyQueues.delete(mapId);
    return;
  }
  if (emptyQueues.has(mapId)) return;
  emptyQueues.add(mapId);
  void emitWebhookEvents(mapId, [{ event: 'queue.empty', data }]);
}

/** New or re-opened asks of a collector push → node.question, one per ask on a map. */
export function emitOpenedAsks(opened: Array<{ mapId: string | null; ask: Ask }>): void {
  if (!started) return;
  const byMap = new Map<string, Array<{ event: WebhookEvent; data: Record<string, unknown> }>>();
  for (const { mapId, ask } of opened) {
    if (!mapId || ask.moot) continue;
    const list = byMap.get(mapId) ?? [];
    list.push({
      event: 'node.question',
      data: {
        askId: ask.id,
        question: ask.question,
        author: ask.question_author,
        options: ask.options ?? [],
        answerer: ask.answerer,
        hint: ask.hint,
        title: ask.title,
        url: ask.url,
        ticket: ask.ticket,
        sources: ask.sources ?? [],
        node: ask.unblocks?.node_id ? { id: ask.unblocks.node_id, text: ask.unblocks.node_title, claimedBySession: ask.unblocks.claimed_by } : null,
      },
    });
    byMap.set(mapId, list);
  }
  for (const [mapId, items] of byMap) void emitWebhookEvents(mapId, items);
}

/** Per watched map: the leaves that read `behind` at the last sweep. */
const behindByMap = new Map<string, Set<string>>();

/** Leaves (not done) whose health is `behind` now. */
export function behindLeaves(nodes: CoreNode[], workflow: StatusDef[], threshold: number, now = new Date()): CoreNode[] {
  const isDone = buildIsDonePredicate(workflow);
  return nodes.filter(
    (n) => n.childrenIds.length === 0 && !isDone(n.status) && (n.percentComplete ?? 0) < 100 && leafHealth(n, threshold, now) === 'behind',
  );
}

/** One pass over every map someone watches for node.behind. Exported for tests. */
export async function runBehindSweep(now = new Date()): Promise<number> {
  if (!started) return 0;
  const scopes = (await hookDb.activeScopes()).filter((s) => s.events.length === 0 || s.events.includes('node.behind'));
  const mapIds = new Set(scopes.filter((s) => s.mapId).map((s) => s.mapId!));
  for (const id of await hookDb.mapsOfWorkspaces([...new Set(scopes.filter((s) => !s.mapId).map((s) => s.workspaceId))])) mapIds.add(id);
  for (const id of [...behindByMap.keys()]) if (!mapIds.has(id)) behindByMap.delete(id);

  let sent = 0;
  for (const mapId of mapIds) {
    const got = await mapDb.getMap(mapId);
    if (!got || got.map.archivedAt) continue;
    const behind = behindLeaves(got.nodes, got.map.statusWorkflow ?? [], got.map.healthThreshold ?? 0.2, now);
    const prev = behindByMap.get(mapId);
    behindByMap.set(mapId, new Set(behind.map((n) => n.id)));
    if (!prev) continue; // first look at this map seeds only
    const fresh = behind.filter((n) => !prev.has(n.id));
    sent += fresh.length;
    await emitWebhookEvents(
      mapId,
      fresh.map((n) => ({ event: 'node.behind' as const, data: { node: webhookNodeRef(n), dueDate: n.dueDate } })),
    );
  }
  return sent;
}
