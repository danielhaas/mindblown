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
  suggestedParentNodeId: string | null;
  decidedAt: Date;
  decidedBy: 'auto' | 'operator';
  reviewed: boolean;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  // #142 cost-opt: webhook hash-idempotency column. Reclassify routes
  // (single + bulk) MUST null this so the next real webhook delivery
  // doesn't short-circuit on a stale hash compare against the new
  // decision. Optional on the type because most tests don't care.
  lastInputHash?: string | null;
}

const triageRows = new Map<string, TriageRow>();
// #140 added `externalLinks` so the not-in-mindblown route's orphan
// branch can filter out issues already attached to a node. Tests that
// don't care about orphans seed `nodes` without setting externalLinks
// (the field stays undefined, which the route treats as no links).
const nodes = new Map<
  string,
  {
    id: string;
    mapId: string;
    parentId: string | null;
    externalLinks?: Array<{ provider: string; externalId: string }>;
  }
>();
// Phase 3 (#96) — history insert recorder for the GET .../history route
// test. Inserts from the mutation routes also land here so a test can
// assert "the override route wrote a history row" without spinning up
// the dedicated triage-history test infra.
interface HistoryRow {
  id: string;
  decisionId: string;
  changedAt: Date;
  changedBy: string;
  changeType: string;
  previousDecision: string | null;
  newDecision: string;
  previousConfidence: number | null;
  newConfidence: number | null;
  previousParentNodeId: string | null;
  newParentNodeId: string | null;
  reason: string | null;
}
const historyRows = new Map<string, HistoryRow>();
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
    suggestedParentNodeId: null,
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

