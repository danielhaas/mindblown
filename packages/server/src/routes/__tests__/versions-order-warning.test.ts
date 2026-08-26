/**
 * Version write path — order lint (#331).
 *
 * POST /api/versions and PUT /api/versions/:id must:
 *   1. never reject a write because of a date/order contradiction,
 *   2. return the contradiction as `warnings: string[]` on the body,
 *   3. return `warnings: []` when the order is consistent,
 *   4. forward the caller's userId to updateVersion (audit trail).
 *
 * Pattern mirrors lint-routes.test.ts — the DB layer is stubbed so this
 * exercises route wiring, not Postgres. The inversion detector itself is
 * covered in core (versions.test.ts); here we only need it to run over
 * whatever listVersions returns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

interface Row {
  id: string;
  mapId: string;
  name: string;
  description: string | null;
  status: string;
  targetDate: string | null;
  sortOrder: number;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

const rows = new Map<string, Row>();
let permissionLevel: 'view' | 'edit' | 'admin' | null = 'edit';

const mocks = vi.hoisted(() => ({
  updateVersionMock: vi.fn(),
}));

vi.mock('../../db/permissions.js', () => ({
  getPermission: vi.fn(async () => permissionLevel),
  hasPermission: (level: string | null, required: string) => {
    const order = ['view', 'edit', 'admin'];
    if (!level) return false;
    return order.indexOf(level) >= order.indexOf(required);
  },
}));

vi.mock('../../db/cycles.js', () => ({ listCycles: vi.fn(async () => []) }));

// Map-existence check in POST goes straight through drizzle.
vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [{ id: 'map-1', workspaceId: 'ws-1' }],
      }),
    }),
  },
}));
vi.mock('../../db/schema.js', () => ({ maps: { id: 'id' } }));

// Fully stubbed (no importOriginal — the real module drags mapContext →
// nodes → drizzle into the graph). orderWarnings mirrors the real one:
// core's detector over listVersions.
vi.mock('../../db/versions.js', async () => {
  const { findVersionOrderInversions } = await import('@mindblown/core');
  const listVersions = vi.fn(async (mapId: string) =>
    [...rows.values()].filter((r) => r.mapId === mapId),
  );
  return {
    listVersions,
    getVersion: vi.fn(async (id: string) => rows.get(id) ?? null),
    createVersion: vi.fn(async (input: { mapId: string; name: string; targetDate?: string; sortOrder?: number }) => {
      const row: Row = {
        id: `v-${rows.size + 1}`,
        mapId: input.mapId,
        name: input.name,
        description: null,
        status: 'planning',
        targetDate: input.targetDate ?? null,
        sortOrder: input.sortOrder ?? 0,
        releasedAt: null,
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
      };
      rows.set(row.id, row);
      return row;
    }),
    updateVersion: mocks.updateVersionMock,
    orderWarnings: async (mapId: string) =>
      findVersionOrderInversions(await listVersions(mapId)).map((i) => i.reason),
  };
});

import { versionRoutes } from '../versions.js';

async function buildApp(userId: string | null = 'user-1'): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as unknown as { userId: string | null }).userId = userId;
  });
  await app.register(versionRoutes);
  return app;
}

beforeEach(() => {
  rows.clear();
  permissionLevel = 'edit';
  mocks.updateVersionMock.mockReset();
  mocks.updateVersionMock.mockImplementation(async (id: string, input: Partial<Row>) => {
    const cur = rows.get(id);
    if (!cur) return null;
    const next = { ...cur, ...input, updatedAt: '2026-08-26T01:00:00.000Z' };
    rows.set(id, next);
    return next;
  });
});

describe('POST /api/versions — order warnings (#331)', () => {
  it('returns warnings: [] on a consistent write', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/versions',
      payload: { mapId: 'map-1', name: 'V1', targetDate: '2026-12-18', sortOrder: 10 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('V1');
    expect(body.warnings).toEqual([]);
  });

  it('creates the version AND warns when the new date contradicts the sortOrder', async () => {
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/versions',
      payload: { mapId: 'map-1', name: 'V1', targetDate: '2026-12-18', sortOrder: 10 },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/versions',
      payload: { mapId: 'map-1', name: 'V1.5', targetDate: '2026-09-28', sortOrder: 15 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBe('v-2');
    expect(rows.has('v-2')).toBe(true);
    expect(body.warnings).toEqual([
      '"V1.5" (2026-09-28) is dated before "V1" (2026-12-18) but sorts after it (sortOrder 15 > 10)',
    ]);
  });
});

describe('PUT /api/versions/:id — order warnings + audit wiring (#331)', () => {
  it('warns when a re-date inverts the order, and clears when the date is nulled', async () => {
    const app = await buildApp();
    rows.set('v-1', {
      id: 'v-1', mapId: 'map-1', name: 'V1', description: null, status: 'planning',
      targetDate: '2026-09-02', sortOrder: 0, releasedAt: null, createdAt: '', updatedAt: null,
    });
    rows.set('v-2', {
      id: 'v-2', mapId: 'map-1', name: 'V1.5', description: null, status: 'planning',
      targetDate: '2026-09-28', sortOrder: 0, releasedAt: null, createdAt: '', updatedAt: null,
    });

    // The Fulcrum case: V1 re-dated past V1.5.
    const redate = await app.inject({
      method: 'PUT',
      url: '/api/versions/v-1',
      payload: { targetDate: '2026-12-18' },
    });
    expect(redate.statusCode).toBe(200);
    expect(redate.json().targetDate).toBe('2026-12-18');
    expect(redate.json().warnings).toEqual([
      '"V1.5" (2026-09-28) is dated before "V1" (2026-12-18) but sorts after it (by name, "V1.5" > "V1")',
    ]);

    // Un-dating V1.5 removes it from the comparison.
    const clear = await app.inject({
      method: 'PUT',
      url: '/api/versions/v-2',
      payload: { targetDate: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().warnings).toEqual([]);
  });

  it('forwards the caller userId to updateVersion so the change_events row is attributed', async () => {
    const app = await buildApp('user-42');
    rows.set('v-1', {
      id: 'v-1', mapId: 'map-1', name: 'V1', description: null, status: 'planning',
      targetDate: null, sortOrder: 0, releasedAt: null, createdAt: '', updatedAt: null,
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/versions/v-1',
      payload: { targetDate: '2026-12-18' },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.updateVersionMock).toHaveBeenCalledWith('v-1', { targetDate: '2026-12-18' }, 'user-42');
  });

  it('still 403s without edit permission (lint is not a bypass)', async () => {
    permissionLevel = 'view';
    const app = await buildApp();
    rows.set('v-1', {
      id: 'v-1', mapId: 'map-1', name: 'V1', description: null, status: 'planning',
      targetDate: null, sortOrder: 0, releasedAt: null, createdAt: '', updatedAt: null,
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/versions/v-1',
      payload: { targetDate: '2026-12-18' },
    });
    expect(res.statusCode).toBe(403);
    expect(mocks.updateVersionMock).not.toHaveBeenCalled();
  });
});
