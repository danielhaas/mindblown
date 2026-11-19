/**
 * Webhook tools — the MCP surface: every tool forwards its arguments to
 * the backend unchanged, the zod schema knows the event vocabulary, the
 * secret is shown on create only.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createWebhookTool, deleteWebhookTool, listWebhooksTool, pingWebhookTool, updateWebhookTool, webhookTools } from '../webhooks.js';
import { allTools } from '../../index.js';
import type { ToolBackend } from '../../backend.js';
import type { WebhookSubscription } from '@mindblown/core';

const sub: WebhookSubscription = {
  id: 'w1', workspaceId: 'ws', mapId: 'm1', url: 'https://hub.example/hook', events: ['node.done', 'queue.empty'],
  active: true, description: 'Tracer', createdAt: '2026-11-12T00:00:00Z',
  lastDeliveryAt: '2026-11-12T01:02:03Z', lastStatus: 200, lastError: null,
};

function backend(calls: unknown[][]): ToolBackend {
  return {
    listWebhooks: async (...a: unknown[]) => (calls.push(['list', ...a]), [sub, { ...sub, id: 'w2', mapId: null, events: [], lastDeliveryAt: null, lastStatus: null }]),
    createWebhook: async (...a: unknown[]) => (calls.push(['create', ...a]), { ...sub, secret: 'abc123' }),
    updateWebhook: async (...a: unknown[]) => (calls.push(['update', ...a]), { ...sub, active: false }),
    deleteWebhook: async (...a: unknown[]) => (calls.push(['delete', ...a]), { deleted: true, id: 'w1' }),
    pingWebhook: async (...a: unknown[]) => (calls.push(['ping', ...a]), { delivered: true, status: 204, error: null }),
  } as unknown as ToolBackend;
}

describe('webhook tools', () => {
  it('are registered', () => {
    const names = allTools.map((t) => t.name);
    for (const t of webhookTools) expect(names).toContain(t.name);
  });

  it('create forwards every field and shows the secret once', async () => {
    const calls: unknown[][] = [];
    const args = { mapId: 'm1', url: 'https://hub.example/hook', events: ['node.done', 'queue.empty'], scope: 'map', description: 'Tracer', secret: undefined };
    const out = await createWebhookTool.handler(backend(calls), args as never);
    expect(calls).toEqual([['create', 'm1', { url: 'https://hub.example/hook', events: ['node.done', 'queue.empty'], scope: 'map', description: 'Tracer', secret: undefined }]]);
    expect(out).toContain('secret: abc123');
    expect(out).toContain('node.done, queue.empty');
  });

  it('the schema takes the known events and refuses others', () => {
    const schema = z.object(createWebhookTool.schema);
    expect(schema.safeParse({ mapId: 'm', url: 'https://x', events: ['node.question', 'node.behind'] }).success).toBe(true);
    expect(schema.safeParse({ mapId: 'm', url: 'https://x', events: ['node.exploded'] }).success).toBe(false);
    expect(schema.safeParse({ mapId: 'm', url: 'https://x', secret: 'short' }).success).toBe(false);
  });

  it('list renders scope, events and the last delivery — never a secret', async () => {
    const calls: unknown[][] = [];
    const out = await listWebhooksTool.handler(backend(calls), { mapId: 'm1' } as never);
    expect(calls).toEqual([['list', 'm1']]);
    expect(out).toContain('w1 · active · map · https://hub.example/hook');
    expect(out).toContain('last 2026-11-12 01:02 → 200');
    expect(out).toContain('w2 · active · workspace');
    expect(out).toContain('all events · never delivered');
    expect(out).not.toContain('secret');
  });

  it('update, delete and ping forward map + webhook id', async () => {
    const calls: unknown[][] = [];
    const b = backend(calls);
    expect(await updateWebhookTool.handler(b, { mapId: 'm1', webhookId: 'w1', active: false } as never)).toContain('paused');
    expect(await deleteWebhookTool.handler(b, { mapId: 'm1', webhookId: 'w1' } as never)).toBe('Webhook w1 deleted.');
    expect(await pingWebhookTool.handler(b, { mapId: 'm1', webhookId: 'w1' } as never)).toBe('Ping delivered (HTTP 204).');
    expect(calls).toEqual([
      ['update', 'm1', 'w1', { url: undefined, events: undefined, active: false, description: undefined }],
      ['delete', 'm1', 'w1'],
      ['ping', 'm1', 'w1'],
    ]);
  });
});
