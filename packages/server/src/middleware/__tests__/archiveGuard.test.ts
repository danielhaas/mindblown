/**
 * Archived maps are frozen — request-guard tests.
 *
 * Pins (a) how the guard resolves the target map for each URL shape
 * (map-scoped, version- and cycle-keyed, AI body, unrelated) and (b)
 * that a mutating request on an archived map gets 409 MAP_ARCHIVED
 * while reads, the unarchive write and the map delete pass through.
 *
 * DB modules are stubbed: `isMapArchived` answers from a Set, version
 * and cycle lookups from small tables.
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

import { registerArchiveGuard } from '../archiveGuard.js';

async function buildApp() {
  const app = Fastify();
  await registerArchiveGuard(app);
  const ok = async () => ({ ok: true });
  app.get('/api/maps/:id', ok);
  app.put('/api/maps/:id', ok);
  app.delete('/api/maps/:id', ok);
  app.post('/api/maps/:id/nodes', ok);
  app.put('/api/maps/:id/nodes/:nodeId', ok);
  app.post('/api/maps/:id/pull-next', ok);
  app.put('/api/maps/:id/fleet-status/:host', ok);
  app.put('/api/maps/:id/asks', ok);
  app.post('/api/maps/:id/triage/:decisionId/confirm', ok);
  app.post('/api/maps/sync/audit-drift', ok);
  app.post('/api/versions', ok);
  app.put('/api/versions/:id', ok);
  app.post('/api/cycles', ok);
  app.post('/api/cycles/:id/rollover', ok);
  app.post('/api/ai/breakdown/accept', ok);
  app.post('/api/maps', ok);
  app.post('/api/api-keys', ok);
  await app.ready();
  return app;
}

describe('archive guard', () => {
  beforeEach(() => {
    archivedIds.clear();
    archivedIds.add('frozen');
  });

  it('refuses every mutating map-scoped request on an archived map with 409 MAP_ARCHIVED', async () => {
    const app = await buildApp();
    const cases: Array<[string, string, unknown?]> = [
      ['POST', '/api/maps/frozen/nodes', { text: 'x' }],
      ['PUT', '/api/maps/frozen/nodes/n1', { text: 'x' }],
      ['POST', '/api/maps/frozen/pull-next', {}],
      ['PUT', '/api/maps/frozen/fleet-status/sat1', {}],
      ['PUT', '/api/maps/frozen/asks', { asks: [] }],
      ['POST', '/api/maps/frozen/triage/d1/confirm', {}],
      ['PUT', '/api/maps/frozen', { name: 'renamed' }],
      ['PUT', '/api/maps/frozen', { archived: true }],
      ['POST', '/api/versions', { mapId: 'frozen', name: 'V9' }],
      ['PUT', '/api/versions/v-frozen', { name: 'V9' }],
      ['POST', '/api/cycles', { mapId: 'frozen', name: 'S1' }],
      ['POST', '/api/cycles/c-frozen/rollover', {}],
      ['POST', '/api/ai/breakdown/accept', { mapId: 'frozen', nodes: [] }],
    ];
    for (const [method, url, payload] of cases) {
      const res = await app.inject({ method: method as 'POST', url, payload: payload as object });
      expect(res.statusCode, `${method} ${url}`).toBe(409);
      expect(res.json().error.code, `${method} ${url}`).toBe('MAP_ARCHIVED');
    }
  });

  it('lets reads, the unarchive write and the map delete through on an archived map', async () => {
    const app = await buildApp();
    const cases: Array<[string, string, unknown?]> = [
      ['GET', '/api/maps/frozen'],
      ['PUT', '/api/maps/frozen', { archived: false }],
      ['PUT', '/api/maps/frozen', { archived: false, name: 'also fine' }],
      ['DELETE', '/api/maps/frozen'],
    ];
    for (const [method, url, payload] of cases) {
      const res = await app.inject({ method: method as 'GET', url, payload: payload as object | undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(200);
    }
  });

  it('does not touch active maps or routes without a map target', async () => {
    const app = await buildApp();
    const cases: Array<[string, string, unknown?]> = [
      ['POST', '/api/maps/live/nodes', { text: 'x' }],
      ['PUT', '/api/maps/live', { archived: true }],
      ['PUT', '/api/versions/v-live', { name: 'V1' }],
      ['POST', '/api/maps', { name: 'new' }],
      ['POST', '/api/maps/sync/audit-drift', {}],
      ['POST', '/api/api-keys', { name: 'k' }],
      ['POST', '/api/cycles/c-unknown/rollover', {}],
    ];
    for (const [method, url, payload] of cases) {
      const res = await app.inject({ method: method as 'POST', url, payload: payload as object });
      expect(res.statusCode, `${method} ${url}`).toBe(200);
    }
  });
});
