/**
 * Outgoing webhooks: a map or a whole workspace subscribes a URL to what
 * happens on its tickets. MindBlown POSTs one JSON body per event, signed
 * with the subscription's secret (HMAC-SHA256), and retries on failure.
 * First consumer: the Tracer avatar's session hub.
 *
 * The event vocabulary and the pure "which events does this node change
 * mean" rule live here so every surface (server, MCP tools, tests) reads
 * the same list.
 */
import type { Node, StatusDef } from './types.js';

export const WEBHOOK_EVENTS = [
  /** The node's status changed (any transition). */
  'node.status_changed',
  /** The node's status moved into a done-category status. Fires together with node.status_changed. */
  'node.done',
  /** A session claimed the node. */
  'node.claimed',
  /** The node's claim was released (released, swept as stale, or done). */
  'node.released',
  /** A session or AI asked a person something about a node (an open ask). */
  'node.question',
  /** The node got a blocker (blockedReason set). */
  'node.blocked',
  /** The node's health turned `behind` (overdue / past due with work left). */
  'node.behind',
  /** A pull found nothing claimable left on the map. Fires once per run-dry, again after a grant. */
  'queue.empty',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Sent with every delivery so a receiver can check it is wired up. */
export const WEBHOOK_PING_EVENT = 'ping';

export function isWebhookEvent(e: string): e is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(e);
}

/** A subscription as the API returns it — never the secret (only once, on create). */
export interface WebhookSubscription {
  id: string;
  workspaceId: string;
  /** null = every map of the workspace. */
  mapId: string | null;
  url: string;
  /** Empty = every event. */
  events: WebhookEvent[];
  active: boolean;
  description: string | null;
  createdAt: string;
  lastDeliveryAt: string | null;
  /** HTTP status of the last attempt; null = network error / never sent. */
  lastStatus: number | null;
  lastError: string | null;
}

/** The JSON body of one delivery. */
export interface WebhookPayload<D = Record<string, unknown>> {
  /** Unique per event (also X-MindBlown-Delivery); retries resend the same id. */
  id: string;
  event: WebhookEvent | typeof WEBHOOK_PING_EVENT;
  occurredAt: string;
  workspaceId: string;
  mapId: string;
  data: D;
}

/** The node fields a delivery carries — enough to act on without a refetch. */
export interface WebhookNodeRef {
  id: string;
  text: string;
  status: string | null;
  claimedBySession: string | null;
  blockedReason: string | null;
  dueDate: string | null;
  percentComplete: number | null;
}

export function webhookNodeRef(n: Node): WebhookNodeRef {
  return {
    id: n.id,
    text: n.text,
    status: n.status,
    claimedBySession: n.claimedBySession,
    blockedReason: n.blockedReason,
    dueDate: n.dueDate,
    percentComplete: n.percentComplete,
  };
}

/** The workflow category of a status id/name, as the map defines it. */
export function statusCategory(workflow: StatusDef[], status: string | null): StatusDef['category'] | null {
  if (status === null) return null;
  const lower = status.toLowerCase();
  const def = workflow.find((s) => s.id === status || s.name.toLowerCase() === lower);
  return def?.category ?? null;
}

/**
 * Which webhook events a node update means, from the fields the update
 * touched and the node after it. A pure read of one update: a re-sent
 * blockedReason that did not change still reads as `node.blocked` — the
 * writers only list fields they wrote.
 */
export function webhookEventsForNodeUpdate(
  fields: readonly string[],
  node: Node,
  workflow: StatusDef[],
): Array<{ event: WebhookEvent; data: Record<string, unknown> }> {
  const out: Array<{ event: WebhookEvent; data: Record<string, unknown> }> = [];
  const ref = webhookNodeRef(node);
  const touched = new Set(fields);
  if (touched.has('status')) {
    const category = statusCategory(workflow, node.status);
    out.push({ event: 'node.status_changed', data: { node: ref, status: node.status, category } });
    if (category === 'done') out.push({ event: 'node.done', data: { node: ref, status: node.status } });
  }
  if (touched.has('claimedBySession')) {
    if (node.claimedBySession) out.push({ event: 'node.claimed', data: { node: ref, sessionId: node.claimedBySession } });
    else out.push({ event: 'node.released', data: { node: ref } });
  }
  if (touched.has('blockedReason') && node.blockedReason) {
    out.push({ event: 'node.blocked', data: { node: ref, reason: node.blockedReason } });
  }
  return out;
}
