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

// done-without-pr asks the forge which PRs reference each done+linked
// node. Default: no forge bound (rule skipped); the sync-pack tests
// install a fake forge per case.
let forgeContext: {
  owner: string;
  repo: string;
  token: string;
  forge: { listCrossReferencingPullRequests: (o: string, r: string, n: number) => Promise<number[]> };
} | null = null;
vi.mock('../../lib/githubContext.js', () => ({
  getForgeContextForMap: vi.fn(async () => forgeContext),
}));

const applyLintFix = vi.fn(async (_mapId: string, nodeId: string, action: string) => ({
  action,
  node: { id: nodeId, text: 'fixed' },
  changedFields: ['status'],
}));
// Fully mocked (no importActual): the real fix.ts pulls in routes/nodes.ts
// and with it the whole forge stack, which this route test does not stub.
vi.mock('../../lint/fix.js', () => ({
  applyLintFix: (...a: unknown[]) => applyLintFix(...(a as [string, string, string])),
  LintFixError: class LintFixError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { lintRoutes, resetForgePrCache } from '../lint.js';
import { LintFixError } from '../../lint/fix.js';

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
  forgeContext = null;
  mapData.nodes.splice(2);
  mapData.map.statusWorkflow = [{ id: 'wip', category: 'in_progress' }];
  resetForgePrCache();
  applyLintFix.mockClear();
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

describe('POST /api/maps/:id/lint/fix', () => {
  it('applies an action the rule offers and returns the outcome', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/lint/fix',
      payload: { ruleId: 'claim-churn', nodeId: 'leaf-1', action: 'park', note: '715 pickups' },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ action: 'park', changedFields: ['status'] });
    expect(applyLintFix).toHaveBeenCalledWith('map-1', 'leaf-1', 'park', 'user-1', { note: '715 pickups' });
  });

  it('400 for an action the rule does not offer, a rule with no fixes, or a missing node', async () => {
    const app = await buildApp();
    const bad = (payload: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/api/maps/map-1/lint/fix', payload });
    expect((await bad({ ruleId: 'claim-churn', nodeId: 'leaf-1', action: 'mark-done' })).statusCode).toBe(400);
    expect((await bad({ ruleId: 'unestimated-leaf', nodeId: 'leaf-1', action: 'mark-done' })).statusCode).toBe(400);
    expect((await bad({ ruleId: 'claim-churn', action: 'park' })).statusCode).toBe(400);
    await app.close();
    expect(applyLintFix).not.toHaveBeenCalled();
  });

  it('re-verifies map-only rules first: 409 when the finding no longer applies, 200 when it does', async () => {
    mapData.map.statusWorkflow = [{ id: 'wip', category: 'in_progress' }, { id: 'done', category: 'done' }];
    const app = await buildApp();
    // leaf-1 is status null / 0 % → no status-progress-mismatch finding → stale.
    const stale = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/lint/fix',
      payload: { ruleId: 'status-progress-mismatch', nodeId: 'leaf-1', action: 'mark-done' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('STALE_FINDING');
    expect(applyLintFix).not.toHaveBeenCalled();

    (mapData.nodes[1] as { status: string | null }).status = 'done'; // done at 0 % → finding offers reopen + mark-done
    const live = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/lint/fix',
      payload: { ruleId: 'status-progress-mismatch', nodeId: 'leaf-1', action: 'mark-done' },
    });
    (mapData.nodes[1] as { status: string | null }).status = null;
    await app.close();
    expect(live.statusCode).toBe(200);
    expect(applyLintFix).toHaveBeenCalledTimes(1);
  });

  it('403 without edit permission; service errors map to 404 / 409', async () => {
    permissionLevel = 'view';
    let app = await buildApp();
    const denied = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/lint/fix',
      payload: { ruleId: 'claim-churn', nodeId: 'leaf-1', action: 'park' },
    });
    await app.close();
    expect(denied.statusCode).toBe(403);

    permissionLevel = 'edit';
    app = await buildApp();
    applyLintFix.mockImplementationOnce(async () => {
      throw new LintFixError('NODE_NOT_FOUND', 'gone');
    });
    const gone = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/lint/fix',
      payload: { ruleId: 'claim-churn', nodeId: 'leaf-1', action: 'park' },
    });
    applyLintFix.mockImplementationOnce(async () => {
      throw new LintFixError('NO_FORGE', 'no repo');
    });
    const noForge = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/lint/fix',
      payload: { ruleId: 'issue-state-mismatch', nodeId: 'leaf-1', action: 'close-issue' },
    });
    await app.close();
    expect(gone.statusCode).toBe(404);
    expect(noForge.statusCode).toBe(409);
  });
});

