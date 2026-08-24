/**
 * Route-wiring tests for /api/maps/:id/lint (+ dismissals). The engine
 * has its own pure tests (../../lint/__tests__/engine.test.ts); here we
 * pin permission gates, param validation, and the dismissal round-trip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

let permissionLevel: 'view' | 'edit' | 'admin' | null = 'edit';

vi.mock('../../db/permissions.js', () => ({
  getPermission: vi.fn(async () => permissionLevel),
  hasPermission: (perm: string | null, level: 'view' | 'edit' | 'admin') => {
    if (!perm) return false;
    const order = { view: 0, edit: 1, admin: 2 } as const;
    return order[perm as keyof typeof order] >= order[level];
  },
}));

const mapData = {
  map: {
    id: 'map-1',
    effortUnit: 'days',
    hoursPerDay: 8,
    statusWorkflow: [{ id: 'wip', category: 'in_progress' }],
  },
  nodes: [
    {
      id: 'root',
      parentId: null,
      childrenIds: ['leaf-1'],
      text: 'Root',
      effortEstimate: null,
      percentComplete: null,
      dependencies: [],
    },
    {
      id: 'leaf-1',
      parentId: 'root',
      childrenIds: [],
      text: 'Unestimated task',
      effortEstimate: null,
      actualEffort: null,
      percentComplete: 0,
      status: null,
      priority: null,
      dueDate: null,
      startDate: null,
      description: null,
      requirementId: null,
      versionId: null,
      dependencies: [],
    },
  ],
};

vi.mock('../../db/maps.js', () => ({
  getMap: vi.fn(async (id: string) => (id === 'map-1' ? mapData : null)),
}));

vi.mock('../../db/events.js', () => ({
  listEvents: vi.fn(async () => []),
}));

vi.mock('../../db/acceptances.js', () => ({
  listActiveAcceptances: vi.fn(async () => []),
}));

interface DismissalRow {
  id: string;
  mapId: string;
  nodeId: string | null;
  ruleId: string;
  dismissedBy: string | null;
  createdAt: Date;
}
const dismissals: DismissalRow[] = [];

vi.mock('../../db/lint.js', () => ({
  listDismissals: vi.fn(async (mapId: string) => dismissals.filter((d) => d.mapId === mapId)),
  upsertDismissal: vi.fn(async (mapId: string, ruleId: string, nodeId: string | null, by: string | null) => {
    const existing = dismissals.find((d) => d.mapId === mapId && d.ruleId === ruleId && d.nodeId === nodeId);
    if (existing) return { row: existing, created: false };
    const row: DismissalRow = {
      id: `dis-${dismissals.length + 1}`,
      mapId,
      nodeId,
      ruleId,
      dismissedBy: by,
      createdAt: new Date(),
    };
    dismissals.push(row);
    return { row, created: true };
  }),
  deleteDismissal: vi.fn(async (mapId: string, ruleId: string, nodeId: string | null) => {
    const idx = dismissals.findIndex(
      (d) => d.mapId === mapId && d.ruleId === ruleId && d.nodeId === nodeId,
    );
    if (idx >= 0) dismissals.splice(idx, 1);
  }),
}));

// Active-lane default: the route asks db/versions for the map's lanes.
// Default is [] (no active lane) so pre-existing tests keep their
// whole-map behavior; the lane-default tests push into this array.
const versionRows: Array<{ id: string; name: string; status: string; sortOrder: number }> = [];
vi.mock('../../db/versions.js', () => ({
  listVersions: vi.fn(async () => versionRows),
}));

import { lintRoutes } from '../lint.js';

async function buildApp(userId: string | null = 'user-1'): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as unknown as { userId: string | null }).userId = userId;
  });
  await app.register(lintRoutes);
  return app;
}

beforeEach(() => {
  permissionLevel = 'edit';
  dismissals.length = 0;
  versionRows.length = 0;
});

describe('GET /api/maps/:id/lint', () => {
  it('returns a structured report with the unestimated leaf flagged', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/maps/map-1/lint' });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.warnCount).toBeGreaterThanOrEqual(1);
    const unest = body.rules.find((r: { ruleId: string }) => r.ruleId === 'unestimated-leaf');
    expect(unest.findings).toHaveLength(1);
    expect(unest.findings[0].nodeId).toBe('leaf-1');
    expect(unest.why).toBeTruthy();
    expect(unest.fix).toBeTruthy();
  });

  it('403 without view permission', async () => {
    permissionLevel = null;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/maps/map-1/lint' });
    await app.close();
    expect(res.statusCode).toBe(403);
  });

  it('404 for an unknown map, 404 for an unknown scope node, 400 for an unknown rule', async () => {
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/api/maps/nope/lint' })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/api/maps/map-1/lint?nodeId=nope' })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/api/maps/map-1/lint?rule=bogus' })).statusCode,
    ).toBe(400);
    await app.close();
  });

  it('rule filter narrows the report and recomputes counts', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/maps/map-1/lint?rule=stale-plan' });
    await app.close();
    const body = res.json();
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0].ruleId).toBe('stale-plan');
    expect(body.warnCount).toBe(0);
  });

  it('dismissed findings are flagged and excluded from counts', async () => {
    dismissals.push({
      id: 'dis-x',
      mapId: 'map-1',
      nodeId: 'leaf-1',
      ruleId: 'unestimated-leaf',
      dismissedBy: 'user-1',
      createdAt: new Date(),
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/maps/map-1/lint' });
    await app.close();
    const unest = res.json().rules.find((r: { ruleId: string }) => r.ruleId === 'unestimated-leaf');
    expect(unest.findings[0].dismissed).toBe(true);
    expect(unest.activeCount).toBe(0);
  });
});

describe('GET /api/maps/:id/lint — active-lane default scope', () => {
  const LANES = [
    { id: 'v1', name: 'V1', status: 'active', sortOrder: 10 },
    { id: 'v15', name: 'V1.5', status: 'active', sortOrder: 15 },
    { id: 'v2', name: 'V2', status: 'planning', sortOrder: 20 },
  ];

  it('unscoped call defaults to the active lane with the highest sortOrder', async () => {
    versionRows.push(...LANES);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/maps/map-1/lint' });
    await app.close();
    const body = res.json();
    expect(body.scopeLabel).toContain('V1.5');
    expect(body.scopeLabel).toContain('active lane');
    // Machine consumers read the structured scope, not the label.
    expect(body.scope).toMatchObject({
      versionId: 'v15',
      defaultedToLane: true,
      versionName: 'V1.5',
    });
    // The unestimated leaf carries no version tag → out of lane scope.
    const unest = body.rules.find((r: { ruleId: string }) => r.ruleId === 'unestimated-leaf');
    expect(unest.findings).toHaveLength(0);
  });

  it('scope=all lints the whole map', async () => {
    versionRows.push(...LANES);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/maps/map-1/lint?scope=all' });
    await app.close();
    const body = res.json();
    expect(body.scopeLabel).not.toContain('active lane');
    const unest = body.rules.find((r: { ruleId: string }) => r.ruleId === 'unestimated-leaf');
    expect(unest.findings).toHaveLength(1);
  });

  it('an explicit scope wins over the default', async () => {
    versionRows.push(...LANES);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/maps/map-1/lint?nodeId=leaf-1' });
    await app.close();
    expect(res.json().scopeLabel).not.toContain('active lane');
  });

  it('maps without an active lane keep the whole-map behavior', async () => {
    versionRows.push({ id: 'v2', name: 'V2', status: 'planning', sortOrder: 20 });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/maps/map-1/lint' });
    await app.close();
    const body = res.json();
    expect(body.scopeLabel).not.toContain('active lane');
    const unest = body.rules.find((r: { ruleId: string }) => r.ruleId === 'unestimated-leaf');
    expect(unest.findings).toHaveLength(1);
  });
});

describe('dismissal endpoints', () => {
  it('POST creates (201), repeat POST is idempotent (200 same row)', async () => {
    const app = await buildApp();
    const first = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/lint/dismissals',
      payload: { ruleId: 'unestimated-leaf', nodeId: 'leaf-1' },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/lint/dismissals',
      payload: { ruleId: 'unestimated-leaf', nodeId: 'leaf-1' },
    });
    await app.close();
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
  });

  it('POST without nodeId records a map-wide rule mute', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/lint/dismissals',
      payload: { ruleId: 'oversized-leaf' },
    });
    await app.close();
    expect(res.statusCode).toBe(201);
    expect(res.json().nodeId).toBeNull();
  });

  it('POST validates ruleId', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/lint/dismissals',
      payload: { ruleId: 'bogus' },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
  });

  it('POST/DELETE require edit permission (view-only is 403)', async () => {
    permissionLevel = 'view';
    const app = await buildApp();
    const post = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/lint/dismissals',
      payload: { ruleId: 'stale-plan' },
    });
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/maps/map-1/lint/dismissals?ruleId=stale-plan',
    });
    await app.close();
    expect(post.statusCode).toBe(403);
    expect(del.statusCode).toBe(403);
  });

  it('DELETE undoes a dismissal so the finding becomes active again', async () => {
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/lint/dismissals',
      payload: { ruleId: 'unestimated-leaf', nodeId: 'leaf-1' },
    });
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/maps/map-1/lint/dismissals?ruleId=unestimated-leaf&nodeId=leaf-1',
    });
    expect(del.statusCode).toBe(204);
    const res = await app.inject({ method: 'GET', url: '/api/maps/map-1/lint' });
    await app.close();
    const unest = res.json().rules.find((r: { ruleId: string }) => r.ruleId === 'unestimated-leaf');
    expect(unest.findings[0].dismissed).toBe(false);
    expect(unest.activeCount).toBe(1);
  });
});
