/**
 * The repo webhook of a PAT/OAuth forge binding (#386): created when
 * missing, re-armed (events always sent — Gitea resets a PATCH without
 * them to `push` only) when present, secret generated and stored first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GiteaForge, type ForgeFetch } from '@mindblown/integrations';

const dbUpdates: unknown[] = [];
vi.mock('../../db/connection.js', () => ({
  db: {
    update: () => ({
      set: (v: unknown) => ({
        where: async () => {
          dbUpdates.push(v);
        },
      }),
    }),
  },
}));
vi.mock('../../db/schema.js', () => ({ integrations: { id: 'id' } }));

let forge: GiteaForge | null = null;
vi.mock('../forge.js', () => ({ forgeFromIntegration: async () => forge }));

import { ensureForgeWebhook, publicWebhookUrl, readForgeWebhook, WEBHOOK_EVENTS } from '../forgeWebhook.js';

const URL_ = 'https://mb.test/api/webhooks/github';

interface Call { method: string; url: string; body: unknown }
function giteaWith(responses: Array<{ status: number; body: unknown }>): { calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: ForgeFetch = async (url, init) => {
    calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const next = responses.shift() ?? { status: 200, body: {} };
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      headers: new Headers(),
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  };
  forge = new GiteaForge({ token: 't', apiBaseUrl: 'https://git.test', fetchImpl });
  return { calls };
}

const row = (webhookSecret?: string) => ({
  id: 'int-1',
  provider: 'gitea',
  config: { owner: 'dan', repo: 'r', token: 't', apiBaseUrl: 'https://git.test/api/v1', ...(webhookSecret ? { webhookSecret } : {}) },
});

beforeEach(() => {
  dbUpdates.length = 0;
});

describe('ensureForgeWebhook (Gitea)', () => {
  it('no hook yet (Gitea lists none as null): stores a generated secret, then creates the hook with it', async () => {
    const { calls } = giteaWith([{ status: 200, body: 'null' }, { status: 201, body: { id: 7, active: true, events: [], config: {} } }]);
    const res = await ensureForgeWebhook(row(), URL_);
    expect(res).toEqual({ status: 'created', hookId: 7, url: URL_, events: WEBHOOK_EVENTS.gitea });
    expect(dbUpdates).toHaveLength(1);
    const secret = (dbUpdates[0] as { config: { webhookSecret: string } }).config.webhookSecret;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[1]).toEqual({
      method: 'POST',
      url: 'https://git.test/api/v1/repos/dan/r/hooks',
      body: { type: 'gitea', active: true, events: WEBHOOK_EVENTS.gitea, config: { url: URL_, content_type: 'json', secret } },
    });
  });

  it('a hook to our URL exists: re-armed by PATCH with the events and the stored secret, nothing stored', async () => {
    const { calls } = giteaWith([
      { status: 200, body: [{ id: 3, active: false, events: ['push'], config: { url: 'https://elsewhere/x' } }, { id: 4, active: false, events: ['push'], config: { url: URL_ } }] },
      { status: 200, body: { id: 4, active: true, events: WEBHOOK_EVENTS.gitea, config: {} } },
    ]);
    const res = await ensureForgeWebhook(row('s3cret'), URL_);
    expect(res).toMatchObject({ status: 'updated', hookId: 4 });
    expect(dbUpdates).toHaveLength(0);
    expect(calls[1]).toEqual({
      method: 'PATCH',
      url: 'https://git.test/api/v1/repos/dan/r/hooks/4',
      body: { active: true, events: WEBHOOK_EVENTS.gitea, config: { url: URL_, content_type: 'json', secret: 's3cret' } },
    });
  });

  it('a token without repo admin: failed, with the hint what the token needs', async () => {
    giteaWith([{ status: 403, body: { message: 'forbidden' } }]);
    const res = await ensureForgeWebhook(row('s'), URL_);
    expect(res).toMatchObject({ status: 'failed', reason: expect.stringContaining('403') });
    expect(res.status === 'failed' && res.hint).toMatch(/admin/);
  });

  it('Gitea refusing the target host: the ALLOWED_HOST_LIST hint', async () => {
    giteaWith([{ status: 200, body: [] }, { status: 422, body: { message: 'webhook can only call allowed HTTP servers' } }]);
    const res = await ensureForgeWebhook(row('s'), URL_);
    expect(res.status === 'failed' && res.hint).toMatch(/ALLOWED_HOST_LIST/);
  });

  it('no usable connection: failed without touching the DB', async () => {
    forge = null;
    expect(await ensureForgeWebhook(row(), URL_)).toMatchObject({ status: 'failed' });
    expect(dbUpdates).toHaveLength(0);
  });
});

describe('readForgeWebhook', () => {
  it('reports the hook and the events it lacks', async () => {
    giteaWith([{ status: 200, body: [{ id: 4, active: true, events: ['issues', 'pull_request'], config: { url: URL_ } }] }]);
    const state = await readForgeWebhook(row('s'), URL_);
    expect(state.hook).toEqual({ id: 4, active: true, events: ['issues', 'pull_request'] });
    expect(state.secretStored).toBe(true);
    expect(state.missingEvents).toContain('issue_label');
    expect(state.missingEvents).not.toContain('issues');
  });
});

describe('publicWebhookUrl', () => {
  const saved = { PUBLIC_URL: process.env.PUBLIC_URL, FRONTEND_URL: process.env.FRONTEND_URL };
  afterEach(() => {
    process.env.PUBLIC_URL = saved.PUBLIC_URL;
    process.env.FRONTEND_URL = saved.FRONTEND_URL;
    if (saved.PUBLIC_URL === undefined) delete process.env.PUBLIC_URL;
    if (saved.FRONTEND_URL === undefined) delete process.env.FRONTEND_URL;
  });

  it('PUBLIC_URL wins; else the forwarded origin; else nothing', () => {
    process.env.PUBLIC_URL = 'https://mind.example/';
    expect(publicWebhookUrl({ host: 'internal:3001' })).toBe('https://mind.example/api/webhooks/github');
    delete process.env.PUBLIC_URL;
    delete process.env.FRONTEND_URL;
    expect(publicWebhookUrl({ host: 'internal:3001', 'x-forwarded-host': 'mind.example', 'x-forwarded-proto': 'https' })).toBe(
      'https://mind.example/api/webhooks/github',
    );
    expect(publicWebhookUrl({})).toBeNull();
  });
});