function buildSelectChain(fields?: Record<string, unknown>) {
  const step: { table?: string; pred?: unknown; limit?: number; ordered?: boolean } = {};
  // Detect count-aggregate selects: `db.select({ count: sql<number>... })`.
  // The Phase 3 follow-up (#104 item 12) adds a true COUNT pass to the
  // list route, which the production code shapes as a `[{ count }]`
  // single-row result. We sniff for the `count` field by name and
  // return a count-shaped row.
  const isCountSelect =
    fields != null &&
    Object.keys(fields).length === 1 &&
    Object.prototype.hasOwnProperty.call(fields, 'count');
  const resolve = async (): Promise<Record<string, unknown>[]> => {
    let rows: Record<string, unknown>[] = [];
    if (step.table === 'triageDecisions') {
      rows = [...triageRows.values()].map((r) => ({ ...r }));
    } else if (step.table === 'nodes') {
      rows = [...nodes.values()].map((n) => ({ ...n }));
    } else if (step.table === 'triageDecisionHistory') {
      rows = [...historyRows.values()]
        .map((r) => ({ ...r }))
        .sort((a, b) =>
          (b.changedAt as Date).getTime() - (a.changedAt as Date).getTime(),
        );
    }
    const filtered = applyPred(rows, step.pred);
    if (isCountSelect) {
      // Count selects ignore the limit — they're a separate pass over
      // the same predicate, returning a single-row count.
      return [{ count: filtered.length }];
    }
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

// #141 race-fix harness: a hoisted holder so the test can install a gate
// that the mocked `db.transaction` will consult before invoking the
// callback. `gate` returns (or resolves to) void; resolving it lets the
// transaction body run. The race test uses this to hold the second tx
// outside its callback until the first tx has committed.
const txGateHolder = vi.hoisted(() => ({
  enter: undefined as ((n: number) => Promise<void> | void) | undefined,
  count: 0,
}));

vi.mock('../../db/connection.js', () => {
  const db = {
    select: (fields?: Record<string, unknown>) => buildSelectChain(fields),
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
    insert: (table: { __name?: string }) => ({
      values: (vals: Record<string, unknown>) => {
        let inserted: { id: string } | null = null;
        if (table?.__name === 'triageDecisionHistory') {
          const id = `h${historyRows.size + 1}`;
          historyRows.set(id, {
            id,
            decisionId: vals.decisionId as string,
            changedAt: new Date(Date.now() + historyRows.size), // stable ordering
            changedBy: vals.changedBy as string,
            changeType: vals.changeType as string,
            previousDecision: (vals.previousDecision as string | null) ?? null,
            newDecision: vals.newDecision as string,
            previousConfidence: (vals.previousConfidence as number | null) ?? null,
            newConfidence: (vals.newConfidence as number | null) ?? null,
            previousParentNodeId:
              (vals.previousParentNodeId as string | null) ?? null,
            newParentNodeId: (vals.newParentNodeId as string | null) ?? null,
            reason: (vals.reason as string | null) ?? null,
          });
          inserted = { id };
        } else if (table?.__name === 'triageDecisions') {
          // #140: orphan-import / orphan-skip INSERT into the triage
          // table. Build a minimal row that the GET-list route would
          // also surface; the synthetic id mirrors the seedRow pattern.
          const id = `auto-tr-${triageRows.size + 1}`;
          const row: TriageRow = {
            id,
            mapId: vals.mapId as string,
            externalId: vals.externalId as string,
            issueTitle: vals.issueTitle as string,
            issueState: vals.issueState as string,
            decision: (vals.decision as 'place' | 'skip' | 'uncertain'),
            reason: (vals.reason as string) ?? '',
            confidence: (vals.confidence as number) ?? 100,
            placedNodeId: (vals.placedNodeId as string | null) ?? null,
            suggestedParentNodeId:
              (vals.suggestedParentNodeId as string | null) ?? null,
            decidedAt: (vals.decidedAt as Date) ?? new Date(),
            decidedBy: (vals.decidedBy as 'auto' | 'operator') ?? 'operator',
            reviewed: (vals.reviewed as boolean) ?? false,
            reviewedAt: (vals.reviewedAt as Date | null) ?? null,
            reviewedBy: (vals.reviewedBy as string | null) ?? null,
          };
          triageRows.set(id, row);
          inserted = { id };
        }
        const thenable = {
          then: (onFulfilled: (v: unknown) => unknown) => Promise.resolve(undefined).then(onFulfilled),
          returning: async () => (inserted ? [inserted] : []),
        };
        return thenable;
      },
    }),
    // #141 race-fix: orphan-import / orphan-skip routes call
    // `tx.execute(sql\`SELECT pg_advisory_xact_lock(...)\`)` inside their
    // transactions. The mock has no real DB, so `execute` is a no-op.
    // The gate below lets a test simulate Postgres's advisory-lock
    // serialization: when armed, the Nth transaction waits on the
    // promise returned by `__txGate(N)` before its callback runs, so the
    // test can hold #2 outside the tx body until #1 has committed (i.e.
    // its insert is visible to the in-tx precheck).
    execute: async () => undefined,
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
      if (txGateHolder.enter) {
        const n = txGateHolder.count;
        txGateHolder.count = n + 1;
        await txGateHolder.enter(n);
      }
      return cb(db);
    },
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
      // #140: not-in-mindblown's orphan branch reads externalLinks to
      // filter out issues already attached to a node. The mock node
      // store carries the column verbatim — predicates that match by
      // mapId still work; the route only reads the field, doesn't
      // filter on it.
      externalLinks: col('externalLinks'),
    },
    triageDecisions: {
      __name: 'triageDecisions',
      id: col('id'),
      mapId: col('mapId'),
      externalId: col('externalId'),
      decision: col('decision'),
      reviewed: col('reviewed'),
      decidedAt: col('decidedAt'),
      confidence: col('confidence'),
      issueState: col('issueState'),
      suggestedParentNodeId: col('suggestedParentNodeId'),
      // #142 — reclassify route writes lastInputHash:null to force the
      // next webhook re-evaluation; column must exist on the schema mock.
      lastInputHash: col('lastInputHash'),
    },
    // Phase 3 (#96) — recordTriageHistory inserts into this table from
    // every mutation route. The route tests don't assert on the history
    // rows (covered separately in triage-history.test.ts), but the symbol
    // must exist on the mock or drizzle throws on import resolution.
    triageDecisionHistory: {
      __name: 'triageDecisionHistory',
      id: col('id'),
      decisionId: col('decisionId'),
      changedAt: col('changedAt'),
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
    gte: (column: { __col?: string }, value: unknown): Predicate => ({
      __pred: true,
      check: (row) => {
        const v = row[column.__col ?? ''];
        if (v instanceof Date && value instanceof Date) return v.getTime() >= value.getTime();
        return (v as number) >= (value as number);
      },
    }),
    lte: (column: { __col?: string }, value: unknown): Predicate => ({
      __pred: true,
      check: (row) => {
        const v = row[column.__col ?? ''];
        if (v instanceof Date && value instanceof Date) return v.getTime() <= value.getTime();
        return (v as number) <= (value as number);
      },
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
  // Soft-delete filter — shaped as the Pred this file's drizzle-orm mock
  // expects. Always matches: test dbState rows don't carry deletedAt.
  notDeleted: { __pred: true, check: () => true },
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

// Phase 3 follow-up (#104 item 11): mock applyTriageLabel so a route
// test can assert when label writes happen (and whether bulk routes
// fire them in parallel after the DB loop, not serially inside it).
const applyTriageLabelMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../sync/triageLabelWriteback.js', () => ({
  applyTriageLabel: applyTriageLabelMock,
}));

// #143 round-2 (Ray's review): reclassify routes (single + bulk) must
// clear the debounce so a webhook within the 60s window isn't squashed
// after operator action. Hoisted as a named mock so tests can assert
// `(mapId, externalId)` was passed.
const clearTriageDebounceMock = vi.hoisted(() => vi.fn());
vi.mock('../../sync/triage.js', () => ({
  triageIssue: mocks.triageIssueMock,
  clearTriageDebounce: clearTriageDebounceMock,
  computeInputHash: vi.fn(() => 'mock-hash'),
  markTriageDebounce: vi.fn(),
  isWithinDebounceWindow: vi.fn(() => false),
}));

vi.mock('../../sync/mapContext.js', () => ({
  buildMapContext: vi.fn(async (mapId: string) => ({
    mapId,
    mapName: 'm',
    mapDescription: '',
    epics: [{ nodeId: 'epic-1', title: 'Frontend', description: 'UI' }],
  })),
}));

// ── #140 mocks: GitHub context + issue importer for the
//    /not-in-mindblown route's orphan-bucket branch.
//
// `getGitHubContextForMap` is read once when the orphan branch runs;
// returning `null` simulates a map with no GitHub integration, which the
// route handles by setting `orphansAvailable: false` and skipping the
// fetch. Tests that exercise the orphan branch flip the mock to return
// a real context first.
//
// `importGitHubIssues` is the workhorse — each test seeds the issue
// array it wants visible to the orphan bucket. The shape mirrors the
// real ImportedIssue: `{ issue, externalLink }`.
const githubContextMock = vi.hoisted(() =>
  vi.fn(async (_mapId: string) => null as
    | { owner: string; repo: string; token: string }
    | null),
);
vi.mock('../../lib/githubContext.js', () => ({
  getGitHubContextForMap: githubContextMock,
}));

interface FakeImportedIssue {
  issue: {
    number: number;
    title: string;
    state: 'open' | 'closed';
    html_url: string;
  };
  externalLink: { externalId: string };
}
const importGitHubIssuesMock = vi.hoisted(() =>
  vi.fn(async (
    _owner: string,
    _repo: string,
    _token: string,
    _opts?: { includeAll?: boolean },
  ): Promise<FakeImportedIssue[]> => []),
);
vi.mock('@mindblown/integrations', () => ({
  importGitHubIssues: importGitHubIssuesMock,
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
  historyRows.clear();
  permissionLevel = 'edit';
  createNodeMock.mockClear();
  updateNodeMock.mockClear();
  moveNodeMock.mockClear();
  triageIssueMock.mockClear();
  // #143 round-2: clear so a per-test assertion on (mapId, externalId)
  // doesn't bleed across cases.
  clearTriageDebounceMock.mockClear();
  applyTriageLabelMock.mockReset();
  applyTriageLabelMock.mockImplementation(async () => undefined);
  // #140 — reset the GitHub-context + import mocks so each test
  // explicitly opts into the orphan-bucket branch by re-arming them.
  githubContextMock.mockReset();
  githubContextMock.mockImplementation(async () => null);
  importGitHubIssuesMock.mockReset();
  importGitHubIssuesMock.mockImplementation(async () => []);
  // #141 race-fix harness: clear any gate left armed by a previous test.
  txGateHolder.enter = undefined;
  txGateHolder.count = 0;
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

  // ── suggested_parent_node_id surfacing ──────────────────────
  // The column is populated by every LLM-driven write (auto-ingest +
  // reclassify), distinct from placedNodeId which only flips on
  // actual node creation. The GET list response must surface it so
  // the Override modal can pre-select the suggestion.
  it('returns suggestedParentNodeId on each row', async () => {
    seedRow({
      id: 'tr-1',
      decision: 'place',
      confidence: 60, // low-confidence — no auto-apply, placedNodeId null
      placedNodeId: null,
      suggestedParentNodeId: 'epic-suggested',
    });
    seedRow({
      id: 'tr-2',
      decision: 'skip',
      suggestedParentNodeId: null,
    });
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const decisions = res.json().decisions as Array<{
      id: string;
      suggestedParentNodeId: string | null;
    }>;
    const byId = Object.fromEntries(decisions.map((d) => [d.id, d.suggestedParentNodeId]));
    expect(byId['tr-1']).toBe('epic-suggested');
    expect(byId['tr-2']).toBeNull();
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
    // Phase 3 follow-up (#104 item 12): `total` is the true match count,
    // `returned` reflects the page size after the limit clip.
    expect(res.json().total).toBe(10);
    expect(res.json().returned).toBe(3);
    expect(res.json().decisions).toHaveLength(3);
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

  // #100 Round 2 — defense-in-depth at the override route. The
  // dedicated /confirm route is the primary fix; this assertion
  // guarantees the override route ALSO rejects the malformed input so
  // a future caller (curl, MCP, alt UI) can't re-trigger the self-loop
  // by sending parentNodeId === placedNodeId.
  it('place + parentNodeId === placedNodeId → 400 SELF_LOOP_BLOCKED, moveNode NOT called', async () => {
    seedRow({
      id: 'tr-1',
      decision: 'place',
      placedNodeId: 'placed-node',
    });
    nodes.set('placed-node', { id: 'placed-node', mapId: 'map-1', parentId: 'epic-A' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/override',
      payload: { decision: 'place', parentNodeId: 'placed-node' },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('SELF_LOOP_BLOCKED');
    expect(moveNodeMock).not.toHaveBeenCalled();
    expect(createNodeMock).not.toHaveBeenCalled();
    // Row was NOT marked reviewed by the rejected request.
    const row = triageRows.get('tr-1')!;
    expect(row.reviewed).toBe(false);
    expect(row.decidedBy).toBe('auto');
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

  // suggested_parent_node_id semantic: the column always reflects the
  // latest LLM suggestion, NEVER the operator's pick. So an override
  // that lands a place under parentNodeId=X leaves the original LLM
  // suggestion untouched — that way the audit history shows "Claude
  // suggested Y, operator chose X." Without this guard, the override
  // route would silently rewrite the suggestion to whatever the
  // operator clicked, erasing the audit signal.
  it('place override does NOT overwrite suggestedParentNodeId (operator pick ≠ LLM suggestion)', async () => {
    seedRow({
      id: 'tr-1',
      decision: 'place',
      confidence: 60,
      placedNodeId: null,
      // LLM suggested epic-X with low confidence.
      suggestedParentNodeId: 'epic-X',
    });
    nodes.set('epic-Y', { id: 'epic-Y', mapId: 'map-1', parentId: 'root-1' });
    permissionLevel = 'edit';

    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/override',
      // Operator picks epic-Y — different from the LLM's epic-X.
      payload: {
        decision: 'place',
        parentNodeId: 'epic-Y',
        reason: 'better fit',
      },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const row = triageRows.get('tr-1')!;
    // placedNodeId stamped to the newly-created node (operator pick).
    expect(row.placedNodeId).toBe('created-node');
    // But the LLM suggestion column is INTACT — the audit history can
    // still surface "Claude suggested epic-X, operator chose epic-Y."
    expect(row.suggestedParentNodeId).toBe('epic-X');
  });

  // Mirror the same invariant for the skip/uncertain override branch —
  // a place row that the operator skips must keep the suggestion intact
  // (it's still the most recent LLM call's output).
  it('skip override does NOT overwrite suggestedParentNodeId', async () => {
    seedRow({
      id: 'tr-1',
      decision: 'place',
      confidence: 60,
      suggestedParentNodeId: 'epic-X',
    });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/override',
      payload: { decision: 'skip', reason: 'not for us' },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const row = triageRows.get('tr-1')!;
    expect(row.decision).toBe('skip');
    expect(row.suggestedParentNodeId).toBe('epic-X');
  });
});

// ── POST /confirm ────────────────────────────────────────────────

// #100 Round 2 — dedicated confirm route. The original frontend wired
// Confirm through /override with parentNodeId=placedNodeId, which fell
// through the already-placed branch and self-loop'd the node. The
// dedicated route accepts no body parameters and never touches
// parentage.
describe('POST .../confirm', () => {
  it('marks reviewed=true, decidedBy=operator without touching placedNodeId or parentage', async () => {
    seedRow({
      id: 'tr-1',
      decision: 'place',
      placedNodeId: 'placed-node',
      reviewed: false,
      decidedBy: 'auto',
      confidence: 88,
      reason: 'matches Frontend',
    });
    nodes.set('placed-node', { id: 'placed-node', mapId: 'map-1', parentId: 'epic-A' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/confirm',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('confirmed');
    expect(res.json().nodeId).toBe('placed-node');
    // moveNode + createNode were NEVER reachable — confirm doesn't even
    // look at node tables. The self-loop bug is structurally impossible.
    expect(moveNodeMock).not.toHaveBeenCalled();
    expect(createNodeMock).not.toHaveBeenCalled();
    const row = triageRows.get('tr-1')!;
    expect(row.reviewed).toBe(true);
    expect(row.decidedBy).toBe('operator');
    // Decision/reason/confidence untouched (confirm = "accept as-is").
    expect(row.decision).toBe('place');
    expect(row.reason).toBe('matches Frontend');
    expect(row.confidence).toBe(88);
    // placedNodeId is intact — confirm never nulls it.
    expect(row.placedNodeId).toBe('placed-node');
    // The placed node's parent is intact at the dbState level too — no
    // self-loop write happened. (We can't observe the node from the
    // mock's update path because the confirm route never calls
    // nodes.update; this assertion documents intent.)
    expect(nodes.get('placed-node')!.parentId).toBe('epic-A');
  });

  it('works on a skip row too — confirm just marks reviewed, no parentNodeId required', async () => {
    seedRow({
      id: 'tr-1',
      decision: 'skip',
      placedNodeId: null,
      reviewed: false,
      decidedBy: 'auto',
    });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/confirm',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().nodeId).toBeNull();
    const row = triageRows.get('tr-1')!;
    expect(row.reviewed).toBe(true);
    expect(row.decidedBy).toBe('operator');
    expect(row.decision).toBe('skip');
  });

  it('404 when the row does not exist', async () => {
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/missing/confirm',
    });
    await app.close();
    expect(res.statusCode).toBe(404);
  });

  it('403 for API-key auth', async () => {
    permissionLevel = 'edit';
    seedRow({ id: 'tr-1' });
    const app = await buildApp('api-key');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/confirm',
    });
    await app.close();
    expect(res.statusCode).toBe(403);
  });

  it('403 for JWT with view-only', async () => {
    permissionLevel = 'view';
    seedRow({ id: 'tr-1' });
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/confirm',
    });
    await app.close();
    expect(res.statusCode).toBe(403);
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

  // Counterpart to the override-doesn't-touch-suggestion tests above.
  // Reclassify is the LLM speaking; the suggested-parent column MUST
  // refresh on every reclassify so a stale suggestion can't linger
  // past a re-run.
  it('reclassify → place refreshes suggestedParentNodeId from LLM output', async () => {
    seedRow({
      id: 'tr-1',
      decision: 'place',
      confidence: 50,
      // Stale suggestion from an earlier LLM call.
      suggestedParentNodeId: 'epic-stale',
    });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/reclassify',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    // Default triageIssueMock returns parentNodeId='epic-1' on place.
    expect(res.json().suggestedParentNodeId).toBe('epic-1');
    const row = triageRows.get('tr-1')!;
    expect(row.suggestedParentNodeId).toBe('epic-1');
  });

  // #143 round-2 (Ray's review): single-row reclassify MUST clear
  // lastInputHash (so the next webhook delivery re-evaluates against
  // fresh content) AND clear the per-issue debounce (so a webhook
  // within the 60s window isn't squashed after the operator action).
  // The same invariant must hold on the bulk-reclassify route — see the
  // matching test in the bulk-reclassify describe block.
  it('reclassify clears lastInputHash and calls clearTriageDebounce(mapId, externalId)', async () => {
    seedRow({
      id: 'tr-1',
      externalId: 'o/r#42',
      decision: 'uncertain',
      confidence: 30,
      lastInputHash: 'some-old-hash',
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
    expect(row.lastInputHash).toBeNull();
    expect(clearTriageDebounceMock).toHaveBeenCalledWith('map-1', 'o/r#42');
  });

  it('reclassify → skip nulls suggestedParentNodeId', async () => {
    triageIssueMock.mockResolvedValueOnce({
      decision: 'skip' as const,
      parentNodeId: undefined,
      reason: 'no longer relevant',
      confidence: 92,
    } as unknown as Awaited<ReturnType<typeof triageIssueMock>>);
    seedRow({
      id: 'tr-1',
      decision: 'place',
      confidence: 50,
      suggestedParentNodeId: 'epic-was-suggested',
    });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/reclassify',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().suggestedParentNodeId).toBeNull();
    const row = triageRows.get('tr-1')!;
    expect(row.suggestedParentNodeId).toBeNull();
  });
});

// ── GET filters — Phase 2 (#95) ──────────────────────────────────

describe('GET /api/maps/:mapId/triage-decisions — Phase 2 filters', () => {
  it('filters by minConfidence (inclusive)', async () => {
    seedRow({ id: 't1', confidence: 30 });
    seedRow({ id: 't2', confidence: 70 });
    seedRow({ id: 't3', confidence: 95 });
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions?minConfidence=70',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(2);
    const ids = (res.json().decisions as Array<{ id: string }>).map((d) => d.id).sort();
    expect(ids).toEqual(['t2', 't3']);
  });

  it('filters by maxConfidence (inclusive)', async () => {
    seedRow({ id: 't1', confidence: 30 });
    seedRow({ id: 't2', confidence: 70 });
    seedRow({ id: 't3', confidence: 95 });
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions?maxConfidence=70',
    });
    await app.close();
    expect(res.json().total).toBe(2);
  });

  it('combines minConfidence + maxConfidence to bracket a range', async () => {
    seedRow({ id: 't1', confidence: 30 });
    seedRow({ id: 't2', confidence: 50 });
    seedRow({ id: 't3', confidence: 80 });
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions?minConfidence=40&maxConfidence=70',
    });
    await app.close();
    expect(res.json().total).toBe(1);
    expect((res.json().decisions as Array<{ id: string }>)[0].id).toBe('t2');
  });

  it('filters by issueState=open', async () => {
    seedRow({ id: 't1', issueState: 'open' });
    seedRow({ id: 't2', issueState: 'closed' });
    seedRow({ id: 't3', issueState: 'open' });
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions?issueState=open',
    });
    await app.close();
    expect(res.json().total).toBe(2);
  });

  it('filters by since (decidedAt >= ISO)', async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    seedRow({ id: 't-old', decidedAt: lastWeek });
    seedRow({ id: 't-recent', decidedAt: yesterday });
    seedRow({ id: 't-now', decidedAt: now });
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const since = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const res = await app.inject({
      method: 'GET',
      url: `/api/maps/map-1/triage-decisions?since=${encodeURIComponent(since)}`,
    });
    await app.close();
    expect(res.json().total).toBe(2);
  });

  it('malformed minConfidence is silently ignored (no filter applied)', async () => {
    seedRow({ id: 't1', confidence: 30 });
    seedRow({ id: 't2', confidence: 70 });
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions?minConfidence=banana',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(2);
  });

  // Phase 3 follow-up (#102 item 3): the `since` filter parses via
  // `Date.parse`, which yields NaN for non-ISO strings. The route is
  // documented to silently ignore malformed filter inputs (same posture
  // as `minConfidence=banana` above) so a URL typo doesn't blank the
  // panel. This test pins that contract — a 200 with all rows, not a
  // 400.
  it('malformed since is silently ignored (returns 200 with all rows, not 400)', async () => {
    seedRow({ id: 't1' });
    seedRow({ id: 't2' });
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions?since=not-a-date',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(2);
  });
});

// ── Bulk routes — Phase 2 (#95) ──────────────────────────────────

describe('POST .../bulk-confirm', () => {
  it('marks every supplied row reviewed=true, returns per-item ok', async () => {
    seedRow({ id: 'a', reviewed: false, decidedBy: 'auto' });
    seedRow({ id: 'b', reviewed: false, decidedBy: 'auto' });
    seedRow({ id: 'c', reviewed: false, decidedBy: 'auto' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-confirm',
      payload: { decisionIds: ['a', 'b', 'c'] },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(3);
    expect(body.results.every((r: { status?: string }) => r.status === 'confirmed')).toBe(true);
    for (const id of ['a', 'b', 'c']) {
      const row = triageRows.get(id)!;
      expect(row.reviewed).toBe(true);
      expect(row.decidedBy).toBe('operator');
    }
  });

  it('1 valid + 1 missing id → response is array with one ok + one error (HTTP 200)', async () => {
    seedRow({ id: 'a', reviewed: false, decidedBy: 'auto' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-confirm',
      payload: { decisionIds: ['a', 'ghost'] },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const results = res.json().results as Array<{ id: string; status?: string; error?: { code: string } }>;
    expect(results).toHaveLength(2);
    const ok = results.find((r) => r.id === 'a')!;
    const err = results.find((r) => r.id === 'ghost')!;
    expect(ok.status).toBe('confirmed');
    expect(err.error?.code).toBe('NOT_FOUND');
    // The valid row was still committed — per-item idempotency.
    expect(triageRows.get('a')!.reviewed).toBe(true);
  });

  it('dedupes repeated ids (UI double-tap)', async () => {
    seedRow({ id: 'a', reviewed: false, decidedBy: 'auto' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-confirm',
      payload: { decisionIds: ['a', 'a', 'a'] },
    });
    await app.close();
    expect(res.json().results).toHaveLength(1);
  });

  it('400 on empty decisionIds', async () => {
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-confirm',
      payload: { decisionIds: [] },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('VALIDATION_ERROR');
  });

  it('400 on missing decisionIds', async () => {
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-confirm',
      payload: {},
    });
    await app.close();
    expect(res.statusCode).toBe(400);
  });

  // PR #151 split the bulk caps: confirm/override are capped at 500
  // (drift-audit reviews come in ~300-row batches), reclassify stays at
  // 20 (each item runs the LLM). 501 is the first over-limit batch.
  it('400 when batch exceeds 500', async () => {
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const ids = Array.from({ length: 501 }, (_, i) => `t${i}`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-confirm',
      payload: { decisionIds: ids },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.message).toContain('500');
  });

  it('accepts the boundary batch of exactly 500 ids', async () => {
    for (let i = 0; i < 500; i++) seedRow({ id: `t${i}`, reviewed: false, decidedBy: 'auto' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const ids = Array.from({ length: 500 }, (_, i) => `t${i}`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-confirm',
      payload: { decisionIds: ids },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(500);
  });

  it('403 for API-key auth', async () => {
    permissionLevel = 'edit';
    seedRow({ id: 'a' });
    const app = await buildApp('api-key');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-confirm',
      payload: { decisionIds: ['a'] },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
  });

  it('403 for JWT with view-only', async () => {
    permissionLevel = 'view';
    seedRow({ id: 'a' });
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-confirm',
      payload: { decisionIds: ['a'] },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
  });
});

describe('POST .../bulk-override', () => {
  it('mixed `place` + `skip` rows → places are moved, skips are 400-per-item', async () => {
    seedRow({ id: 'p1', decision: 'place', placedNodeId: 'placed-1' });
    seedRow({ id: 's1', decision: 'skip' });
    nodes.set('placed-1', { id: 'placed-1', mapId: 'map-1', parentId: 'epic-A' });
    nodes.set('epic-B', { id: 'epic-B', mapId: 'map-1', parentId: 'root-1' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-override',
      payload: { decisionIds: ['p1', 's1'], parentNodeId: 'epic-B' },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const results = res.json().results as Array<{ id: string; status?: string; error?: { code: string } }>;
    const place = results.find((r) => r.id === 'p1')!;
    const skip = results.find((r) => r.id === 's1')!;
    expect(place.status).toBe('moved');
    expect(skip.error?.code).toBe('BULK_NOT_PLACE');
    // The place row was reparented; the skip row was untouched.
    expect(moveNodeMock).toHaveBeenCalledOnce();
    expect(triageRows.get('p1')!.reviewed).toBe(true);
    expect(triageRows.get('s1')!.reviewed).toBe(false);
  });

  it('SELF_LOOP_BLOCKED: parentNodeId === placedNodeId rejects per-item, moveNode not called', async () => {
    seedRow({ id: 'p1', decision: 'place', placedNodeId: 'loop-target' });
    nodes.set('loop-target', { id: 'loop-target', mapId: 'map-1', parentId: 'epic-A' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-override',
      payload: { decisionIds: ['p1'], parentNodeId: 'loop-target' },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const results = res.json().results as Array<{ id: string; error?: { code: string } }>;
    expect(results[0].error?.code).toBe('SELF_LOOP_BLOCKED');
    expect(moveNodeMock).not.toHaveBeenCalled();
    expect(triageRows.get('p1')!.reviewed).toBe(false);
  });

  it('all rows already-placed under different parents → moves each + broadcasts per move', async () => {
    seedRow({ id: 'p1', decision: 'place', placedNodeId: 'node-1' });
    seedRow({ id: 'p2', decision: 'place', placedNodeId: 'node-2' });
    nodes.set('node-1', { id: 'node-1', mapId: 'map-1', parentId: 'epic-A' });
    nodes.set('node-2', { id: 'node-2', mapId: 'map-1', parentId: 'epic-A' });
    nodes.set('epic-B', { id: 'epic-B', mapId: 'map-1', parentId: 'root-1' });
    permissionLevel = 'edit';
    const wsMod = await import('../../ws.js');
    const broadcastMock = wsMod.broadcast as unknown as ReturnType<typeof vi.fn>;
    broadcastMock.mockClear();
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-override',
      payload: { decisionIds: ['p1', 'p2'], parentNodeId: 'epic-B' },
    });
    await app.close();
    const results = res.json().results as Array<{ id: string; status?: string }>;
    expect(results.every((r) => r.status === 'moved')).toBe(true);
    expect(moveNodeMock).toHaveBeenCalledTimes(2);
    // 2 node:moved broadcasts.
    const movedCalls = broadcastMock.mock.calls.filter(
      (call) => (call[1] as { type?: string }).type === 'node:moved',
    );
    expect(movedCalls).toHaveLength(2);
  });

  it('place rows with no placedNodeId → creates new nodes under parent', async () => {
    seedRow({ id: 'p1', decision: 'place', placedNodeId: null, externalId: 'o/r#1', issueTitle: 'A' });
    seedRow({ id: 'p2', decision: 'place', placedNodeId: null, externalId: 'o/r#2', issueTitle: 'B' });
    nodes.set('epic-B', { id: 'epic-B', mapId: 'map-1', parentId: 'root-1' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-override',
      payload: { decisionIds: ['p1', 'p2'], parentNodeId: 'epic-B' },
    });
    await app.close();
    const results = res.json().results as Array<{ id: string; status?: string; nodeId?: string }>;
    expect(results.every((r) => r.status === 'placed')).toBe(true);
    expect(results.every((r) => r.nodeId === 'created-node')).toBe(true);
    expect(createNodeMock).toHaveBeenCalledTimes(2);
  });

  it('400 when parentNodeId is not in this map', async () => {
    seedRow({ id: 'p1', decision: 'place' });
    nodes.set('outside', { id: 'outside', mapId: 'other-map', parentId: null });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-override',
      payload: { decisionIds: ['p1'], parentNodeId: 'outside' },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
  });

  it('400 when parentNodeId is missing', async () => {
    seedRow({ id: 'p1', decision: 'place' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-override',
      payload: { decisionIds: ['p1'] },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
  });

  it('403 for API-key auth', async () => {
    permissionLevel = 'edit';
    seedRow({ id: 'p1', decision: 'place' });
    nodes.set('epic-B', { id: 'epic-B', mapId: 'map-1', parentId: 'root-1' });
    const app = await buildApp('api-key');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-override',
      payload: { decisionIds: ['p1'], parentNodeId: 'epic-B' },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
  });

  // Phase 3 follow-up (#102 item 5): bulk-override per-item status enum
  // distinguishes 'moved' (node existed, parent differed, move ran) from
  // 'already_correct' (no-op move — parent already matches) from
  // 'orphaned' (placedNodeId set but the node row is gone). The earlier
  // 'already_placed' bucket conflated the last two.
  it("status='already_correct' when the placed node already lives under the target parent", async () => {
    seedRow({ id: 'p1', decision: 'place', placedNodeId: 'already-there' });
    // Node lives under epic-B already; the operator picks epic-B again.
    nodes.set('already-there', { id: 'already-there', mapId: 'map-1', parentId: 'epic-B' });
    nodes.set('epic-B', { id: 'epic-B', mapId: 'map-1', parentId: 'root-1' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-override',
      payload: { decisionIds: ['p1'], parentNodeId: 'epic-B' },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const results = res.json().results as Array<{ id: string; status?: string }>;
    expect(results[0].status).toBe('already_correct');
    expect(moveNodeMock).not.toHaveBeenCalled();
    // Row still gets stamped reviewed=true — the operator confirmed.
    expect(triageRows.get('p1')!.reviewed).toBe(true);
    expect(triageRows.get('p1')!.decidedBy).toBe('operator');
  });

  it("status='orphaned' when the placed node has been deleted (no node row)", async () => {
    seedRow({ id: 'p1', decision: 'place', placedNodeId: 'ghost-node' });
    // No `nodes` entry for ghost-node — the node was deleted between
    // auto-apply and this bulk action.
    nodes.set('epic-B', { id: 'epic-B', mapId: 'map-1', parentId: 'root-1' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-override',
      payload: { decisionIds: ['p1'], parentNodeId: 'epic-B' },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const results = res.json().results as Array<{ id: string; status?: string }>;
    expect(results[0].status).toBe('orphaned');
    expect(moveNodeMock).not.toHaveBeenCalled();
    // Row still updated to reviewed+operator; the operator's intent was
    // recorded even though the move was a no-op.
    expect(triageRows.get('p1')!.reviewed).toBe(true);
  });
});

describe('POST .../bulk-reclassify', () => {
  it('runs triageIssue per row and updates each in place', async () => {
    seedRow({ id: 'a', decision: 'uncertain', confidence: 20, reviewed: true, decidedBy: 'operator' });
    seedRow({ id: 'b', decision: 'uncertain', confidence: 30, reviewed: true, decidedBy: 'operator' });
    seedRow({ id: 'c', decision: 'uncertain', confidence: 40, reviewed: true, decidedBy: 'operator' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-reclassify',
      payload: { decisionIds: ['a', 'b', 'c'] },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(triageIssueMock).toHaveBeenCalledTimes(3);
    const results = res.json().results as Array<{ id: string; status?: string; decision?: string }>;
    expect(results.every((r) => r.status === 'reclassified')).toBe(true);
    for (const id of ['a', 'b', 'c']) {
      const row = triageRows.get(id)!;
      // Default mock returns place + confidence 88.
      expect(row.decision).toBe('place');
      expect(row.confidence).toBe(88);
      expect(row.decidedBy).toBe('auto');
      expect(row.reviewed).toBe(false);
    }
  });

  it('1 missing id → per-item NOT_FOUND, other rows still reclassified', async () => {
    seedRow({ id: 'a' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-reclassify',
      payload: { decisionIds: ['a', 'ghost'] },
    });
    await app.close();
    const results = res.json().results as Array<{ id: string; status?: string; error?: { code: string } }>;
    expect(results.find((r) => r.id === 'a')?.status).toBe('reclassified');
    expect(results.find((r) => r.id === 'ghost')?.error?.code).toBe('NOT_FOUND');
    expect(triageIssueMock).toHaveBeenCalledTimes(1);
  });

  it('non-place result clears placedNodeId on a previously-placed row', async () => {
    triageIssueMock.mockResolvedValueOnce({
      decision: 'skip' as const,
      parentNodeId: undefined,
      reason: 'no longer relevant',
      confidence: 92,
    } as unknown as Awaited<ReturnType<typeof triageIssueMock>>);
    seedRow({ id: 'a', decision: 'place', placedNodeId: 'orphan' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-reclassify',
      payload: { decisionIds: ['a'] },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(triageRows.get('a')!.placedNodeId).toBeNull();
  });

  it('403 for API-key auth', async () => {
    permissionLevel = 'edit';
    seedRow({ id: 'a' });
    const app = await buildApp('api-key');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-reclassify',
      payload: { decisionIds: ['a'] },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
  });

  // Phase 3 follow-up (#102 item 2): per-row LLM failure inside a bulk
  // batch must NOT fail the whole batch — the route's per-item
  // try/catch surfaces the failure as `{ error }` for row N while row
  // N+1 still reclassifies. The single-route equivalent was already
  // covered by the syncTriageRowsForReopen test; this is the bulk
  // route-level analogue.
  it('LLM throws on row 1 → row 1 has error, row 2 has status=ok', async () => {
    seedRow({ id: 'a', decision: 'uncertain' });
    seedRow({ id: 'b', decision: 'uncertain' });
    triageIssueMock.mockRejectedValueOnce(new Error('LLM down'));
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-reclassify',
      payload: { decisionIds: ['a', 'b'] },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const results = res.json().results as Array<{ id: string; status?: string; error?: { code: string; message: string } }>;
    const rowA = results.find((r) => r.id === 'a')!;
    const rowB = results.find((r) => r.id === 'b')!;
    expect(rowA.error?.code).toBe('INTERNAL_ERROR');
    expect(rowA.error?.message).toContain('LLM down');
    expect(rowB.status).toBe('reclassified');
    // Row A is untouched (the LLM threw before the DB write).
    expect(triageRows.get('a')!.decision).toBe('uncertain');
    // Row B has the default-mock result.
    expect(triageRows.get('b')!.decision).toBe('place');
  });

  // #143 round-2 (Ray's review): bulk-reclassify must mirror the
  // single-row /reclassify route's hash + debounce clearing. Without
  // this, after a bulk re-run the rows keep their OLD lastInputHash and
  // the next real `issues.edited` webhook short-circuits on a stale
  // hash compare — leaving the row with the new decision but masking
  // that subsequent edits aren't being re-evaluated.
  it('bulk-reclassify clears lastInputHash + calls clearTriageDebounce per row', async () => {
    seedRow({
      id: 'a',
      externalId: 'o/r#100',
      decision: 'uncertain',
      lastInputHash: 'stale-hash-a',
    });
    seedRow({
      id: 'b',
      externalId: 'o/r#200',
      decision: 'uncertain',
      lastInputHash: 'stale-hash-b',
    });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-reclassify',
      payload: { decisionIds: ['a', 'b'] },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    // Both rows had their hash nulled.
    expect(triageRows.get('a')!.lastInputHash).toBeNull();
    expect(triageRows.get('b')!.lastInputHash).toBeNull();
    // Debounce cleared once per row, with the correct (mapId, externalId).
    expect(clearTriageDebounceMock).toHaveBeenCalledTimes(2);
    expect(clearTriageDebounceMock).toHaveBeenCalledWith('map-1', 'o/r#100');
    expect(clearTriageDebounceMock).toHaveBeenCalledWith('map-1', 'o/r#200');
  });
});

// ── Phase 3 follow-up #104 item 11: parallel label writes ───────

describe('bulk routes — label writes fire in parallel after the DB loop', () => {
  // The contract: per-row label-write calls are not awaited inside the
  // per-row loop; instead they're collected and Promise.allSettled'd
  // after. We pin this by making each applyTriageLabel call hang on a
  // controlled promise, then verifying that all N calls happen before
  // any resolves — i.e. they're all in flight simultaneously, not
  // sequential.
  async function pinParallel(routePath: string, payload: Record<string, unknown>, seed: () => void): Promise<void> {
    seed();
    permissionLevel = 'edit';
    let activeCalls = 0;
    let peakActive = 0;
    const resolvers: Array<() => void> = [];
    applyTriageLabelMock.mockImplementation(async () => {
      activeCalls++;
      peakActive = Math.max(peakActive, activeCalls);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      activeCalls--;
    });
    const app = await buildApp('jwt');
    const inFlight = app.inject({
      method: 'POST',
      url: routePath,
      payload,
    });
    // Wait until both label writes are pinned in flight. A fixed number
    // of event-loop yields is racy (the DB loop crosses macrotask
    // boundaries); polling is deterministic for both code paths — the
    // sequential path hangs on the first unresolved write, never reaches
    // 2 resolvers, and times out here.
    const deadline = Date.now() + 2000;
    while (resolvers.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1));
    }
    // All label writes should be in flight simultaneously. The
    // peakActive is at least 2 — the sequential code path peaked at 1.
    expect(peakActive).toBeGreaterThanOrEqual(2);
    // Release them all so the route can finish.
    for (const r of resolvers) r();
    const res = await inFlight;
    await app.close();
    expect(res.statusCode).toBe(200);
  }

  it('bulk-confirm: 2 rows → peakActive ≥ 2 (parallel, not sequential)', async () => {
    await pinParallel(
      '/api/maps/map-1/triage-decisions/bulk-confirm',
      { decisionIds: ['a', 'b'] },
      () => {
        seedRow({ id: 'a', reviewed: false, decidedBy: 'auto' });
        seedRow({ id: 'b', reviewed: false, decidedBy: 'auto' });
      },
    );
  });

  it('bulk-reclassify: 2 rows → peakActive ≥ 2', async () => {
    await pinParallel(
      '/api/maps/map-1/triage-decisions/bulk-reclassify',
      { decisionIds: ['a', 'b'] },
      () => {
        seedRow({ id: 'a', decision: 'uncertain' });
        seedRow({ id: 'b', decision: 'uncertain' });
      },
    );
  });
});

// ── WS triage:updated broadcast (Phase 3 follow-up #102 item 7) ──

describe('triage:updated WS broadcast', () => {
  it('confirm route broadcasts triage:updated with mutation=confirmed and the decisionId', async () => {
    seedRow({ id: 'tr-1' });
    permissionLevel = 'edit';
    const wsMod = await import('../../ws.js');
    const broadcastMock = wsMod.broadcast as unknown as ReturnType<typeof vi.fn>;
    broadcastMock.mockClear();
    const app = await buildApp('jwt');
    await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/confirm',
    });
    await app.close();
    const triageEvents = broadcastMock.mock.calls.filter(
      (c) => (c[1] as { type?: string }).type === 'triage:updated',
    );
    expect(triageEvents).toHaveLength(1);
    expect(triageEvents[0][1]).toMatchObject({
      type: 'triage:updated',
      mapId: 'map-1',
      mutation: 'confirmed',
      decisionIds: ['tr-1'],
    });
  });

  it('reclassify route broadcasts triage:updated with mutation=reclassified', async () => {
    seedRow({ id: 'tr-1' });
    permissionLevel = 'edit';
    const wsMod = await import('../../ws.js');
    const broadcastMock = wsMod.broadcast as unknown as ReturnType<typeof vi.fn>;
    broadcastMock.mockClear();
    const app = await buildApp('jwt');
    await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/reclassify',
    });
    await app.close();
    const triageEvents = broadcastMock.mock.calls.filter(
      (c) => (c[1] as { type?: string }).type === 'triage:updated',
    );
    expect(triageEvents).toHaveLength(1);
    expect(triageEvents[0][1]).toMatchObject({
      mutation: 'reclassified',
      decisionIds: ['tr-1'],
    });
  });

  it('bulk-confirm broadcasts a single triage:updated with all confirmed ids (skips errored rows)', async () => {
    seedRow({ id: 'a', reviewed: false, decidedBy: 'auto' });
    seedRow({ id: 'b', reviewed: false, decidedBy: 'auto' });
    permissionLevel = 'edit';
    const wsMod = await import('../../ws.js');
    const broadcastMock = wsMod.broadcast as unknown as ReturnType<typeof vi.fn>;
    broadcastMock.mockClear();
    const app = await buildApp('jwt');
    await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/bulk-confirm',
      payload: { decisionIds: ['a', 'b', 'ghost'] },
    });
    await app.close();
    const triageEvents = broadcastMock.mock.calls.filter(
      (c) => (c[1] as { type?: string }).type === 'triage:updated',
    );
    expect(triageEvents).toHaveLength(1);
    const payload = triageEvents[0][1] as { decisionIds: string[]; mutation: string };
    expect(payload.mutation).toBe('confirmed');
    // 'ghost' errored (NOT_FOUND); only 'a' and 'b' are included.
    expect([...payload.decisionIds].sort()).toEqual(['a', 'b']);
  });
});

// ── GET .../history (Phase 3 #96) ────────────────────────────────

describe('GET .../triage-decisions/:decisionId/history', () => {
  it('returns history rows newest-first for the supplied decision', async () => {
    seedRow({ id: 'tr-1' });
    nodes.set('epic-1', { id: 'epic-1', mapId: 'map-1', parentId: 'root-1' });
    permissionLevel = 'edit';

    // Seed three mutations on the same decision (confirm → confirm again
    // → override) by issuing real route calls so the history-write path
    // matches production.
    const app = await buildApp('jwt');
    await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/confirm',
    });
    await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/confirm',
    });
    await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/tr-1/override',
      payload: { decision: 'place', parentNodeId: 'epic-1', reason: 'I know better' },
    });

    permissionLevel = 'view';
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions/tr-1/history',
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json() as { total: number; history: Array<{ changeType: string }> };
    expect(body.total).toBe(3);
    // The recorder writes them in insert order; the route sorts desc
    // by changedAt. With our deterministic timestamps the override is
    // last-written → first-returned.
    expect(body.history[0].changeType).toBe('overridden');
  });

  it('404 when the decision is not in this map (cross-map id leak guard)', async () => {
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions/ghost/history',
    });
    await app.close();
    expect(res.statusCode).toBe(404);
    expect(res.json().error?.code).toBe('NOT_FOUND');
  });

  it('403 for API-key auth (same gate as other triage reads)', async () => {
    seedRow({ id: 'tr-1' });
    permissionLevel = 'admin';
    const app = await buildApp('api-key');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions/tr-1/history',
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code).toBe('FORBIDDEN');
  });

  it("403 for a JWT session without view permission", async () => {
    seedRow({ id: 'tr-1' });
    permissionLevel = null;
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions/tr-1/history',
    });
    await app.close();
    expect(res.statusCode).toBe(403);
  });

  it('returns empty history for a row that has never been mutated through the routes', async () => {
    // History rows are written by the mutation routes / ingest path.
    // A bare seeded row (no mutations through this app instance) has
    // no rows in the history table — the route returns total=0 cleanly.
    seedRow({ id: 'tr-1' });
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions/tr-1/history',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(0);
    expect(res.json().history).toEqual([]);
  });
});

// ── Not-in-MindBlown unified view (#140) ─────────────────────────

describe('GET .../triage-decisions/not-in-mindblown', () => {
  it('403 for API-key auth', async () => {
    permissionLevel = 'admin';
    const app = await buildApp('api-key');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions/not-in-mindblown',
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code).toBe('FORBIDDEN');
  });

  it('returns 200 for a JWT session with view permission', async () => {
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions/not-in-mindblown',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  it('partitions decision rows into skipped / pending-skipped / uncertain', async () => {
    // Three decision rows, one per bucket:
    seedRow({
      id: 'tr-skipped',
      decision: 'skip',
      reviewed: true,
      externalId: 'o/r#1',
      issueTitle: 'Skipped, reviewed',
    });
    seedRow({
      id: 'tr-pending',
      decision: 'skip',
      reviewed: false,
      externalId: 'o/r#2',
      issueTitle: 'Skipped, NOT reviewed',
    });
    seedRow({
      id: 'tr-uncertain',
      decision: 'uncertain',
      reviewed: false,
      externalId: 'o/r#3',
      issueTitle: 'Uncertain',
    });
    // A `place` decision must NOT be returned by this endpoint — the
    // unified view is about issues NOT in MindBlown, and place rows
    // are (in theory) attached to a node.
    seedRow({
      id: 'tr-place',
      decision: 'place',
      reviewed: true,
      externalId: 'o/r#4',
      issueTitle: 'Placed already',
    });
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions/not-in-mindblown',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ kind: string; externalId: string }>;
    const byKind = items.reduce<Record<string, string[]>>((acc, it) => {
      acc[it.kind] = acc[it.kind] ?? [];
      acc[it.kind].push(it.externalId);
      return acc;
    }, {});
    expect(byKind.skipped).toEqual(['o/r#1']);
    expect(byKind['pending-skipped']).toEqual(['o/r#2']);
    expect(byKind.uncertain).toEqual(['o/r#3']);
    // The place row never surfaces.
    expect(items.some((i) => i.externalId === 'o/r#4')).toBe(false);
  });

  it('bucket=skipped narrows the result to skip+reviewed rows', async () => {
    seedRow({ id: 'tr-skipped', decision: 'skip', reviewed: true, externalId: 'o/r#1' });
    seedRow({ id: 'tr-pending', decision: 'skip', reviewed: false, externalId: 'o/r#2' });
    seedRow({ id: 'tr-uncertain', decision: 'uncertain', externalId: 'o/r#3' });
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions/not-in-mindblown?bucket=skipped',
    });
    await app.close();
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].kind).toBe('skipped');
  });

  it('bucket=pending-skipped narrows to skip+unreviewed', async () => {
    seedRow({ id: 'tr-skipped', decision: 'skip', reviewed: true, externalId: 'o/r#1' });
    seedRow({ id: 'tr-pending', decision: 'skip', reviewed: false, externalId: 'o/r#2' });
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions/not-in-mindblown?bucket=pending-skipped',
    });
    await app.close();
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].kind).toBe('pending-skipped');
  });

  it('bucket=uncertain narrows to uncertain decisions', async () => {
    seedRow({ id: 'tr-skipped', decision: 'skip', reviewed: true, externalId: 'o/r#1' });
    seedRow({ id: 'tr-uncertain', decision: 'uncertain', externalId: 'o/r#3' });
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions/not-in-mindblown?bucket=uncertain',
    });
    await app.close();
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].kind).toBe('uncertain');
  });

  it('400 on an invalid bucket value', async () => {
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions/not-in-mindblown?bucket=banana',
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('VALIDATION_ERROR');
  });

  it('returns orphans for GitHub issues with no triage row + no node link', async () => {
    // Arm the GitHub mocks: one map context + three GH issues. Two
    // are already represented in the map (one via a triage row, one
    // via an externalLink on a node); the third has neither and
    // should land in the orphan bucket.
    githubContextMock.mockImplementation(async () => ({
      owner: 'o',
      repo: 'r',
      token: 't',
    }));
    importGitHubIssuesMock.mockImplementation(async () => [
      {
        issue: { number: 1, title: 'Has triage row', state: 'open', html_url: 'https://github.com/o/r/issues/1' },
        externalLink: { externalId: 'o/r#1' },
      },
      {
        issue: { number: 2, title: 'Linked on node', state: 'open', html_url: 'https://github.com/o/r/issues/2' },
        externalLink: { externalId: 'o/r#2' },
      },
      {
        issue: { number: 3, title: 'Orphan!', state: 'open', html_url: 'https://github.com/o/r/issues/3' },
        externalLink: { externalId: 'o/r#3' },
      },
    ]);
    // Issue #1 already has a triage_decisions row.
    seedRow({ id: 'tr-1', decision: 'skip', reviewed: true, externalId: 'o/r#1' });
    // Issue #2 is linked on a node in this map.
    nodes.set('node-linked', {
      id: 'node-linked',
      mapId: 'map-1',
      parentId: null,
      externalLinks: [{ provider: 'github', externalId: 'o/r#2' }],
    });
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions/not-in-mindblown',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().orphansAvailable).toBe(true);
    const items = res.json().items as Array<{ kind: string; externalId: string }>;
    const orphans = items.filter((i) => i.kind === 'orphan');
    expect(orphans).toHaveLength(1);
    expect(orphans[0].externalId).toBe('o/r#3');
    // And the existing decision-row is still there in its own bucket.
    expect(items.some((i) => i.kind === 'skipped' && i.externalId === 'o/r#1')).toBe(true);
  });

  it('bucket=orphans returns ONLY the orphan items', async () => {
    githubContextMock.mockImplementation(async () => ({
      owner: 'o',
      repo: 'r',
      token: 't',
    }));
    importGitHubIssuesMock.mockImplementation(async () => [
      {
        issue: { number: 1, title: 'Orphan', state: 'open', html_url: 'https://github.com/o/r/issues/1' },
        externalLink: { externalId: 'o/r#1' },
      },
    ]);
    seedRow({ id: 'tr-skipped', decision: 'skip', reviewed: true, externalId: 'o/r#999' });
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions/not-in-mindblown?bucket=orphans',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ kind: string }>;
    expect(items.every((i) => i.kind === 'orphan')).toBe(true);
    expect(items).toHaveLength(1);
  });

  it('orphansAvailable=false + orphansError set when GitHub not configured', async () => {
    // Default mock state returns null context → orphan branch skips.
    seedRow({ id: 'tr-skipped', decision: 'skip', reviewed: true, externalId: 'o/r#1' });
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions/not-in-mindblown',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().orphansAvailable).toBe(false);
    expect(res.json().orphansError).toMatch(/not configured/);
    // Decision-row buckets still return cleanly.
    expect(res.json().items).toHaveLength(1);
  });

  it('orphansAvailable=false when importGitHubIssues throws — request still succeeds', async () => {
    githubContextMock.mockImplementation(async () => ({
      owner: 'o',
      repo: 'r',
      token: 't',
    }));
    importGitHubIssuesMock.mockImplementation(async () => {
      throw new Error('rate limit hit');
    });
    seedRow({ id: 'tr-1', decision: 'skip', reviewed: true });
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions/not-in-mindblown',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().orphansAvailable).toBe(false);
    expect(res.json().orphansError).toMatch(/rate limit/);
  });

  it('honors limit (default 50, cap 200)', async () => {
    for (let i = 0; i < 10; i++) {
      seedRow({ id: `tr-${i}`, decision: 'skip', reviewed: true, externalId: `o/r#${i}` });
    }
    permissionLevel = 'view';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'GET',
      url: '/api/maps/map-1/triage-decisions/not-in-mindblown?limit=3',
    });
    await app.close();
    expect(res.json().total).toBe(10);
    expect(res.json().returned).toBe(3);
    expect(res.json().items).toHaveLength(3);
  });
});

