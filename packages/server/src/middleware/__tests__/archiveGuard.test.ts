/**
 * Archived maps: no automated action — request-guard tests.
 *
 * Pins (a) how the guard resolves the target map for each URL shape
 * (map-scoped, version-, cycle- and comment-keyed, AI body, unrelated),
 * (b) that a non-human mutating request on an archived map gets 409
 * MAP_ARCHIVED while reads, the archive-only write, the map delete,
 * fleet telemetry and simulate pass through, and (c) that a person's
 * browser session (authSource 'jwt') is never gated.
 *
 * DB modules are stubbed: `isMapArchived` answers from a Set, version /
 * cycle / comment / node lookups from small tables. `authSource` is
 * injected by a tiny hook that reads an `x-test-auth` header.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const archivedIds = new Set<string>();
vi.mock('../../db/maps.js', () => ({
  isMapArchived: async (id: string) => archivedIds.has(id),
}));
vi.mock('../../db/versions.js', () => ({
  getVersion: async (id: string) => (id === 'v-frozen' ? { id, mapId: 'frozen' } : id === 'v-live' ? { id, mapId: 'live' } : null),
}));
vi.mock('../../db/cycles.js', () => ({
  getCycle: async (id: string) => (id === 'c-frozen' ? { id, mapId: 'frozen' } : null),
}));
vi.mock('../../db/comments.js', () => ({
  getComment: async (id: string) => (id === 'cm-frozen' ? { id, nodeId: 'n-frozen' } : null),
}));
vi.mock('../../db/nodes.js', () => ({
  getNode: async (id: string) => (id === 'n-frozen' ? { id, mapId: 'frozen' } : null),
}));

import { registerArchiveGuard } from '../archiveGuard.js';

async function buildApp() {
  const app = Fastify();
  // Stand-in for middleware/auth.ts: 'jwt' here means an interactive
  // session (actor person); 'api-key' any robot (actor agent). The
  // loopback-JWT → agent mapping itself is pinned in actor.test.ts.
  app.addHook('onRequest', async (req) => {
    const via = req.headers['x-test-auth'];
    if (via === 'jwt') req.actor = 'person';
    if (via === 'api-key') req.actor = 'agent';
  });
  await registerArchiveGuard(app);
  const ok = async () => ({ ok: true });
  app.get('/api/maps/:id', ok);
  app.put('/api/maps/:id', ok);
  app.delete('/api/maps/:id', ok);
  app.post('/api/maps/:id/nodes', ok);
  app.put('/api/maps/:id/nodes/:nodeId', ok);
  app.post('/api/maps/:id/pull-next', ok);
  app.put('/api/maps/:id/fleet-status/:host', ok);
  app.post('/api/maps/:id/fleet-ticks', ok);
  app.post('/api/maps/:id/simulate', ok);
  app.put('/api/maps/:id/asks', ok);
  app.post('/api/maps/:id/triage/:decisionId/confirm', ok);
  app.post('/api/maps/:id/share', ok);
  app.post('/api/maps/sync/audit-drift', ok);
  app.post('/api/versions', ok);
  app.put('/api/versions/:id', ok);
  app.post('/api/cycles', ok);
  app.post('/api/cycles/:id/rollover', ok);
  app.put('/api/comments/:id', ok);
  app.delete('/api/comments/:id', ok);
  app.post('/api/ai/breakdown/accept', ok);
  app.post('/api/maps', ok);
  app.post('/api/api-keys', ok);
  await app.ready();
  return app;
}

type Case = [string, string, unknown?];

async function expectAll(app: Awaited<ReturnType<typeof buildApp>>, cases: Case[], status: number, auth: 'api-key' | 'jwt' | 'none') {
  for (const [method, url, payload] of cases) {
    const res = await app.inject({
      method: method as 'POST',
      url,
      payload: payload as object | undefined,
      headers: auth === 'none' ? {} : { 'x-test-auth': auth },
    });
    expect(res.statusCode, `${auth} ${method} ${url}`).toBe(status);
    if (status === 409) expect(res.json().error.code, `${method} ${url}`).toBe('MAP_ARCHIVED');
  }
}

const AGENT_WRITES: Case[] = [
  ['POST', '/api/maps/frozen/nodes', { text: 'x' }],
  ['PUT', '/api/maps/frozen/nodes/n1', { text: 'x' }],
  ['POST', '/api/maps/frozen/pull-next', {}],
  ['PUT', '/api/maps/frozen/asks', { asks: [] }],
  ['POST', '/api/maps/frozen/triage/d1/confirm', {}],
  ['POST', '/api/maps/frozen/share', { email: 'x@y' }],
  ['PUT', '/api/maps/frozen', { name: 'renamed' }],
  ['PUT', '/api/maps/frozen', { archived: true, maxActiveClaims: 5 }],
  ['POST', '/api/versions', { mapId: 'frozen', name: 'V9' }],
  ['PUT', '/api/versions/v-frozen', { name: 'V9' }],
  ['POST', '/api/cycles', { mapId: 'frozen', name: 'S1' }],
  ['POST', '/api/cycles/c-frozen/rollover', {}],
  ['PUT', '/api/comments/cm-frozen', { text: 'edit' }],
  ['DELETE', '/api/comments/cm-frozen'],
  ['POST', '/api/ai/breakdown/accept', { mapId: 'frozen', nodes: [] }],
];

describe('archive guard', () => {
  beforeEach(() => {
    archivedIds.clear();
    archivedIds.add('frozen');
  });

  it('refuses agent (API-key) writes on an archived map with 409 MAP_ARCHIVED', async () => {
    const app = await buildApp();
    await expectAll(app, AGENT_WRITES, 409, 'api-key');
  });

  it('refuses unauthenticated pushes on an archived map the same way', async () => {
    const app = await buildApp();
    await expectAll(app, [['PUT', '/api/maps/frozen/asks', { asks: [] }]], 409, 'none');
  });

  it('lets a person in the browser (jwt) write to an archived map', async () => {
    const app = await buildApp();
    await expectAll(app, AGENT_WRITES, 200, 'jwt');
  });

  it('lets reads, the archive-only write, the map delete, fleet telemetry and simulate through for agents', async () => {
    const app = await buildApp();
    const cases: Case[] = [
      ['GET', '/api/maps/frozen'],
      ['PUT', '/api/maps/frozen', { archived: false }],
      ['PUT', '/api/maps/frozen', { archived: false, name: 'also fine' }],
      ['PUT', '/api/maps/frozen', { archived: true }], // idempotent re-send
      ['DELETE', '/api/maps/frozen'],
      ['PUT', '/api/maps/frozen/fleet-status/sat1', {}],
      ['POST', '/api/maps/frozen/fleet-ticks', {}],
      ['POST', '/api/maps/frozen/simulate', {}],
    ];
    await expectAll(app, cases, 200, 'api-key');
  });

  it('does not touch active maps or routes without a map target', async () => {
    const app = await buildApp();
    const cases: Case[] = [
      ['POST', '/api/maps/live/nodes', { text: 'x' }],
      ['PUT', '/api/maps/live', { archived: true }],
      ['PUT', '/api/versions/v-live', { name: 'V1' }],
      ['POST', '/api/maps', { name: 'new' }],
      ['POST', '/api/maps/sync/audit-drift', {}],
      ['POST', '/api/api-keys', { name: 'k' }],
      ['POST', '/api/cycles/c-unknown/rollover', {}],
      ['PUT', '/api/comments/cm-unknown', { text: 'x' }],
    ];
    await expectAll(app, cases, 200, 'api-key');
  });
});
