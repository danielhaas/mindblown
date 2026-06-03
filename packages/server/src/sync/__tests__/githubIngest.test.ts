/**
 * Tests for the auto-ingest of new GitHub issues into the map's Inbox.
 *
 * The DB layer is mocked — we exercise the decision tree in
 * `ensureNodeForIssue`, the inbox lazy-create/lazy-restore path in
 * `ensureInboxNode`, and the multi-map fan-out in
 * `ingestNewIssuesForRepo`. Real Postgres-backed assertions are out of
 * scope here; integration coverage of the catchup wiring lives next to
 * the manual persona tests called out in the PR description.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitHubIssue } from '@mindblown/integrations';

// ── Module mocks (declared before SUT import for vitest hoisting) ──

// Per-key serialization gates that simulate pg_advisory_xact_lock — a
// second call inside a transaction with the same lock key blocks until
// the first transaction commits. Released by the tx mock at end-of-tx.
const lockQueues = new Map<string, Promise<unknown>>();
async function takeLockSimulated(key: string): Promise<() => void> {
  const prev = lockQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  lockQueues.set(key, prev.then(() => next));
  await prev;
  return release;
}

const dbExecute = vi.fn(async (_sqlObj?: unknown) => undefined);
type DbState = {
  // mapId → {rootNodeId, inboxId, createdBy}
  maps: Map<string, { rootNodeId: string; inboxId: string | null; createdBy: string }>;
  // nodeId → row{id, mapId, parentId, externalLinks}
  nodes: Map<string, { id: string; mapId: string; parentId: string | null; externalLinks: Array<{ provider: string; externalId: string }> }>;
  // PAT integrations
  integrations: Array<{ workspaceId: string; provider: string; enabled: boolean; config: { owner?: string; repo?: string } }>;
};
const dbState: DbState = {
  maps: new Map(),
  nodes: new Map(),
  integrations: [],
};

// Track update calls for assertions
const updateNodeCalls: Array<{ nodeId: string; input: Record<string, unknown> }> = [];
const createNodeCalls: Array<Record<string, unknown>> = [];
const getNodeMock = vi.fn();

// db.execute logs the SQL for inspection
const advisoryLocksTaken: string[] = [];

// We model drizzle's `eq(col, value)` as a Predicate object that captures the
// column key and target value. `and(...preds)` ANDs them. The mock select can
// then apply the predicate to a row to filter the result.
//
// This is a lot more accurate than a pass-through — it actually filters rows
// the way drizzle would, so tests for mapId-scoped queries behave correctly.
type Predicate = { __pred: true; check: (row: Record<string, unknown>) => boolean };
function eqPred(colKey: string, value: unknown): Predicate {
  return {
    __pred: true,
    check: (row) => row[colKey] === value,
  };
}
function andPred(...preds: Predicate[]): Predicate {
  return { __pred: true, check: (row) => preds.every((p) => p.check(row)) };
}

function applyPred(rows: Record<string, unknown>[], pred: unknown): Record<string, unknown>[] {
  if (!pred || typeof pred !== 'object') return rows;
  const p = pred as { __pred?: true; check?: (row: Record<string, unknown>) => boolean };
  if (!p.__pred || typeof p.check !== 'function') return rows;
  return rows.filter((r) => p.check!(r));
}

type ChainStep = { table?: string; pred?: unknown };
function buildChain(): {
  from: (table: { __name?: string }) => unknown;
} {
  const step: ChainStep = {};
  const resolve = async (): Promise<Record<string, unknown>[]> => {
    let rows: Record<string, unknown>[] = [];
    if (step.table === 'maps') {
      rows = [...dbState.maps.entries()].map(([id, m]) => ({
        id,
        createdBy: m.createdBy,
        rootNodeId: m.rootNodeId,
        inboxId: m.inboxId,
        // Test fixtures don't track these explicitly; treat any map in
        // dbState as bound to owner/repo + opted-in, so the
        // autoImportNewIssues + binding predicates pass through.
        githubRepoOwner: 'owner',
        githubRepoName: 'repo',
        autoImportNewIssues: true,
        workspaceId: 'ws',
      }));
    } else if (step.table === 'nodes') {
      rows = [...dbState.nodes.values()].map((n) => ({
        id: n.id,
        mapId: n.mapId,
        externalLinks: n.externalLinks,
      }));
    } else if (step.table === 'integrations') {
      rows = dbState.integrations.map((i) => ({ ...i }));
    }
    return applyPred(rows, step.pred);
  };
  const thenable = {
    then: (onFulfilled: (v: Record<string, unknown>[]) => unknown, onRejected?: (err: unknown) => unknown) =>
      resolve().then(onFulfilled, onRejected),
    catch: (onRejected: (err: unknown) => unknown) => resolve().catch(onRejected),
    where: (pred: unknown) => {
      step.pred = pred;
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

function mockSelect(_cols?: unknown) {
  return buildChain();
}

// db.transaction(cb) runs cb with a `tx` handle that mirrors db. The mock
// implementation intercepts pg_advisory_xact_lock to enforce per-key
// serialization across concurrent transactions, then releases the lock
// when the callback resolves (modelling tx commit).
function buildTxHandle(releaseHooks: Array<() => void>) {
  return {
    execute: async (sqlObj: unknown) => {
      const raw = JSON.stringify(sqlObj);
      if (raw.includes('pg_advisory_xact_lock')) {
        advisoryLocksTaken.push(raw);
        // Pull the externalId out — it's embedded in the sql template's
        // params. JSON serialization of drizzle's SQL object preserves
        // values as strings, so a regex over the raw form is the easiest
        // way to recover the key. Falls back to a global lock.
        const m = raw.match(/owner\\?\/?repo#\d+/);
        const key = m ? m[0].replace(/\\\//g, '/').replace(/\\?\/?/, '/') : 'global';
        const release = await takeLockSimulated(key);
        releaseHooks.push(release);
      }
      return dbExecute(sqlObj);
    },
    select: (cols?: unknown) => mockSelect(cols),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: async () => [],
      }),
    }),
  };
}

vi.mock('../../db/connection.js', () => ({
  db: {
    execute: (sqlObj: unknown) => {
      const raw = JSON.stringify(sqlObj);
      if (raw.includes('pg_advisory_xact_lock')) {
        advisoryLocksTaken.push(raw);
      }
      return dbExecute(sqlObj);
    },
    select: (cols?: unknown) => mockSelect(cols),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: async () => [],
      }),
    }),
    transaction: async <T>(cb: (tx: ReturnType<typeof buildTxHandle>) => Promise<T>): Promise<T> => {
      const releaseHooks: Array<() => void> = [];
      const tx = buildTxHandle(releaseHooks);
      try {
        const result = await cb(tx);
        // tx commit — release any held advisory locks
        for (const r of releaseHooks) r();
        return result;
      } catch (err) {
        for (const r of releaseHooks) r();
        throw err;
      }
    },
  },
}));
// Schema column tokens carry a `__col` string so the mocked drizzle helpers
// (eq/and) can build Predicate objects keyed on column NAMES that match the
// keys our mock-select fabricates on each row. `col(name)` is defined inside
// the factory because vi.mock hoists above top-level declarations.
vi.mock('../../db/schema.js', () => {
  const col = (name: string) => ({ __col: name });
  return {
    maps: {
      __name: 'maps',
      id: col('id'),
      createdBy: col('createdBy'),
      autoImportNewIssues: col('autoImportNewIssues'),
      githubRepoOwner: col('githubRepoOwner'),
      githubRepoName: col('githubRepoName'),
      githubInboxNodeId: col('githubInboxNodeId'),
      rootNodeId: col('rootNodeId'),
      workspaceId: col('workspaceId'),
    },
    nodes: {
      __name: 'nodes',
      id: col('id'),
      mapId: col('mapId'),
      externalLinks: col('externalLinks'),
    },
    integrations: {
      __name: 'integrations',
      workspaceId: col('workspaceId'),
      provider: col('provider'),
      enabled: col('enabled'),
    },
  };
});

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('drizzle-orm');
  type Pred = { __pred: true; check: (row: Record<string, unknown>) => boolean };
  return {
    ...actual,
    eq: (column: { __col?: string }, value: unknown): Pred => ({
      __pred: true,
      check: (row) => row[column.__col ?? ''] === value,
    }),
    and: (...preds: Pred[]): Pred => ({
      __pred: true,
      check: (row) => preds.every((p) => p.check(row)),
    }),
    isNotNull: (column: { __col?: string }): Pred => ({
      __pred: true,
      check: (row) => row[column.__col ?? ''] != null,
    }),
  };
});

vi.mock('../../db/nodes.js', () => ({
  getNode: (id: string) => getNodeMock(id),
  createNode: async (input: Record<string, unknown>) => {
    createNodeCalls.push(input);
    const id = `node-${createNodeCalls.length}`;
    const row = {
      id,
      mapId: input.mapId as string,
      parentId: input.parentId as string,
      childrenIds: [],
      text: input.text as string,
      description: null,
      x: null,
      y: null,
      collapsed: false,
      effortEstimate: null,
      actualEffort: null,
      percentComplete: (input.percentComplete as number | undefined) ?? null,
      status: (input.status as string | undefined) ?? null,
      blockedReason: null,
      assigneeIds: [],
      priority: null,
      dueDate: null,
      startDate: null,
      tags: [],
      customFields: {},
      dependencies: [],
      versionId: null,
      cycleId: null,
      externalLinks: [],
      autoProgress: 'off' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: input.createdBy as string,
      revision: 1,
    };
    // Also register it in dbState.nodes so subsequent existence pre-checks see it.
    dbState.nodes.set(id, {
      id,
      mapId: input.mapId as string,
      parentId: (input.parentId as string | undefined) ?? null,
      externalLinks: [],
    });
    return row;
  },
  updateNode: async (nodeId: string, input: Record<string, unknown>) => {
    updateNodeCalls.push({ nodeId, input });
    // Mirror externalLinks into dbState so the existence precheck sees them.
    if (input.externalLinks) {
      const row = dbState.nodes.get(nodeId);
      if (row) {
        row.externalLinks = input.externalLinks as Array<{ provider: string; externalId: string }>;
      }
    }
    const row = dbState.nodes.get(nodeId);
    // Return a row that mirrors the production `nodeDb.updateNode` shape
    // (fields the broadcast for `node:created` reads). Pulling parentId
    // off the dbState row keeps the mock honest for tests that assert on
    // the broadcast payload shape.
    return {
      id: nodeId,
      mapId: row?.mapId ?? 'm1',
      parentId: (row as { parentId?: string } | undefined)?.parentId ?? null,
      externalLinks: input.externalLinks ?? [],
    };
  },
}));

vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

// ── SUT import (must be after mocks) ──────────────────────────────

import {
  ensureNodeForIssue,
  ensureInboxNode,
  ingestNewIssuesForRepo,
  findIngestTargetMaps,
  findNodesByExternalIds,
} from '../githubIngest.js';

// ── Fixtures ──────────────────────────────────────────────────────

function issue(
  number: number,
  overrides: Partial<GitHubIssue> = {},
): GitHubIssue {
  return {
    id: number * 1000,
    number,
    title: `Issue ${number}`,
    body: null,
    state: 'open',
    labels: [],
    assignees: [],
    milestone: null,
    html_url: `https://github.com/owner/repo/issues/${number}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null,
    ...overrides,
  };
}

function resetState() {
  dbState.maps.clear();
  dbState.nodes.clear();
  dbState.integrations = [];
  updateNodeCalls.length = 0;
  createNodeCalls.length = 0;
  advisoryLocksTaken.length = 0;
  getNodeMock.mockReset();
}

beforeEach(() => {
  resetState();
});

// ── ensureInboxNode ───────────────────────────────────────────────

describe('ensureInboxNode', () => {
  it('reuses an existing inbox node id when set and the node exists', async () => {
    dbState.maps.set('m1', { rootNodeId: 'root-1', inboxId: 'inbox-1', createdBy: 'u1' });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    getNodeMock.mockResolvedValueOnce({ id: 'inbox-1', mapId: 'm1' });

    const id = await ensureInboxNode('m1', 'u1');
    expect(id).toBe('inbox-1');
    expect(createNodeCalls.length).toBe(0);
  });

  it('creates a new inbox node when none is set', async () => {
    dbState.maps.set('m1', { rootNodeId: 'root-1', inboxId: null, createdBy: 'u1' });

    const id = await ensureInboxNode('m1', 'u1');
    expect(createNodeCalls.length).toBe(1);
    expect(createNodeCalls[0]).toMatchObject({
      mapId: 'm1',
      parentId: 'root-1',
      text: 'GitHub Inbox',
      createdBy: 'u1',
    });
    // The mock returns 'node-1' as the first created id.
    expect(id).toBe('node-1');
  });

  it('lazy-recreates the inbox when the stored id points to a deleted node', async () => {
    dbState.maps.set('m1', { rootNodeId: 'root-1', inboxId: 'dangling', createdBy: 'u1' });
    getNodeMock.mockResolvedValueOnce(null);

    const id = await ensureInboxNode('m1', 'u1');
    expect(createNodeCalls.length).toBe(1);
    expect(id).toBe('node-1');
  });
});

// ── ensureNodeForIssue ────────────────────────────────────────────

describe('ensureNodeForIssue', () => {
  it('creates a node with `#NNNN <title>` and status=todo for an open issue', async () => {
    dbState.maps.set('m1', { rootNodeId: 'root-1', inboxId: 'inbox-1', createdBy: 'u1' });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });

    const result = await ensureNodeForIssue(
      'm1',
      'inbox-1',
      issue(42, { title: 'Make it work' }),
      { owner: 'owner', repo: 'repo', createdBy: 'u1' },
    );

    expect(result.status).toBe('created');
    expect(result.nodeId).toBeDefined();
    expect(createNodeCalls[0]).toMatchObject({
      mapId: 'm1',
      parentId: 'inbox-1',
      text: '#42 Make it work',
      percentComplete: 0,
      status: 'todo',
    });
    // The externalLinks update should attach the github link with the
    // correct externalId.
    const updateCall = updateNodeCalls.find((c) => c.input.externalLinks);
    expect(updateCall?.input.externalLinks).toEqual([
      expect.objectContaining({
        provider: 'github',
        externalId: 'owner/repo#42',
      }),
    ]);
    // Advisory lock taken before precheck.
    expect(advisoryLocksTaken.length).toBeGreaterThan(0);
  });

  it('is idempotent — second call with same externalId returns skipped_exists', async () => {
    dbState.maps.set('m1', { rootNodeId: 'root-1', inboxId: 'inbox-1', createdBy: 'u1' });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });

    const ctx = { owner: 'owner', repo: 'repo', createdBy: 'u1' };
    const first = await ensureNodeForIssue('m1', 'inbox-1', issue(42), ctx);
    const second = await ensureNodeForIssue('m1', 'inbox-1', issue(42), ctx);

    expect(first.status).toBe('created');
    expect(second.status).toBe('skipped_exists');
    // Only one create happened.
    expect(createNodeCalls.length).toBe(1);
  });

  it('with allowClosedWithinDays=30, closed-recent issue → status=done, pct=100', async () => {
    dbState.maps.set('m1', { rootNodeId: 'root-1', inboxId: 'inbox-1', createdBy: 'u1' });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });

    const closedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const result = await ensureNodeForIssue(
      'm1',
      'inbox-1',
      issue(99, { state: 'closed', closed_at: closedAt, title: 'old work' }),
      { owner: 'owner', repo: 'repo', createdBy: 'u1' },
      { allowClosedWithinDays: 30 },
    );
    expect(result.status).toBe('created');
    expect(createNodeCalls[0]).toMatchObject({
      percentComplete: 100,
      status: 'done',
      text: '#99 old work',
    });
  });

  it('returns skipped_closed_outside_window for a long-closed issue', async () => {
    dbState.maps.set('m1', { rootNodeId: 'root-1', inboxId: 'inbox-1', createdBy: 'u1' });
    const closedAt = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const result = await ensureNodeForIssue(
      'm1',
      'inbox-1',
      issue(99, { state: 'closed', closed_at: closedAt }),
      { owner: 'owner', repo: 'repo', createdBy: 'u1' },
      { allowClosedWithinDays: 30 },
    );
    expect(result.status).toBe('skipped_closed_outside_window');
    expect(createNodeCalls.length).toBe(0);
  });

  it('returns skipped_closed_outside_window for any closed issue when window=0 (default)', async () => {
    dbState.maps.set('m1', { rootNodeId: 'root-1', inboxId: 'inbox-1', createdBy: 'u1' });
    const result = await ensureNodeForIssue(
      'm1',
      'inbox-1',
      issue(99, {
        state: 'closed',
        closed_at: new Date().toISOString(),
      }),
      { owner: 'owner', repo: 'repo', createdBy: 'u1' },
    );
    expect(result.status).toBe('skipped_closed_outside_window');
  });

  it('returns skipped_pr when issue.pull_request is set', async () => {
    dbState.maps.set('m1', { rootNodeId: 'root-1', inboxId: 'inbox-1', createdBy: 'u1' });
    const result = await ensureNodeForIssue(
      'm1',
      'inbox-1',
      { ...issue(50), pull_request: { merged_at: null } },
      { owner: 'owner', repo: 'repo', createdBy: 'u1' },
    );
    expect(result.status).toBe('skipped_pr');
    expect(createNodeCalls.length).toBe(0);
  });

  it('is idempotent across sequential awaits — second call returns skipped_exists', async () => {
    dbState.maps.set('m1', { rootNodeId: 'root-1', inboxId: 'inbox-1', createdBy: 'u1' });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });

    // Two awaited calls in series — the second call's precheck sees the
    // first call's already-committed externalLink and returns
    // skipped_exists. This is the cheap baseline; the race-safety test
    // below is the one that actually exercises the simulated advisory lock.
    const ctx = { owner: 'owner', repo: 'repo', createdBy: 'u1' };
    const first = await ensureNodeForIssue('m1', 'inbox-1', issue(7), ctx);
    const second = await ensureNodeForIssue('m1', 'inbox-1', issue(7), ctx);

    expect(first.status).toBe('created');
    expect(second.status).toBe('skipped_exists');
    expect(createNodeCalls.length).toBe(1);
  });

  it('race safety: parallel calls with serialized advisory lock create exactly one node', async () => {
    dbState.maps.set('m1', { rootNodeId: 'root-1', inboxId: 'inbox-1', createdBy: 'u1' });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });

    // The simulated advisory lock (lockQueues / takeLockSimulated at the top
    // of this file) serializes any two `pg_advisory_xact_lock` calls on the
    // same key — the second blocks until the first transaction commits
    // (which releases the lock at the end of the tx callback). This test
    // launches both calls in parallel via Promise.all so the second one
    // genuinely enters its tx before the first one finishes, and we verify
    // that the lock serialisation forces it to observe the first's
    // committed externalLink and short-circuit to skipped_exists.
    //
    // Asserting (a) that exactly one createNode happened across the two
    // calls and (b) that the lock was taken twice (once per tx) is the
    // meaningful invariant — anything less would prove only happy-path
    // idempotency, not race safety.
    const ctx = { owner: 'owner', repo: 'repo', createdBy: 'u1' };
    const [a, b] = await Promise.all([
      ensureNodeForIssue('m1', 'inbox-1', issue(7), ctx),
      ensureNodeForIssue('m1', 'inbox-1', issue(7), ctx),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['created', 'skipped_exists']);
    expect(createNodeCalls.length).toBe(1);
    // Both transactions must have called pg_advisory_xact_lock — proving
    // the lock infra was actually exercised, not bypassed.
    expect(advisoryLocksTaken.length).toBe(2);
  });

  it('broadcast payload for node:created carries the full node row', async () => {
    dbState.maps.set('m1', { rootNodeId: 'root-1', inboxId: 'inbox-1', createdBy: 'u1' });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });

    const { broadcast } = await import('../../ws.js');
    const broadcastMock = broadcast as unknown as ReturnType<typeof vi.fn>;
    broadcastMock.mockClear();

    const result = await ensureNodeForIssue(
      'm1',
      'inbox-1',
      issue(123, { title: 'WS shape check' }),
      { owner: 'owner', repo: 'repo', createdBy: 'u1' },
    );

    expect(result.status).toBe('created');
    // The broadcast call must include a `node` field with at least id,
    // mapId, parentId, and externalLinks — same shape every other
    // node:created emitter sends. The frontend handler reads `msg.node`
    // and TypeErrors on undefined.
    expect(broadcastMock).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({
        type: 'node:created',
        source: 'github_ingest',
        node: expect.objectContaining({
          id: expect.any(String),
          mapId: 'm1',
          parentId: 'inbox-1',
          externalLinks: expect.any(Array),
        }),
      }),
    );
  });
});

// ── findNodesByExternalIds ────────────────────────────────────────

describe('findNodesByExternalIds', () => {
  it('returns the subset of asked-for ids that match an existing externalLink', async () => {
    dbState.nodes.set('n1', {
      id: 'n1',
      mapId: 'm1',
      parentId: null,
      externalLinks: [{ provider: 'github', externalId: 'owner/repo#1' }],
    });
    dbState.nodes.set('n2', {
      id: 'n2',
      mapId: 'm1',
      parentId: null,
      externalLinks: [{ provider: 'github', externalId: 'owner/repo#2' }],
    });

    const result = await findNodesByExternalIds([
      'owner/repo#1',
      'owner/repo#3',
    ]);
    expect(result.has('owner/repo#1')).toBe(true);
    expect(result.has('owner/repo#3')).toBe(false);
  });
});

// ── ingestNewIssuesForRepo (multi-map fan-out) ────────────────────

describe('ingestNewIssuesForRepo', () => {
  it('creates one node per map for each new issue', async () => {
    // Two maps both opted in for owner/repo.
    dbState.maps.set('m1', { rootNodeId: 'root-1', inboxId: null, createdBy: 'u1' });
    dbState.maps.set('m2', { rootNodeId: 'root-2', inboxId: null, createdBy: 'u2' });

    const summary = await ingestNewIssuesForRepo(
      { owner: 'owner', repo: 'repo' },
      [issue(10), issue(11)],
    );

    // 2 maps × 2 issues = 4 created (plus 2 inbox creates).
    expect(summary.created).toBe(4);
    // Inbox creation also runs through createNode.
    expect(createNodeCalls.length).toBe(2 /* inboxes */ + 4 /* issues */);
  });

  it('returns zero work when no map is opted in', async () => {
    // dbState.maps is empty.
    const summary = await ingestNewIssuesForRepo(
      { owner: 'owner', repo: 'repo' },
      [issue(10)],
    );
    expect(summary.created).toBe(0);
    expect(createNodeCalls.length).toBe(0);
  });
});

// ── findIngestTargetMaps ─────────────────────────────────────────

describe('findIngestTargetMaps', () => {
  it('returns every map registered in the mocked DB (smoke)', async () => {
    dbState.maps.set('m1', { rootNodeId: 'root-1', inboxId: null, createdBy: 'u1' });
    const targets = await findIngestTargetMaps('owner', 'repo');
    expect(targets.length).toBeGreaterThan(0);
    expect(targets[0]).toMatchObject({ mapId: 'm1', createdBy: 'u1' });
  });
});