// ── Orphan-import / Orphan-skip routes (#140) ────────────────────

describe('POST .../triage-decisions/orphan-import', () => {
  it('403 for API-key auth', async () => {
    permissionLevel = 'edit';
    const app = await buildApp('api-key');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/orphan-import',
      payload: {
        externalId: 'o/r#42',
        issueTitle: 'New',
        parentNodeId: 'epic-1',
      },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
  });

  it('creates a node + triage row when the issue is a true orphan', async () => {
    nodes.set('epic-1', { id: 'epic-1', mapId: 'map-1', parentId: null });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/orphan-import',
      payload: {
        externalId: 'o/r#42',
        issueTitle: 'New orphan',
        issueState: 'open',
        parentNodeId: 'epic-1',
        reason: 'manual import',
      },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('imported');
    expect(res.json().nodeId).toBe('created-node');
    expect(createNodeMock).toHaveBeenCalledOnce();
    // The triage row was inserted with operator-decided + reviewed.
    const inserted = [...triageRows.values()].find(
      (r) => r.externalId === 'o/r#42',
    );
    expect(inserted).toBeDefined();
    expect(inserted!.decision).toBe('place');
    expect(inserted!.decidedBy).toBe('operator');
    expect(inserted!.reviewed).toBe(true);
  });

  it('rejects when a triage row already exists for the externalId (409 NOT_ORPHAN)', async () => {
    seedRow({ id: 'tr-existing', externalId: 'o/r#42', decision: 'skip' });
    nodes.set('epic-1', { id: 'epic-1', mapId: 'map-1', parentId: null });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/orphan-import',
      payload: {
        externalId: 'o/r#42',
        issueTitle: 'New',
        parentNodeId: 'epic-1',
      },
    });
    await app.close();
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code).toBe('NOT_ORPHAN');
    expect(createNodeMock).not.toHaveBeenCalled();
  });

  it('rejects when parentNodeId is not in this map', async () => {
    nodes.set('outside', { id: 'outside', mapId: 'other-map', parentId: null });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/orphan-import',
      payload: {
        externalId: 'o/r#42',
        issueTitle: 'New',
        parentNodeId: 'outside',
      },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(createNodeMock).not.toHaveBeenCalled();
  });

  it('400 when externalId / issueTitle / parentNodeId missing', async () => {
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/orphan-import',
      payload: { externalId: 'o/r#42' },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
  });
});

