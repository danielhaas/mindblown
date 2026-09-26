/**
 * Who is behind a request — `req.actor` as set by middleware/auth.ts.
 *
 * The archive guard lets a person through and refuses robots, so the
 * mapping must be exact: an interactive session JWT (no `kind`) is a
 * person; the /mcp loopback JWT (`kind: 'loopback'`), a headless
 * long-lived JWT (`kind: 'headless'`) and an API key are agents; no
 * credential at all leaves `actor` unset (the guard treats that as a
 * robot too).
 */
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';

vi.mock('../../db/connection.js', () => ({ db: {} }));
vi.mock('../../db/schema.js', () => ({ users: {}, pendingInvites: {} }));
vi.mock('../../db/permissions.js', () => ({ resolvePendingInvites: vi.fn() }));
vi.mock('../../lib/apiKeys.js', () => ({
  API_KEY_PREFIX: 'mb_',
  validateApiKey: async (token: string) => (token === 'mb_good' ? { userId: 'u-key' } : null),
}));
vi.mock('../../lib/media.js', () => ({ isMediaPlaybackPath: () => false }));
// For the end-to-end case below: real auth + real guard, stubbed lookups.
vi.mock('../../db/maps.js', () => ({ isMapArchived: async (id: string) => id === 'frozen' }));
vi.mock('../../db/versions.js', () => ({ getVersion: async () => null }));
vi.mock('../../db/cycles.js', () => ({ getCycle: async () => null }));
vi.mock('../../db/comments.js', () => ({ getComment: async () => null }));
vi.mock('../../db/nodes.js', () => ({ getNode: async () => null }));

import { registerAuthMiddleware } from '../auth.js';
import { registerArchiveGuard } from '../archiveGuard.js';

const SECRET = process.env.JWT_SECRET ?? 'mindblown-dev-secret-change-in-production';
const sign = (payload: object) => jwt.sign(payload, SECRET, { expiresIn: '1h' });

async function whoami(authorization?: string) {
  const app = Fastify();
  await registerAuthMiddleware(app);
  app.get('/api/whoami', async (req) => ({ userId: req.userId ?? null, authSource: req.authSource ?? null, actor: req.actor ?? null }));
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/api/whoami', headers: authorization ? { authorization } : {} });
  return res.json() as { userId: string | null; authSource: string | null; actor: string | null };
}

describe('req.actor', () => {
  it('an interactive session JWT is a person', async () => {
    const r = await whoami(`Bearer ${sign({ userId: 'u1', email: 'dan@example.com' })}`);
    expect(r).toEqual({ userId: 'u1', authSource: 'jwt', actor: 'person' });
  });

  it('the /mcp loopback JWT is an agent even though it is a JWT', async () => {
    const r = await whoami(`Bearer ${sign({ userId: 'u1', email: 'api-key-loopback', kind: 'loopback' })}`);
    expect(r).toEqual({ userId: 'u1', authSource: 'jwt', actor: 'agent' });
  });

  it('a headless long-lived JWT is an agent', async () => {
    const r = await whoami(`Bearer ${sign({ userId: 'u1', email: 'cli@example.com', kind: 'headless' })}`);
    expect(r.actor).toBe('agent');
  });

  it('a legacy long-lived JWT without `kind` is an agent by its lifetime', async () => {
    const legacy = jwt.sign({ userId: 'u1', email: 'cli@example.com' }, SECRET, { expiresIn: '365d' });
    const r = await whoami(`Bearer ${legacy}`);
    expect(r.actor).toBe('agent');
  });

  it('a session JWT at the default 7-day lifetime is still a person', async () => {
    const session = jwt.sign({ userId: 'u1', email: 'dan@example.com' }, SECRET, { expiresIn: '7d' });
    const r = await whoami(`Bearer ${session}`);
    expect(r.actor).toBe('person');
  });

  it('an API key is an agent', async () => {
    const r = await whoami('Bearer mb_good');
    expect(r).toEqual({ userId: 'u-key', authSource: 'api-key', actor: 'agent' });
  });

  it('no credential leaves actor unset', async () => {
    const r = await whoami();
    expect(r).toEqual({ userId: null, authSource: null, actor: null });
  });

  it('an OAuth state token (same secret, typ oauth-state) is not a credential at all (#397)', async () => {
    const app = Fastify();
    await registerAuthMiddleware(app);
    app.get('/api/whoami', async (req) => ({ userId: req.userId ?? null }));
    await app.ready();
    const state = jwt.sign({ userId: 'u1', nonce: 'abc', typ: 'oauth-state' }, SECRET, { expiresIn: '15m' });
    const res = await app.inject({ method: 'GET', url: '/api/whoami', headers: { authorization: `Bearer ${state}` } });
    expect(res.statusCode).toBe(401);
  });
});

// The check the archive feature stands on: real auth middleware + real
// guard, one agent write on an archived map, three credentials.
describe('archive guard behind the real auth middleware', () => {
  async function post(authorization?: string) {
    const app = Fastify();
    await registerAuthMiddleware(app);
    await registerArchiveGuard(app);
    app.post('/api/maps/:id/nodes', async () => ({ ok: true }));
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/frozen/nodes',
      payload: { text: 'x' },
      headers: authorization ? { authorization } : {},
    });
    return res.statusCode;
  }

  it('a session JWT (a person) may write', async () => {
    expect(await post(`Bearer ${sign({ userId: 'u1', email: 'dan@example.com' })}`)).toBe(200);
  });

  it('the /mcp loopback JWT, exactly as routes/mcp.ts mints it, is refused', async () => {
    expect(await post(`Bearer ${sign({ userId: 'u1', email: 'api-key-loopback', kind: 'loopback' })}`)).toBe(409);
  });

  it('an API key is refused', async () => {
    expect(await post('Bearer mb_good')).toBe(409);
  });

  it('no credential is refused', async () => {
    expect(await post()).toBe(409);
  });
});
