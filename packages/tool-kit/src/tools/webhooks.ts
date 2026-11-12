/**
 * Outgoing webhook tools — subscribe a URL to a map's (or its workspace's)
 * events: status changed / done, claimed / released, question, blocked,
 * behind, queue empty. Admin on the map; a workspace-wide one needs the
 * workspace owner. Deliveries are HMAC-signed (see create_webhook).
 */
import { z } from 'zod';
import { WEBHOOK_EVENTS } from '@mindblown/core';
import type { WebhookSubscription } from '@mindblown/core';
import { defineTool } from '../spec.js';

const eventEnum = z.enum(WEBHOOK_EVENTS);

export function renderWebhook(w: WebhookSubscription): string {
  const scope = w.mapId ? 'map' : 'workspace';
  const events = w.events.length > 0 ? w.events.join(', ') : 'all events';
  const last = w.lastDeliveryAt
    ? `last ${w.lastDeliveryAt.slice(0, 16).replace('T', ' ')} → ${w.lastStatus ?? 'no response'}${w.lastError ? ` (${w.lastError})` : ''}`
    : 'never delivered';
  return [
    `- ${w.id} · ${w.active ? 'active' : 'paused'} · ${scope} · ${w.url}`,
    `  ${events} · ${last}${w.description ? ` · ${w.description}` : ''}`,
  ].join('\n');
}

const SIGNING = [
  'Each delivery is a POST with JSON { id, event, occurredAt, workspaceId, mapId, data } and headers',
  'X-MindBlown-Event, X-MindBlown-Delivery (= id, stable across retries), X-MindBlown-Timestamp (unix s),',
  'X-MindBlown-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>.',
  'Non-2xx / network errors (408, 429, 5xx) are retried after 10 s, 1 min, 5 min, 30 min.',
].join('\n');

export const listWebhooksTool = defineTool({
  name: 'list_webhooks',
  description: "Outgoing webhooks that hear this map: its own and its workspace's. Shows URL, events, last delivery. Never the secret.",
  schema: { mapId: z.string().describe('The map') },
  handler: async (backend, { mapId }) => {
    const list = await backend.listWebhooks(mapId);
    if (list.length === 0) return 'No webhooks on this map.';
    return [`Webhooks: ${list.length}`, ...list.map(renderWebhook)].join('\n');
  },
});

export const createWebhookTool = defineTool({
  name: 'create_webhook',
  description: [
    'Subscribe a URL to this map\'s events (scope "map") or every map of its workspace (scope "workspace", workspace owner only).',
    `Events: ${WEBHOOK_EVENTS.join(', ')}. None given = all.`,
    'queue.empty fires once when a pull finds nothing claimable, again only after a grant.',
    'node.question = a session or AI asked a person (a new open ask). node.behind = a leaf\'s health turned behind.',
    SIGNING,
    'The answer shows the signing secret ONCE — store it at the receiver.',
  ].join('\n'),
  schema: {
    mapId: z.string().describe('The map'),
    url: z.string().describe('http(s) URL that receives the POSTs'),
    events: z.array(eventEnum).optional().describe('Events to send; omit for all'),
    scope: z.enum(['map', 'workspace']).optional().describe("'map' (default) or 'workspace'"),
    description: z.string().optional().describe('What listens here, e.g. "Tracer session hub"'),
    secret: z.string().min(16).optional().describe('Your own signing secret (≥ 16 chars); omit to have one generated'),
  },
  handler: async (backend, { mapId, url, events, scope, description, secret }) => {
    const w = await backend.createWebhook(mapId, { url, events, scope, description, secret });
    return ['Webhook created.', renderWebhook(w), `  secret: ${w.secret}  (shown once — store it at the receiver)`].join('\n');
  },
});

export const updateWebhookTool = defineTool({
  name: 'update_webhook',
  description: 'Change a webhook: URL, events (empty array = all), pause/resume (active), description.',
  schema: {
    mapId: z.string().describe('The map the webhook hears'),
    webhookId: z.string().describe('The webhook id'),
    url: z.string().optional(),
    events: z.array(eventEnum).optional(),
    active: z.boolean().optional().describe('false pauses deliveries'),
    description: z.string().nullable().optional(),
  },
  handler: async (backend, { mapId, webhookId, url, events, active, description }) => {
    const w = await backend.updateWebhook(mapId, webhookId, { url, events, active, description });
    return ['Webhook updated.', renderWebhook(w)].join('\n');
  },
});

export const deleteWebhookTool = defineTool({
  name: 'delete_webhook',
  description: 'Remove a webhook subscription; pending retries stop at their next attempt.',
  schema: { mapId: z.string().describe('The map the webhook hears'), webhookId: z.string().describe('The webhook id') },
  handler: async (backend, { mapId, webhookId }) => {
    const r = await backend.deleteWebhook(mapId, webhookId);
    return r.deleted ? `Webhook ${r.id} deleted.` : `Webhook ${webhookId} was not deleted.`;
  },
});

export const pingWebhookTool = defineTool({
  name: 'ping_webhook',
  description: 'Send one signed `ping` event to a webhook now (no retries) and report what the receiver answered.',
  schema: { mapId: z.string().describe('The map the webhook hears'), webhookId: z.string().describe('The webhook id') },
  handler: async (backend, { mapId, webhookId }) => {
    const r = await backend.pingWebhook(mapId, webhookId);
    return r.delivered ? `Ping delivered (HTTP ${r.status}).` : `Ping failed: ${r.error ?? `HTTP ${r.status}`}.`;
  },
});

export const webhookTools = [listWebhooksTool, createWebhookTool, updateWebhookTool, deleteWebhookTool, pingWebhookTool];