describe('POST .../triage-decisions/orphan-skip', () => {
  it('403 for API-key auth', async () => {
    permissionLevel = 'edit';
    const app = await buildApp('api-key');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/orphan-skip',
      payload: { externalId: 'o/r#42', issueTitle: 'x' },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
  });

  it('inserts a skip row, no node created', async () => {
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/orphan-skip',
      payload: {
        externalId: 'o/r#7',
        issueTitle: 'Orphan to skip',
        issueState: 'open',
      },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('skipped');
    const inserted = [...triageRows.values()].find(
      (r) => r.externalId === 'o/r#7',
    );
    expect(inserted).toBeDefined();
    expect(inserted!.decision).toBe('skip');
    expect(inserted!.decidedBy).toBe('operator');
    expect(inserted!.reviewed).toBe(true);
    expect(createNodeMock).not.toHaveBeenCalled();
  });

  it('rejects when a triage row already exists (409 NOT_ORPHAN)', async () => {
    seedRow({ id: 'tr-existing', externalId: 'o/r#7' });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/orphan-skip',
      payload: { externalId: 'o/r#7', issueTitle: 'x' },
    });
    await app.close();
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code).toBe('NOT_ORPHAN');
  });
});

// ── Ray review (#141 round 2) ────────────────────────────────────
//
// Two should-fixes folded in after Ray's APPROVE: the race window on
// orphan-import / orphan-skip (precheck was outside the tx, so two
// concurrent callers could both pass it and the loser would crash on
// the unique constraint) and the `change_type='overridden'` mis-label
// on brand-new audit rows (semantically it's `'created'`).
describe('orphan-import / orphan-skip — race-safety + audit-history change_type', () => {
  it('orphan-import records change_type=created (brand-new row, no previous decision)', async () => {
    nodes.set('epic-1', { id: 'epic-1', mapId: 'map-1', parentId: null });
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/orphan-import',
      payload: {
        externalId: 'o/r#new',
        issueTitle: 'New orphan',
        parentNodeId: 'epic-1',
      },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const history = [...historyRows.values()];
    expect(history.length).toBe(1);
    expect(history[0].changeType).toBe('created');
    expect(history[0].previousDecision).toBeNull();
    expect(history[0].newDecision).toBe('place');
  });

  it('orphan-skip records change_type=created (brand-new row, no previous decision)', async () => {
    permissionLevel = 'edit';
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/orphan-skip',
      payload: { externalId: 'o/r#skip-new', issueTitle: 'Skip me' },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const history = [...historyRows.values()];
    expect(history.length).toBe(1);
    expect(history[0].changeType).toBe('created');
    expect(history[0].previousDecision).toBeNull();
    expect(history[0].newDecision).toBe('skip');
  });

  it('orphan-import: two concurrent callers — exactly one wins, the other gets 409 NOT_ORPHAN', async () => {
    // Race-simulation harness: gate the second transaction outside its
    // callback until the first transaction has fully committed its
    // INSERT. The fix moves the precheck *inside* the tx after the
    // advisory lock, so when caller #2's tx body finally runs, its
    // in-tx precheck reads caller #1's just-inserted row and returns
    // the documented 409 — not a raw DB error.
    nodes.set('epic-1', { id: 'epic-1', mapId: 'map-1', parentId: null });
    permissionLevel = 'edit';
    let releaseSecond: (() => void) | null = null;
    const secondReady = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    txGateHolder.enter = (n: number) => {
      if (n === 0) return; // first tx runs immediately
      return secondReady; // second tx waits until we release it
    };
    const app = await buildApp('jwt');
    const payload = {
      externalId: 'o/r#race',
      issueTitle: 'Racy orphan',
      parentNodeId: 'epic-1',
    };
    const a = app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/orphan-import',
      payload,
    });
    const b = app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/orphan-import',
      payload,
    });
    // First caller completes its transaction (insert visible), then we
    // release the second caller — its in-tx precheck must now 409.
    const aResult = await a;
    releaseSecond!();
    const bResult = await b;
    await app.close();
    const codes = [aResult.statusCode, bResult.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const winner = aResult.statusCode === 200 ? aResult : bResult;
    const loser = aResult.statusCode === 409 ? aResult : bResult;
    expect(winner.json().status).toBe('imported');
    expect(loser.json().error?.code).toBe('NOT_ORPHAN');
    // Exactly one triage row + one history row got persisted.
    expect(triageRows.size).toBe(1);
    expect(historyRows.size).toBe(1);
    expect([...historyRows.values()][0].changeType).toBe('created');
  });

  it('orphan-skip: two concurrent callers — exactly one wins, the other gets 409 NOT_ORPHAN', async () => {
    permissionLevel = 'edit';
    let releaseSecond: (() => void) | null = null;
    const secondReady = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    txGateHolder.enter = (n: number) => {
      if (n === 0) return;
      return secondReady;
    };
    const app = await buildApp('jwt');
    const payload = { externalId: 'o/r#skip-race', issueTitle: 'Racy skip' };
    const a = app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/orphan-skip',
      payload,
    });
    const b = app.inject({
      method: 'POST',
      url: '/api/maps/map-1/triage-decisions/orphan-skip',
      payload,
    });
    const aResult = await a;
    releaseSecond!();
    const bResult = await b;
    await app.close();
    const codes = [aResult.statusCode, bResult.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const winner = aResult.statusCode === 200 ? aResult : bResult;
    const loser = aResult.statusCode === 409 ? aResult : bResult;
    expect(winner.json().status).toBe('skipped');
    expect(loser.json().error?.code).toBe('NOT_ORPHAN');
    expect(triageRows.size).toBe(1);
    expect(historyRows.size).toBe(1);
    expect([...historyRows.values()][0].changeType).toBe('created');
  });
});
