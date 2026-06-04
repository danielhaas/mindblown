/**
 * Tests for the triage CRUD routes (#92, #93).
 *
 * Auth gate (closes the #69-style hole for triage): API-key auth is
 * always 403, regardless of map permissions. Session-JWT with `view`
 * permission can list; `edit` is required for override / reclassify.
 *
 * Pattern mirrors admin-endpoints-guard.test.ts — we stub the DB +
 * downstream services so the test exercises route wiring (param parsing,
 * filter handling, gate enforcement) without standing up Postgres or
 * the Anthropic SDK.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ── State helpers ─────────────────────────────────────────────────

interface TriageRow {
  id: string;
  mapId: string;
  externalId: string;
  issueTitle: string;
  issueState: string;
  decision: 'place' | 'skip' | 'uncertain';
  reason: string;
  confidence: number;
  placedNodeId: string | null;
  decidedAt: Date;
  decidedBy: 'auto' | 'operator';
  reviewed: boolean;
  reviewedAt: Date | null;
  reviewedBy: string | null;
}

const triageRows = new Map<string, TriageRow>();
const nodes = new Map<string, { id: string; mapId: string; parentId: string | null }>();
let permissionLevel: 'view' | 'edit' | 'admin' | null = 'edit';

function seedRow(overrides: Partial<TriageRow> = {}): TriageRow {
  const id = overrides.id ?? `tr-${triageRows.size + 1}`;
  const row: TriageRow = {
    id,
    mapId: 'map-1',
    externalId: 'o/r#42',
    issueTitle: 'a title',
    issueState: 'open',
    decision: 'uncertain',
    reason: 'unsure',
    confidence: 40,
    placedNodeId: null,
    decidedAt: new Date(),
    decidedBy: 'auto',
    reviewed: false,
    reviewedAt: null,
    reviewedBy: null,
    ...overrides,
  };
  triageRows.set(id, row);
  return row;
}

// ── Predicate-aware DB stub ──────────────────────────────────────

type Predicate = { __pred: true; check: (row: Record<string, unknown>) => boolean };
function applyPred(rows: Record<string, unknown>[], pred: unknown): Record<string, unknown>[] {
  if (!pred || typeof pred !== 'object') return rows;
  const p = pred as { __pred?: true; check?: (row: Record<string, unknown>) => boolean };
  if (!p.__pred || typeof p.check !== 'function') return rows;
  return rows.filter((r) => p.check!(r));
}

function buildSelectChain() {
  const step: { table?: string; pred?: unknown; limit?: number } = {};
  const resolve = async (): Promise<Record<string, unknown>[]> => {
    let rows: Record<string, unknown>[] = [];
    if (step.table === 'triageDecisions') {
      rows = [...triageRows.values()].map((r) => ({ ...r }));
    } else if (step.table === 'nodes') {
      rows = [...nodes.values()].map((n) => ({ ...n }));
    }
    const filtered = applyPred(rows, step.pred);
    return step.limit ? filtered.slice(0, step.limit) : filtered;
  };
  const thenable = {
    then: (onFulfilled: (v: Record<string, unknown>[]) => unknown, onRejected?: (err: unknown) => unknown) =>
      resolve().then(onFulfilled, onRejected),
    catch: (onRejected: (err: unknown) => unknown) => resolve().catch(onRejected),
    where: (pred: unknown) => {
      step.pred = pred;
      return thenable;
    },
    orderBy: () => thenable,
    limit: (n: number) => {
      step.limit = n;
      return thenable;
    },
  };
  return {
    from(table: { __name?: string }) {
      step.table = table.__name;
      return thenable;
    },
  };
}

vi.mock('../../db/connection.js', () => {
  const db = {
    select: () => buildSelectChain(),
    update: (table: { __name?: string }) => ({
      set: (vals: Record<string, unknown>) => ({
        where: async (pred: unknown) => {
          if (table?.__name !== 'triageDecisions') return;
          const p = pred as { __pred?: true; check?: (row: Record<string, unknown>) => boolean };
          for (const row of triageRows.values()) {
            if (p?.check?.(row as unknown as Record<string, unknown>)) {
              Object.assign(row, vals);
            }
          }
        },
      }),
    }),
    insert: () => ({ values: () => ({ returning: async () => [] }) }),
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(db),
  };
  return { db };
});

vi.mock('../../db/schema.js', () => {
  const col = (name: string) => ({ __col: name });
  return {
    maps: { __name: 'maps', id: col('id') },
    nodes: {
      __name: 'nodes',
      id: col('id'),
      mapId: col('mapId'),
      parentId: col('parentId'),
    },
    triageDecisions: {
      __name: 'triageDecisions',
      id: col('id'),
      mapId: col('mapId'),
      externalId: col('externalId'),
      decision: col('decision'),
      reviewed: col('reviewed'),
      decidedAt: col('decidedAt'),
    },
  };
});

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('drizzle-orm');
  return {
    ...actual,
    eq: (column: { __col?: string }, value: unknown): Predicate => ({
      __pred: true,
      check: (row) => row[column.__col ?? ''] === value,
    }),
    and: (...preds: Predicate[]): Predicate => ({
      __pred: true,
      check: (row) => preds.every((p) => p.check(row)),
    }),
    desc: () => ({ __order: 'desc' }),
    sql: vi.fn(),
  };
});

// vi.mock factories are hoisted above any non-hoisted code, so any value
// they close over must also be declared via `vi.hoisted` — direct `const`
// references would TDZ-error at module init. We pin the mocks under a
// hoisted namespace and re-expose the spies via local `const`s for
// ergonomic per-test assertions.
const mocks = vi.hoisted(() => ({
  createNodeMock: vi.fn(async (input: Record<string, unknown>) => ({
    id: 'created-node',
    mapId: input.mapId,
    parentId: input.parentId,
  })),
  updateNodeMock: vi.fn(async (nodeId: string) => ({
    id: nodeId,
    mapId: 'map-1',
    parentId: 'epic-1',
  })),
  moveNodeMock: vi.fn(async (nodeId: string, newParentId: string) => ({
    id: nodeId,
    mapId: 'map-1',
    parentId: newParentId,
  })),
  triageIssueMock: vi.fn(async () => ({
    decision: 'place' as const,
    parentNodeId: 'epic-1',
    reason: 'reclassified, now matches Frontend',
    confidence: 88,
  })),
}));
const createNodeMock = mocks.createNodeMock;
const updateNodeMock = mocks.updateNodeMock;
const moveNodeMock = mocks.moveNodeMock;
const triageIssueMock = mocks.triageIssueMock;
vi.mock('../../db/nodes.js', () => ({
  createNode: mocks.createNodeMock,
  updateNode: mocks.updateNodeMock,
  moveNode: mocks.moveNodeMock,
}));

// Permission stub — the test toggles `permissionLevel` to drive the gate.
vi.mock('../../db/permissions.js', () => ({
  getPermission: vi.fn(async () => permissionLevel),
  hasPermission: (actual: string | null, required: string) => {
    if (actual == null) return false;
    const rank: Record<string, number> = { view: 1, edit: 2, admin: 3 };
    return (rank[actual] ?? 0) >= (rank[required] ?? 0);
  },
}));

vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

vi.mock('../../sync/triage.js', () => ({
  triageIssue: mocks.triageIssueMock,
}));

vi.mock('../../sync/mapContext.js', () => ({
  buildMapContext: vi.fn(async (mapId: string) => ({
    mapId,
    mapName: 'm',
    mapDescription: '',
    epics: [{ nodeId: 'epic-1', title: 'Frontend', description: 'UI' }],
  })),
}));

import { triageRoutes } from '../triage.js';

// ── Harness ──────────────────────────────────────────────────────

async function buildApp(authSource: 'jwt' | 'api-key' | 'none'): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    if (authSource === 'none') return;
    req.userId = 'user-1';
    req.authSource = authSource;
  });
  await app.register(triageRoutes);
  return app;
}

beforeEach(() => {
  triageRows.clear();
  nodes.clear();
  permissionLevel = 'edit';
  createNodeMock.mockClear();
  updateNodeMock.mockClear();
  moveNodeMock.mockClear();
  triageIssueMock.mockClear();
});

// ── Auth gate ────────────────────────────────────────────────────

describe('triage routes — auth gate', () => {
  it('GET → 403 for API-key auth even when the user has admin perm', async () => {
    permissionLevel = 'admin';
    const app = await buildApp('api-key');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions',
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code).toBe('FORBIDDEN');
  });

  it('GET → 401 when unauthenticated', async () => {
    const app = await buildApp('none');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions',
    });
    await app.close();
    expect(res.statusCode).toBe(401);
  });

  it('GET → 403 when JWT but no map permission', async () => {
    permissionLevel = null;
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions',
    });
    await app.close();
    expect(res.statusCode).toBe(403);
  });

  it('POST /override → 403 for API-key even when user has edit', async () => {
    permissionLevel = 'edit';
    seedRow({ id: 'tr-1' });
    const app = await buildApp('api-key');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/override',
      payload: { decision: 'skip', reason: 'no' },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
  });

  it('POST /override → 403 for JWT with view-only', async () => {
    permissionLevel = 'view';
    seedRow({ id: 'tr-1' });
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/override',
      payload: { decision: 'skip', reason: 'no' },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
  });

  it('POST /reclassify → 403 for API-key', async () => {
    permissionLevel = 'edit';
    seedRow({ id: 'tr-1' });
    const app = await buildApp('api-key');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/reclassify',
    });
    await app.close();
    expect(res.statusCode).toBe(403);
  });
});

// ── GET filters ──────────────────────────────────────────────────

describe('GET /api/maps/:mapId/triage-decisions', () => {
  it('returns all decisions in the map when no filters are set', async () => {
    seedRow({ id: 't1', decision: 'skip', reviewed: true });
    seedRow({ id: 't2', decision: 'place', reviewed: false });
    seedRow({ id: 't3', decision: 'uncertain', reviewed: false });

    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(3);
  });

  it('filters by reviewed=false', async () => {
    seedRow({ id: 't1', reviewed: true });
    seedRow({ id: 't2', reviewed: false });
    seedRow({ id: 't3', reviewed: false });

    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions?reviewed=false',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(2);
  });

  it('filters by decision=skip', async () => {
    seedRow({ id: 't1', decision: 'skip' });
    seedRow({ id: 't2', decision: 'place' });
    seedRow({ id: 't3', decision: 'skip' });

    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions?decision=skip',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(2);
    const decisions = (res.json().decisions as Array<{ decision: string }>).map(
      (d) => d.decision,
    );
    expect(decisions.every((d) => d === 'skip')).toBe(true);
  });

  it('honors limit and caps at 200', async () => {
    for (let i = 0; i < 10; i++) seedRow({ id: `t${i}` });
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions?limit=3',
    });
    await app.close();
    expect(res.json().total).toBe(3);
  });
});

// ── POST /override ───────────────────────────────────────────────

describe('POST .../override', () => {
  it('rejects invalid decision values', async () => {
    seedRow({ id: 'tr-1' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/override',
      payload: { decision: 'maybe' },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects place without parentNodeId', async () => {
    seedRow({ id: 'tr-1' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/override',
      payload: { decision: 'place' },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the row does not exist', async () => {
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/missing/override',
      payload: { decision: 'skip' },
    });
    await app.close();
    expect(res.statusCode).toBe(404);
  });

  it('place: creates a node, stamps placedNodeId, marks reviewed=true', async () => {
    seedRow({
      id: 'tr-1',
      externalId: 'o/r#42',
      issueTitle: 'My issue',
      issueState: 'open',
      decision: 'uncertain',
      confidence: 30,
    });
    nodes.set('epic-1', { id: 'epic-1', mapId: 'map-1', parentId: 'root-1' });
    permissionLevel = 'edit';

    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/override',
      payload: {
        decision: 'place',
        parentNodeId: 'epic-1',
        reason: 'I know better',
      },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().nodeId).toBe('created-node');
    expect(createNodeMock).toHaveBeenCalledOnce();
    expect(createNodeMock.mock.calls[0][0]).toMatchObject({
      mapId: 'map-1',
      parentId: 'epic-1',
      text: '#42 My issue',
    });
    // Row was updated to operator-decided + reviewed.
    const row = triageRows.get('tr-1')!;
    expect(row.decidedBy).toBe('operator');
    expect(row.reviewed).toBe(true);
    expect(row.placedNodeId).toBe('created-node');
  });

  it('place: rejects parentNodeId that is not in this map', async () => {
    seedRow({ id: 'tr-1' });
    nodes.set('outside', { id: 'outside', mapId: 'other-map', parentId: null });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/override',
      payload: { decision: 'place', parentNodeId: 'outside' },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(createNodeMock).not.toHaveBeenCalled();
  });

  it('skip / uncertain: updates the row, no node created', async () => {
    seedRow({ id: 'tr-1', decision: 'place', confidence: 80 });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/override',
      payload: { decision: 'skip', reason: 'not for us' },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(createNodeMock).not.toHaveBeenCalled();
    const row = triageRows.get('tr-1')!;
    expect(row.decision).toBe('skip');
    expect(row.reason).toBe('not for us');
    expect(row.decidedBy).toBe('operator');
    expect(row.reviewed).toBe(true);
  });

  it('place when placedNodeId already exists → does not double-create', async () => {
    seedRow({
      id: 'tr-1',
      decision: 'place',
      placedNodeId: 'existing-node',
    });
    nodes.set('epic-1', { id: 'epic-1', mapId: 'map-1', parentId: null });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/override',
      payload: { decision: 'place', parentNodeId: 'epic-1' },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('already_placed');
    expect(res.json().nodeId).toBe('existing-node');
    expect(createNodeMock).not.toHaveBeenCalled();
  });

  // mindblown#99 fix 3 — override of an already-placed node with a
  // different parentNodeId must call moveNode + broadcast node:moved,
  // not silently drop the reparent.
  it('place + already-placed + new parentNodeId → calls moveNode and broadcasts', async () => {
    seedRow({
      id: 'tr-1',
      decision: 'place',
      placedNodeId: 'placed-node',
    });
    // Both old + new parents are in this map.
    nodes.set('epic-A', { id: 'epic-A', mapId: 'map-1', parentId: 'root-1' });
    nodes.set('epic-B', { id: 'epic-B', mapId: 'map-1', parentId: 'root-1' });
    // The placed node currently lives under epic-A.
    nodes.set('placed-node', { id: 'placed-node', mapId: 'map-1', parentId: 'epic-A' });
    permissionLevel = 'edit';

    const wsMod = await import('../../ws.js');
    const broadcastMock = wsMod.broadcast as unknown as ReturnType<typeof vi.fn>;
    broadcastMock.mockClear();

    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/override',
      payload: { decision: 'place', parentNodeId: 'epic-B' },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('moved');
    expect(res.json().nodeId).toBe('placed-node');
    expect(moveNodeMock).toHaveBeenCalledOnce();
    expect(moveNodeMock.mock.calls[0][0]).toBe('placed-node');
    expect(moveNodeMock.mock.calls[0][1]).toBe('epic-B');
    expect(createNodeMock).not.toHaveBeenCalled();
    // node:moved broadcast carries the new parent so any open UI updates.
    expect(broadcastMock).toHaveBeenCalledWith(
      'map-1',
      expect.objectContaining({
        type: 'node:moved',
        nodeId: 'placed-node',
        newParentId: 'epic-B',
      }),
    );
    // Row was marked reviewed + operator-decided.
    const row = triageRows.get('tr-1')!;
    expect(row.decidedBy).toBe('operator');
    expect(row.reviewed).toBe(true);
  });

  it('place + already-placed + SAME parent → no move, status=already_placed', async () => {
    seedRow({
      id: 'tr-1',
      decision: 'place',
      placedNodeId: 'placed-node',
    });
    nodes.set('epic-A', { id: 'epic-A', mapId: 'map-1', parentId: 'root-1' });
    nodes.set('placed-node', { id: 'placed-node', mapId: 'map-1', parentId: 'epic-A' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/override',
      payload: { decision: 'place', parentNodeId: 'epic-A' },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('already_placed');
    expect(moveNodeMock).not.toHaveBeenCalled();
  });
});

// ── POST /reclassify ─────────────────────────────────────────────

describe('POST .../reclassify', () => {
  it('re-runs triageIssue and updates the row in place', async () => {
    seedRow({
      id: 'tr-1',
      decision: 'uncertain',
      confidence: 30,
      reason: 'old reason',
      reviewed: true,
      decidedBy: 'operator',
    });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/reclassify',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(triageIssueMock).toHaveBeenCalledOnce();
    expect(res.json().decision).toBe('place');
    expect(res.json().confidence).toBe(88);
    // Row was rewritten — decidedBy='auto', reviewed=false again.
    const row = triageRows.get('tr-1')!;
    expect(row.decision).toBe('place');
    expect(row.confidence).toBe(88);
    expect(row.decidedBy).toBe('auto');
    expect(row.reviewed).toBe(false);
  });

  it('returns 404 when the row does not exist', async () => {
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/missing/reclassify',
    });
    await app.close();
    expect(res.statusCode).toBe(404);
  });

  // mindblown#99 fix 4 — when reclassify produces a non-place decision
  // on a row that had placed a node before, the row must clear
  // `placedNodeId` so it stops referencing an orphan. The node itself
  // is intentionally NOT deleted (operator removes via the UI).
  it('reclassify → skip clears placedNodeId on a previously-placed row', async () => {
    triageIssueMock.mockResolvedValueOnce({
      decision: 'skip' as const,
      parentNodeId: undefined,
      reason: 'no longer relevant',
      confidence: 92,
    } as unknown as Awaited<ReturnType<typeof triageIssueMock>>);
    seedRow({
      id: 'tr-1',
      decision: 'place',
      placedNodeId: 'orphan-node',
      confidence: 80,
      reviewed: true,
      decidedBy: 'operator',
    });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/reclassify',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().decision).toBe('skip');
    const row = triageRows.get('tr-1')!;
    expect(row.decision).toBe('skip');
    expect(row.placedNodeId).toBeNull();
    expect(row.reviewed).toBe(false);
    expect(row.decidedBy).toBe('auto');
  });

  it('reclassify → place keeps placedNodeId (only non-place clears it)', async () => {
    // Default triageIssueMock returns decision='place' with parentNodeId='epic-1'.
    seedRow({
      id: 'tr-1',
      decision: 'place',
      placedNodeId: 'node-still-here',
      confidence: 50,
    });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/reclassify',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const row = triageRows.get('tr-1')!;
    // Reclassify doesn't auto-apply (no node created here) — but it
    // also doesn't clear the previously-placed node id, since the new
    // decision is still 'place'.
    expect(row.placedNodeId).toBe('node-still-here');
  });
});