describe('GET /api/maps/:id/lint — sync pack wiring', () => {
  const DONE_WORKFLOW = [
    { id: 'wip', category: 'in_progress' },
    { id: 'done', category: 'done' },
  ];
  const doneLinked = (id: string, issue: number, updatedAt: string, externalId = `dan/jiso#${issue}`) => ({
    id,
    parentId: 'root',
    childrenIds: [],
    text: `#${issue} ticket`,
    effortEstimate: 1,
    actualEffort: null,
    percentComplete: 100,
    status: 'done',
    priority: null,
    dueDate: null,
    startDate: null,
    description: null,
    requirementId: null,
    versionId: null,
    dependencies: [],
    blockedReason: null,
    tags: [],
    updatedAt,
    externalLinks: [
      {
        provider: 'gitea',
        externalId,
        url: `https://git.example/${externalId.replace('#', '/issues/')}`,
        syncEnabled: true,
        lastSyncedAt: null,
        state: 'closed',
      },
    ],
  });
  const ruleOf = (body: { rules: Array<{ ruleId: string }> }, id: string) =>
    body.rules.find((x) => x.ruleId === id) as unknown as {
      skipped?: string;
      title: string;
      findings: Array<{ nodeId: string; detail: string }>;
    };

  it('skips done-without-pr when the map has no forge', async () => {
    mapData.map.statusWorkflow = DONE_WORKFLOW;
    mapData.nodes.push(doneLinked('n7', 7, '2026-09-25T07:04:00Z') as never);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/maps/map-1/lint?scope=all' });
    await app.close();
    expect(ruleOf(res.json(), 'done-without-pr').skipped).toMatch(/forge/);
  });

  it('asks the forge only for done+linked nodes on the bound repo and flags the ones with no PR', async () => {
    mapData.map.statusWorkflow = DONE_WORKFLOW;
    mapData.nodes.push(
      doneLinked('n7', 7, '2026-09-25T07:04:00Z') as never,
      doneLinked('n2', 2, '2026-09-24T10:33:00Z') as never,
      doneLinked('other', 3, '2026-09-24T10:00:00Z', 'someone/else#3') as never,
    );
    const asked: number[] = [];
    forgeContext = {
      owner: 'dan',
      repo: 'jiso',
      token: 't',
      forge: {
        listCrossReferencingPullRequests: async (_o, _r, n) => {
          asked.push(n);
          return n === 2 ? [5] : [];
        },
      },
    };
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/maps/map-1/lint?scope=all' });
    await app.close();
    expect(asked.sort()).toEqual([2, 7]);
    const r = ruleOf(res.json(), 'done-without-pr');
    expect(r.skipped).toBeUndefined();
    expect(r.findings.map((f) => f.nodeId)).toEqual(['n7']);
    expect(r.title).not.toContain('most recent checked');
  });

  it('one failing lookup drops only that node; the others still answer', async () => {
    mapData.map.statusWorkflow = DONE_WORKFLOW;
    mapData.nodes.push(
      doneLinked('n7', 7, '2026-09-25T07:04:00Z') as never,
      doneLinked('n1', 1, '2026-09-25T02:36:00Z') as never,
    );
    forgeContext = {
      owner: 'dan',
      repo: 'jiso',
      token: 't',
      forge: {
        listCrossReferencingPullRequests: async (_o, _r, n) => {
          if (n === 1) throw new Error('timeline scan truncated');
          return [];
        },
      },
    };
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/maps/map-1/lint?scope=all' });
    await app.close();
    expect(res.statusCode).toBe(200);
    const r = ruleOf(res.json(), 'done-without-pr');
    expect(r.skipped).toBeUndefined();
    expect(r.findings.map((f) => f.nodeId)).toEqual(['n7']);
  });

  it('a node linked straight to a pull request counts that PR without asking the forge', async () => {
    mapData.map.statusWorkflow = DONE_WORKFLOW;
    const pr = doneLinked('npr', 42, '2026-09-25T07:04:00Z');
    (pr.externalLinks[0] as { isPullRequest?: boolean }).isPullRequest = true;
    mapData.nodes.push(pr as never);
    const asked: number[] = [];
    forgeContext = {
      owner: 'Dan',
      repo: 'JISO',
      token: 't',
      forge: { listCrossReferencingPullRequests: async (_o, _r, n) => (asked.push(n), []) },
    };
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/maps/map-1/lint?scope=all' });
    await app.close();
    expect(asked).toEqual([]);
    expect(ruleOf(res.json(), 'done-without-pr').findings).toEqual([]);
  });

  it('matches the bound repo case-insensitively and caches answers across runs', async () => {
    mapData.map.statusWorkflow = DONE_WORKFLOW;
    mapData.nodes.push(doneLinked('n7', 7, '2026-09-25T07:04:00Z') as never);
    let calls = 0;
    forgeContext = {
      owner: 'Dan',
      repo: 'JISO',
      token: 't',
      forge: { listCrossReferencingPullRequests: async () => (calls++, []) },
    };
    const app = await buildApp();
    const first = await app.inject({ method: 'GET', url: '/api/maps/map-1/lint?scope=all' });
    const second = await app.inject({ method: 'GET', url: '/api/maps/map-1/lint?scope=all' });
    await app.close();
    expect(calls).toBe(1);
    expect(ruleOf(first.json(), 'done-without-pr').findings.map((f) => f.nodeId)).toEqual(['n7']);
    expect(ruleOf(second.json(), 'done-without-pr').findings.map((f) => f.nodeId)).toEqual(['n7']);
  });

  it('does not touch the forge when a different single rule is requested, and honours the scope', async () => {
    mapData.map.statusWorkflow = DONE_WORKFLOW;
    mapData.nodes.push(doneLinked('n7', 7, '2026-09-25T07:04:00Z') as never);
    const asked: number[] = [];
    forgeContext = {
      owner: 'dan',
      repo: 'jiso',
      token: 't',
      forge: { listCrossReferencingPullRequests: async (_o, _r, n) => (asked.push(n), []) },
    };
    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/api/maps/map-1/lint?scope=all&rule=stale-plan' });
    expect(asked).toEqual([]);
    // Subtree scope on leaf-1 excludes n7 entirely → no lookup, no finding.
    const scopedRes = await app.inject({ method: 'GET', url: '/api/maps/map-1/lint?nodeId=leaf-1' });
    await app.close();
    expect(asked).toEqual([]);
    expect(ruleOf(scopedRes.json(), 'done-without-pr').findings).toEqual([]);
  });

  it('claim-churn counts node.claimed events from the history digest', async () => {
    const { listEvents } = await import('../../db/events.js');
    const mocked = listEvents as unknown as {
      mockImplementation: (fn: (o: { eventType?: string }) => Promise<unknown[]>) => void;
    };
    mocked.mockImplementation(async (o) =>
      o.eventType === 'node.claimed'
        ? Array.from({ length: 6 }, (_, i) => ({ nodeId: 'leaf-1', createdAt: `2026-09-26T0${i}:00:00Z` }))
        : [],
    );
    try {
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/api/maps/map-1/lint?scope=all' });
      await app.close();
      expect(ruleOf(res.json(), 'claim-churn').findings.map((f) => [f.nodeId, f.detail])).toEqual([
        ['leaf-1', '6 pickups in the last 24 h'],
      ]);
    } finally {
      mocked.mockImplementation(async () => []);
    }
  });
});
