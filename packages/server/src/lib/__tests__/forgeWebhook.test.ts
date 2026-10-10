/**
 * The repo webhook of a PAT/OAuth forge binding (#386): created when
 * missing, re-armed (events always sent — Gitea resets a PATCH without
 * them to `push` only) when present, secret generated and stored first,
 * set only where none is stored and read back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GiteaForge, type ForgeFetch } from '@mindblown/integrations';

/** What the row's secret reads as after the conditional store. */
let storedSecret: string | undefined;
let dbUpdates = 0;
vi.mock('../../db/connection.js', () => ({
  db: {
    update: () => ({
      set: () => ({
        where: async () => {
          dbUpdates += 1;
          storedSecret ??= 'f'.repeat(64);
        },
      }),
    }),
    select: () => ({
      from: () => ({ where: async () => [{ config: { webhookSecret: storedSecret } }] }),
    }),
  },
}));
vi.mock('../../db/schema.js', () => ({ integrations: { id: 'id', config: 'config' } }));

let forge: GiteaForge | null = null;
vi.mock('../forge.js', () => ({ forgeFromIntegration: async () => forge }));

import { ensureForgeWebhook, publicWebhookUrl, readForgeWebhook, setUpWebhookAfterBind, WEBHOOK_EVENTS } from '../forgeWebhook.js';

const URL_ = 'https://mb.test/api/webhooks/github';

interface Call { method: string; url: string; body: unknown; signal?: unknown }
function giteaWith(responses: Array<{ status: number; body: unknown }>): { calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: ForgeFetch = async (url, init) => {
    calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined, signal: init.signal });
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
  dbUpdates = 0;
  storedSecret = undefined;
});

describe('ensureForgeWebhook (Gitea)', () => {
  it('no hook yet (Gitea lists none as null): stores a secret, then creates the hook with the secret read back', async () => {
    const { calls } = giteaWith([{ status: 200, body: 'null' }, { status: 201, body: { id: 7, active: true, events: [], config: {} } }]);
    const res = await ensureForgeWebhook(row(), URL_);
    expect(res).toEqual({ status: 'created', hookId: 7, url: URL_, events: WEBHOOK_EVENTS.gitea });
    expect(dbUpdates).toBe(1);
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: 'https://git.test/api/v1/repos/dan/r/hooks',
      body: { type: 'gitea', active: true, events: WEBHOOK_EVENTS.gitea, config: { url: URL_, content_type: 'json', secret: storedSecret } },
    });
    // Every forge call is bounded — connect awaits this.
    expect(calls.every((c) => c.signal)).toBe(true);
  });

  it('a set-up racing another one uses the secret that won the store, not its own', async () => {
    storedSecret = 'a'.repeat(64); // the other set-up stored first
    const { calls } = giteaWith([{ status: 200, body: [] }, { status: 201, body: { id: 8 } }]);
    await ensureForgeWebhook(row(), URL_);
    expect((calls[1].body as { config: { secret: string } }).config.secret).toBe('a'.repeat(64));
  });

  it('a hook to our URL exists: re-armed by PATCH with the events and the stored secret, nothing stored', async () => {
    const { calls } = giteaWith([
      { status: 200, body: [{ id: 3, active: false, events: ['push'], config: { url: 'https://elsewhere/x' } }, { id: 4, active: false, events: ['push'], config: { url: URL_ } }] },
      { status: 200, body: { id: 4, active: true, events: WEBHOOK_EVENTS.gitea, config: {} } },
    ]);
    const res = await ensureForgeWebhook(row('s3cret'), URL_);
    expect(res).toMatchObject({ status: 'updated', hookId: 4 });
    expect(dbUpdates).toBe(0);
    expect(calls[1]).toMatchObject({
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
    expect(dbUpdates).toBe(0);
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

describe('publicWebhookUrl / setUpWebhookAfterBind', () => {
  const saved = { PUBLIC_URL: process.env.PUBLIC_URL, FRONTEND_URL: process.env.FRONTEND_URL };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('PUBLIC_URL wins, an empty one falls through to FRONTEND_URL, nothing configured → null', () => {
    process.env.PUBLIC_URL = 'https://mind.example/';
    expect(publicWebhookUrl()).toBe('https://mind.example/api/webhooks/github');
    process.env.PUBLIC_URL = '';
    process.env.FRONTEND_URL = 'https://front.example';
    expect(publicWebhookUrl()).toBe('https://front.example/api/webhooks/github');
    delete process.env.PUBLIC_URL;
    delete process.env.FRONTEND_URL;
    expect(publicWebhookUrl()).toBeNull();
  });

  it('without a public URL the set-up fails with the reason instead of guessing one', async () => {
    delete process.env.PUBLIC_URL;
    delete process.env.FRONTEND_URL;
    const { calls } = giteaWith([]);
    expect(await setUpWebhookAfterBind(row('s'))).toMatchObject({ status: 'failed', reason: expect.stringMatching(/PUBLIC_URL/) });
    expect(calls).toHaveLength(0);
  });
});
