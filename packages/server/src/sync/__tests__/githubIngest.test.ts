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
  // mapId → {rootNodeId, inboxId, createdBy, triageEnabled?, childrenOrder?, name?, description?}
  maps: Map<string, {
    rootNodeId: string;
    inboxId: string | null;
    createdBy: string;
    triageEnabled?: boolean;
    name?: string;
    description?: string | null;
  }>;
  // nodeId → row{id, mapId, parentId, externalLinks, text?, description?, childrenOrder?}
  nodes: Map<string, {
    id: string;
    mapId: string;
    parentId: string | null;
    externalLinks: Array<{ provider: string; externalId: string }>;
    text?: string;
    description?: unknown;
    childrenOrder?: string[];
  }>;
  // PAT integrations
  integrations: Array<{ workspaceId: string; provider: string; enabled: boolean; config: { owner?: string; repo?: string } }>;
  // Triage decision rows, keyed by id. Populated by the insert mock so
  // tests can assert on what was persisted.
  triageDecisions: Map<string, Record<string, unknown>>;
};
const dbState: DbState = {
  maps: new Map(),
  nodes: new Map(),
  integrations: [],
  triageDecisions: new Map(),
};

// Counter for generating triage decision ids.
let nextTriageDecisionId = 1;

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
        // Triage (#92, #93): default false unless the test fixture
        // opts in. Map name/description default to empty so the
        // mapContext builder has something to render.
        triageEnabled: m.triageEnabled ?? false,
        name: m.name ?? `map-${id}`,
        description: m.description ?? null,
      }));
    } else if (step.table === 'nodes') {
      rows = [...dbState.nodes.values()].map((n) => ({
        id: n.id,
        mapId: n.mapId,
        parentId: n.parentId,
        externalLinks: n.externalLinks,
        text: n.text ?? '',
        description: n.description ?? null,
        childrenOrder: n.childrenOrder ?? [],
      }));
    } else if (step.table === 'integrations') {
      rows = dbState.integrations.map((i) => ({ ...i }));
    } else if (step.table === 'triageDecisions') {
      rows = [...dbState.triageDecisions.values()].map((r) => ({ ...r }));
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
//
// The `__rollbacks` list on the returned tx handle lets the mocked
// `nodeDb.createNode` / `nodeDb.updateNode` register undo callbacks for
// the writes they made under this tx. If the cb throws, the transaction
// mock walks the rollbacks and applies them, modelling Postgres's
// rollback of every write in the aborted transaction. This is what lets
// the orphan-rollback test assert that no node row remains after the
// throw — without rollback simulation, the mock would behave as if
// every nodeDb call autocommitted, defeating the whole point of the
// test.
type TxHandle = ReturnType<typeof buildTxHandle>;
function buildTxHandle(releaseHooks: Array<() => void>) {
  const rollbacks: Array<() => void> = [];
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
    update: (table: { __name?: string }) => mockUpdate(table),
    insert: (table: { __name?: string }) => mockInsert(table),
    /** Undo callbacks registered by tx-scoped node writes. */
    __rollbacks: rollbacks,
  };
}
function isTxHandle(x: unknown): x is TxHandle {
  return !!x && typeof x === 'object' && Array.isArray((x as { __rollbacks?: unknown }).__rollbacks);
}

// Builder for `insert(table)` that knows about the triageDecisions
// table; everything else returns the legacy no-op stub.
function mockInsert(table: { __name?: string }) {
  if (table?.__name === 'triageDecisions') {
    return {
      values: (vals: Record<string, unknown>) => {
        const id = `triage-${nextTriageDecisionId++}`;
        const stored = { ...vals, id, decidedAt: new Date(), reviewed: vals.reviewed ?? false };
        return {
          onConflictDoUpdate: ({ set }: { target?: unknown; set: Record<string, unknown> }) => {
            // Check for an existing row with the same (mapId, externalId)
            // and update it; otherwise insert.
            const existing = [...dbState.triageDecisions.values()].find(
              (r) => r.mapId === vals.mapId && r.externalId === vals.externalId,
            );
            return {
              returning: async () => {
                if (existing) {
                  Object.assign(existing, set);
                  return [{ id: existing.id }];
                }
                dbState.triageDecisions.set(id, stored);
                return [{ id }];
              },
            };
          },
          returning: async () => {
            dbState.triageDecisions.set(id, stored);
            return [{ id }];
          },
        };
      },
    };
  }
  return {
    values: () => ({
      returning: async () => [],
    }),
  };
}

// Builder for `update(table)` that handles triageDecisions placedNodeId
// stamping after a node was auto-created; everything else is a no-op.
function mockUpdate(table: { __name?: string }) {
  if (table?.__name === 'triageDecisions') {
    return {
      set: (vals: Record<string, unknown>) => ({
        where: async (pred: unknown) => {
          // The where predicate filters by triageDecisions.id —
          // walk the in-memory map and apply.
          const p = pred as { __pred?: true; check?: (row: Record<string, unknown>) => boolean };
          for (const row of dbState.triageDecisions.values()) {
            if (p?.check?.(row as unknown as Record<string, unknown>)) {
              Object.assign(row, vals);
            }
          }
        },
      }),
    };
  }
  return {
    set: () => ({
      where: async () => undefined,
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
    update: (table: { __name?: string }) => mockUpdate(table),
    insert: (table: { __name?: string }) => mockInsert(table),
    transaction: async <T>(cb: (tx: ReturnType<typeof buildTxHandle>) => Promise<T>): Promise<T> => {
      const releaseHooks: Array<() => void> = [];
      const tx = buildTxHandle(releaseHooks);
      try {
        const result = await cb(tx);
        // tx commit — release any held advisory locks. Drop the
        // rollback list because the writes are now committed.
        for (const r of releaseHooks) r();
        return result;
      } catch (err) {
        // tx rollback — walk the rollback list in reverse order so
        // later writes undo before earlier ones (mirrors Postgres's
        // statement-order rollback semantics), then release locks.
        for (let i = tx.__rollbacks.length - 1; i >= 0; i--) {
          try { tx.__rollbacks[i](); } catch { /* swallow per-undo failure */ }
        }
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
      triageEnabled: col('triageEnabled'),
      name: col('name'),
      description: col('description'),
    },
    nodes: {
      __name: 'nodes',
      id: col('id'),
      mapId: col('mapId'),
      parentId: col('parentId'),
      externalLinks: col('externalLinks'),
      text: col('text'),
      description: col('description'),
      childrenOrder: col('childrenOrder'),
    },
    integrations: {
      __name: 'integrations',
      workspaceId: col('workspaceId'),
      provider: col('provider'),
      enabled: col('enabled'),
    },
    triageDecisions: {
      __name: 'triageDecisions',
      id: col('id'),
      mapId: col('mapId'),
      externalId: col('externalId'),
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

// Triage + mapContext mocks. Triage tests live in their own file with a
// fake provider; here we only care about ensureNodeForIssue's branching.
// `triageMockResponse` is the next decision the mock returns, set per
// test. `buildMapContext` returns a static minimal context — the triage
// fork uses it to validate epic UUIDs only.
let triageMockResponse: {
  decision: 'place' | 'skip' | 'uncertain';
  parentNodeId?: string;
  reason: string;
  confidence: number;
} = { decision: 'uncertain', reason: 'default-mock', confidence: 0 };
const triageMockCalls: Array<{ issueNumber: number; mapId: string }> = [];
/**
 * Optional async hook that runs INSIDE the triage mock, before it
 * returns its mocked decision. Used by the lost-race operator-protect
 * test to mutate `dbState.triageDecisions` mid-call — simulating an
 * operator hitting Confirm during the LLM window between the precheck
 * tx and the upsert tx.
 */
let triageMockMidCallHook: (() => Promise<void>) | null = null;

vi.mock('../triage.js', () => ({
  triageIssue: vi.fn(async (input: { issue: { number: number }; mapContext: { mapId: string } }) => {
    triageMockCalls.push({
      issueNumber: input.issue.number,
      mapId: input.mapContext.mapId,
    });
    if (triageMockMidCallHook) {
      await triageMockMidCallHook();
    }
    return { ...triageMockResponse };
  }),
  TRIAGE_AUTO_APPLY_CONFIDENCE: 75,
}));

const mapContextEpics = [
  { nodeId: 'epic-1', title: 'Frontend', description: 'UI' },
  { nodeId: 'epic-2', title: 'Backend', description: 'API' },
];
vi.mock('../mapContext.js', () => ({
  buildMapContext: vi.fn(async (mapId: string) => ({
    mapId,
    mapName: `map-${mapId}`,
    mapDescription: '',
    epics: mapContextEpics,
  })),
  invalidateMapContext: vi.fn(),
}));

// Hook for tests that want updateNode to throw — used by the orphan
// rollback test to simulate a failure between createNode and the end of
// the tx callback. When set, updateNode invokes this before applying
// its normal logic; the throw propagates out of the tx callback and
// triggers the rollback path.
let updateNodeThrowOnNthCall: number | null = null;
let updateNodeMockShouldThrow: ((callIndex: number) => Error | null) | null = null;

vi.mock('../../db/nodes.js', () => ({
  getNode: (id: string) => getNodeMock(id),
  createNode: async (input: Record<string, unknown>, tx?: unknown) => {
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
    // Register it in dbState.nodes so subsequent existence pre-checks see it.
    dbState.nodes.set(id, {
      id,
      mapId: input.mapId as string,
      parentId: (input.parentId as string | undefined) ?? null,
      externalLinks: [],
    });
    // If we were given a tx handle, register a rollback that removes
    // the row from dbState (and the createNodeCalls log) when the tx
    // aborts. Mirrors Postgres rolling back the INSERT.
    if (isTxHandle(tx)) {
      tx.__rollbacks.push(() => {
        dbState.nodes.delete(id);
        const idx = createNodeCalls.indexOf(input);
        if (idx >= 0) createNodeCalls.splice(idx, 1);
      });
    }
    return row;
  },
  updateNode: async (
    nodeId: string,
    input: Record<string, unknown>,
    _expectedRevision?: number,
    tx?: unknown,
  ) => {
    const callIndex = updateNodeCalls.length;
    updateNodeCalls.push({ nodeId, input });
    if (updateNodeMockShouldThrow) {
      const err = updateNodeMockShouldThrow(callIndex);
      if (err) throw err;
    }
    if (updateNodeThrowOnNthCall !== null && callIndex === updateNodeThrowOnNthCall) {
      throw new Error(`simulated updateNode failure on call ${callIndex}`);
    }
    // Snapshot the pre-update externalLinks for rollback.
    const prevRow = dbState.nodes.get(nodeId);
    const prevExternalLinks = prevRow?.externalLinks
      ? [...prevRow.externalLinks]
      : [];
    // Mirror externalLinks into dbState so the existence precheck sees them.
    if (input.externalLinks) {
      const row = dbState.nodes.get(nodeId);
      if (row) {
        row.externalLinks = input.externalLinks as Array<{ provider: string; externalId: string }>;
      }
    }
    if (isTxHandle(tx)) {
      tx.__rollbacks.push(() => {
        const row = dbState.nodes.get(nodeId);
        if (row) row.externalLinks = prevExternalLinks;
      });
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
  // Soft-delete filter. Shaped as the Pred this file's drizzle-orm mock
  // produces so `and(eq(...), notDeleted)` works. Always true — the mock
  // dbState rows don't carry a deletedAt field, so "deletedAt IS NULL" holds.
  notDeleted: { __pred: true, check: () => true },
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
  dbState.triageDecisions.clear();
  updateNodeCalls.length = 0;
  createNodeCalls.length = 0;
  advisoryLocksTaken.length = 0;
  triageMockCalls.length = 0;
  triageMockResponse = { decision: 'uncertain', reason: 'default-mock', confidence: 0 };
  nextTriageDecisionId = 1;
  getNodeMock.mockReset();
  updateNodeThrowOnNthCall = null;
  updateNodeMockShouldThrow = null;
  triageMockMidCallHook = null;
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

  it('tx rollback: throw after createNode leaves no orphan node (mindblown#66)', async () => {
    // Regression: ensureNodeForIssue used to call nodeDb.createNode and
    // nodeDb.updateNode on the global `db` handle, so each autocommitted
    // outside the outer `db.transaction(...)` that held the advisory
    // lock. Any throw between createNode and end-of-tx would leave an
    // orphan row that the rollback couldn't undo.
    //
    // After #66, both calls receive the `tx` handle and participate in
    // the outer tx. This test simulates a failure on the link-attach
    // updateNode and asserts that no row remains in dbState.nodes —
    // proving the rollback actually walked back the insert.
    dbState.maps.set('m1', { rootNodeId: 'root-1', inboxId: 'inbox-1', createdBy: 'u1' });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });

    const nodesBefore = new Set(dbState.nodes.keys());
    // Make the first updateNode call inside the tx throw (this is the
    // updateNode that attaches the externalLink + description in
    // ensureNodeForIssue). The tx callback re-throws and the mocked
    // db.transaction walks the rollback list, reverting the createNode.
    updateNodeThrowOnNthCall = 0;

    await expect(
      ensureNodeForIssue(
        'm1',
        'inbox-1',
        issue(77, { title: 'roll me back' }),
        { owner: 'owner', repo: 'repo', createdBy: 'u1' },
      ),
    ).rejects.toThrow(/simulated updateNode failure/);

    // The advisory lock was still taken (so we know we entered the tx).
    expect(advisoryLocksTaken.length).toBe(1);
    // Critically: after rollback, no NEW node row exists. Only the
    // pre-existing inbox row is in dbState.
    const nodesAfter = new Set(dbState.nodes.keys());
    expect(nodesAfter).toEqual(nodesBefore);
    // And no node has owner/repo#77 in its externalLinks (orphan check
    // via the same precheck the production path uses).
    const orphans = [...dbState.nodes.values()].filter((n) =>
      n.externalLinks.some((l) => l.provider === 'github' && l.externalId === 'owner/repo#77'),
    );
    expect(orphans).toEqual([]);
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

// ── Triage integration (#92, #93) ───────────────────────────────

describe('ensureNodeForIssue — triage fork', () => {
  const ctx = { owner: 'owner', repo: 'repo', createdBy: 'u1' };

  it('triage_enabled=false → falls through to existing inbox path (no triage call)', async () => {
    dbState.maps.set('m1', {
      rootNodeId: 'root-1',
      inboxId: 'inbox-1',
      createdBy: 'u1',
      triageEnabled: false,
    });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });

    const result = await ensureNodeForIssue('m1', 'inbox-1', issue(100), ctx);

    expect(result.status).toBe('created');
    expect(result.nodeId).toBeDefined();
    // No triage row was written.
    expect(dbState.triageDecisions.size).toBe(0);
    // The triage service was NOT called.
    expect(triageMockCalls.length).toBe(0);
    // Node was placed under the inbox, not under an epic.
    expect(createNodeCalls[0]).toMatchObject({
      mapId: 'm1',
      parentId: 'inbox-1',
    });
  });

  it('triage_enabled=true + place high-confidence → node created under suggested parent', async () => {
    dbState.maps.set('m1', {
      rootNodeId: 'root-1',
      inboxId: 'inbox-1',
      createdBy: 'u1',
      triageEnabled: true,
    });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    triageMockResponse = {
      decision: 'place',
      parentNodeId: 'epic-1',
      reason: 'matches Frontend',
      confidence: 90,
    };

    const result = await ensureNodeForIssue('m1', 'inbox-1', issue(101), ctx);

    expect(result.status).toBe('created');
    expect(result.triage).toMatchObject({
      decision: 'place',
      confidence: 90,
    });
    // Node created under the LLM-suggested epic, NOT under the inbox.
    expect(createNodeCalls.length).toBe(1);
    expect(createNodeCalls[0]).toMatchObject({
      mapId: 'm1',
      parentId: 'epic-1',
      text: '#101 Issue 101',
    });
    // Triage row persisted with decided_by='auto'.
    const rows = [...dbState.triageDecisions.values()];
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      mapId: 'm1',
      decision: 'place',
      decidedBy: 'auto',
      reviewed: false,
    });
    // placed_node_id was stamped after the node was created.
    expect(rows[0].placedNodeId).toBeDefined();
  });

  it('triage_enabled=true + place LOW-confidence → triage row persisted, NO node created', async () => {
    dbState.maps.set('m1', {
      rootNodeId: 'root-1',
      inboxId: 'inbox-1',
      createdBy: 'u1',
      triageEnabled: true,
    });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    triageMockResponse = {
      decision: 'place',
      parentNodeId: 'epic-1',
      reason: 'plausible but unsure',
      confidence: 60, // below 75 threshold
    };

    const result = await ensureNodeForIssue('m1', 'inbox-1', issue(102), ctx);

    expect(result.status).toBe('triaged_low_confidence');
    expect(result.nodeId).toBeUndefined();
    expect(createNodeCalls.length).toBe(0);
    const rows = [...dbState.triageDecisions.values()];
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      decision: 'place',
      confidence: 60,
      decidedBy: 'auto',
    });
    // placed_node_id is null since no node was created.
    expect(rows[0].placedNodeId).toBeNull();
  });

  it('triage_enabled=true + skip → triage row persisted, no node created', async () => {
    dbState.maps.set('m1', {
      rootNodeId: 'root-1',
      inboxId: 'inbox-1',
      createdBy: 'u1',
      triageEnabled: true,
    });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    triageMockResponse = {
      decision: 'skip',
      reason: 'closed bug, unrelated component',
      confidence: 92,
    };

    const result = await ensureNodeForIssue('m1', 'inbox-1', issue(103), ctx);

    expect(result.status).toBe('triaged_skip');
    expect(createNodeCalls.length).toBe(0);
    const rows = [...dbState.triageDecisions.values()];
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ decision: 'skip' });
  });

  it('triage_enabled=true + uncertain → triage row persisted, no node created', async () => {
    dbState.maps.set('m1', {
      rootNodeId: 'root-1',
      inboxId: 'inbox-1',
      createdBy: 'u1',
      triageEnabled: true,
    });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    triageMockResponse = {
      decision: 'uncertain',
      reason: "couldn't decide",
      confidence: 40,
    };

    const result = await ensureNodeForIssue('m1', 'inbox-1', issue(104), ctx);

    expect(result.status).toBe('triaged_uncertain');
    expect(createNodeCalls.length).toBe(0);
    const rows = [...dbState.triageDecisions.values()];
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ decision: 'uncertain' });
  });

  it('idempotent: a triaged issue already linked to a node short-circuits to skipped_exists', async () => {
    dbState.maps.set('m1', {
      rootNodeId: 'root-1',
      inboxId: 'inbox-1',
      createdBy: 'u1',
      triageEnabled: true,
    });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    dbState.nodes.set('preexisting', {
      id: 'preexisting',
      mapId: 'm1',
      parentId: 'epic-1',
      externalLinks: [{ provider: 'github', externalId: 'owner/repo#105' }],
    });

    const result = await ensureNodeForIssue('m1', 'inbox-1', issue(105), ctx);

    expect(result.status).toBe('skipped_exists');
    // Triage was NOT called — the precheck short-circuited before paying
    // LLM tokens.
    expect(triageMockCalls.length).toBe(0);
    expect(dbState.triageDecisions.size).toBe(0);
  });

  // mindblown#99 fix 2 — `issues.edited` (or any re-triage trigger)
  // must NOT wipe `reviewed=true, decidedBy='operator'`. The fix
  // short-circuits BEFORE the LLM call, so we also assert the triage
  // mock was never invoked.
  it('operator-reviewed row: re-triage short-circuits, NO LLM call, row unchanged', async () => {
    dbState.maps.set('m1', {
      rootNodeId: 'root-1',
      inboxId: 'inbox-1',
      createdBy: 'u1',
      triageEnabled: true,
    });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    // Seed an existing operator-reviewed decision row.
    dbState.triageDecisions.set('curated', {
      id: 'curated',
      mapId: 'm1',
      externalId: 'owner/repo#200',
      issueTitle: 'My carefully-curated decision',
      issueState: 'open',
      decision: 'skip',
      reason: 'operator says no',
      confidence: 100,
      placedNodeId: null,
      decidedAt: new Date('2026-01-01T00:00:00Z'),
      decidedBy: 'operator',
      reviewed: true,
      reviewedAt: new Date('2026-01-01T00:00:00Z'),
      reviewedBy: 'u1',
    });
    // Whatever the LLM would have said — if we call it, the test fails.
    triageMockResponse = {
      decision: 'place',
      parentNodeId: 'epic-1',
      reason: 'fresh take',
      confidence: 90,
    };

    const result = await ensureNodeForIssue('m1', 'inbox-1', issue(200, { title: 'edited title' }), ctx);

    // We treat operator-reviewed `skip` as the live answer.
    expect(result.status).toBe('triaged_skip');
    // LLM was NOT called — the precheck short-circuited.
    expect(triageMockCalls.length).toBe(0);
    // The decision row is untouched (still operator-reviewed, still skip).
    const curated = dbState.triageDecisions.get('curated')!;
    expect(curated.decision).toBe('skip');
    expect(curated.decidedBy).toBe('operator');
    expect(curated.reviewed).toBe(true);
    expect(curated.reason).toBe('operator says no');
    // No node was created.
    expect(createNodeCalls.length).toBe(0);
  });

  it('operator-reviewed place row: re-triage returns the placed node, NO LLM call', async () => {
    dbState.maps.set('m1', {
      rootNodeId: 'root-1',
      inboxId: 'inbox-1',
      createdBy: 'u1',
      triageEnabled: true,
    });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    // The placed node is what an operator put under epic-1.
    dbState.nodes.set('curated-node', {
      id: 'curated-node',
      mapId: 'm1',
      parentId: 'epic-1',
      externalLinks: [], // Note: no externalLink (legacy migration scenario)
    });
    dbState.triageDecisions.set('curated', {
      id: 'curated',
      mapId: 'm1',
      externalId: 'owner/repo#201',
      issueTitle: 'op-placed',
      issueState: 'open',
      decision: 'place',
      reason: 'operator chose epic-1',
      confidence: 100,
      placedNodeId: 'curated-node',
      decidedAt: new Date(),
      decidedBy: 'operator',
      reviewed: true,
      reviewedAt: new Date(),
      reviewedBy: 'u1',
    });
    triageMockResponse = {
      decision: 'skip',
      reason: 'never',
      confidence: 90,
    };

    const result = await ensureNodeForIssue('m1', 'inbox-1', issue(201), ctx);

    expect(result.status).toBe('created');
    expect(result.nodeId).toBe('curated-node');
    expect(triageMockCalls.length).toBe(0);
    expect(createNodeCalls.length).toBe(0);
  });

  // #100 Round 2 — lost-race operator-protect. The precheck tx checks
  // "operator-reviewed row exists" but the upsert tx (previously) only
  // re-checked "node exists." If an operator marks the row reviewed
  // during the LLM-call window, the upsert's SET clause wipes the
  // operator decision. The fix mirrors the operator-reviewed precheck
  // INSIDE the upsert tx and short-circuits if it fires.
  it('lost-race operator-protect: operator marks reviewed mid-LLM, upsert does NOT overwrite', async () => {
    dbState.maps.set('m1', {
      rootNodeId: 'root-1',
      inboxId: 'inbox-1',
      createdBy: 'u1',
      triageEnabled: true,
    });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    // Seed an existing auto-decided row (operator hasn't reviewed yet).
    // The precheck tx will see this as "proceed" and pay for the LLM.
    dbState.triageDecisions.set('pending', {
      id: 'pending',
      mapId: 'm1',
      externalId: 'owner/repo#250',
      issueTitle: 'a candidate',
      issueState: 'open',
      decision: 'uncertain',
      reason: 'auto unsure',
      confidence: 40,
      placedNodeId: null,
      decidedAt: new Date('2026-01-01T00:00:00Z'),
      decidedBy: 'auto',
      reviewed: false,
      reviewedAt: null,
      reviewedBy: null,
    });
    // The LLM call returns "place" — without the fix, the upsert would
    // happily clobber the operator's decision below.
    triageMockResponse = {
      decision: 'place',
      parentNodeId: 'epic-1',
      reason: 'fresh take from the model',
      confidence: 92,
    };
    // Simulate an operator hitting Confirm DURING the LLM call window:
    // mutate the existing decision row to reviewed=true,
    // decidedBy='operator', decision='skip'. This is what the operator
    // would have written.
    triageMockMidCallHook = async () => {
      const row = dbState.triageDecisions.get('pending')!;
      row.reviewed = true;
      row.decidedBy = 'operator';
      row.decision = 'skip';
      row.reason = 'operator vetoed';
      row.reviewedAt = new Date('2026-01-02T00:00:00Z');
      row.reviewedBy = 'u1';
    };

    const result = await ensureNodeForIssue('m1', 'inbox-1', issue(250), ctx);

    // The LLM was called (cost already sunk before the operator click)
    expect(triageMockCalls.length).toBe(1);
    // ...but the upsert tx detected the operator-reviewed flip and
    // returned the operator's decision instead of overwriting it.
    expect(result.status).toBe('triaged_skip');
    // Decision row is operator's, NOT auto.
    const row = dbState.triageDecisions.get('pending')!;
    expect(row.decision).toBe('skip');
    expect(row.decidedBy).toBe('operator');
    expect(row.reviewed).toBe(true);
    expect(row.reason).toBe('operator vetoed');
    expect(row.confidence).toBe(40); // un-clobbered
    // No node was created (operator said skip).
    expect(createNodeCalls.length).toBe(0);
  });

  // mindblown#99 fix 1 — race safety in the triage path. Two parallel
  // calls on a triage_enabled map serialize on the advisory lock; the
  // second observes the first's just-committed node and short-circuits
  // to skipped_exists. Exactly one node + one triage_decisions row.
  it('race safety in triage path: parallel calls create exactly one node + one decision row', async () => {
    dbState.maps.set('m1', {
      rootNodeId: 'root-1',
      inboxId: 'inbox-1',
      createdBy: 'u1',
      triageEnabled: true,
    });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    triageMockResponse = {
      decision: 'place',
      parentNodeId: 'epic-1',
      reason: 'matches Frontend',
      confidence: 90,
    };

    const [a, b] = await Promise.all([
      ensureNodeForIssue('m1', 'inbox-1', issue(202), ctx),
      ensureNodeForIssue('m1', 'inbox-1', issue(202), ctx),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['created', 'skipped_exists']);
    // Exactly one create across the two calls.
    expect(createNodeCalls.length).toBe(1);
    // The triage path took the advisory lock at least twice (once per
    // call — actually four times because the path takes the lock for
    // both the precheck tx AND the upsert tx). Either way, the lock
    // infra was exercised, not bypassed.
    expect(advisoryLocksTaken.length).toBeGreaterThanOrEqual(2);
    // Exactly one triage_decisions row materialised across the two calls.
    expect(dbState.triageDecisions.size).toBe(1);
  });

  // mindblown#99 fix 5 — when the caller passes triageEnabled in opts,
  // the function MUST NOT issue an extra `SELECT maps.triage_enabled`
  // per issue. We can't easily count SELECTs against the maps table
  // from the mock infra, but we CAN assert the fast-path behaviour
  // works: a map with NO entry in dbState.maps but explicit
  // triageEnabled=true in opts should still hit the triage fork.
  it('opts.triageEnabled overrides the per-issue maps SELECT', async () => {
    // Note: dbState.maps does NOT contain m1 — so the fallback SELECT
    // would return no row, and triageEnabled would be false. Passing
    // it via opts must override that.
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    triageMockResponse = {
      decision: 'place',
      parentNodeId: 'epic-1',
      reason: 'matches',
      confidence: 90,
    };

    const result = await ensureNodeForIssue(
      'm1',
      'inbox-1',
      issue(300, { title: 'fast-path' }),
      ctx,
      { triageEnabled: true },
    );

    expect(result.status).toBe('created');
    expect(result.triage?.decision).toBe('place');
    // The triage path was entered — proves opts.triageEnabled won
    // without us populating dbState.maps.
    expect(triageMockCalls.length).toBe(1);
  });

  it('triage_enabled=true + place high-confidence with invalid parent UUID → downgrades to uncertain', async () => {
    dbState.maps.set('m1', {
      rootNodeId: 'root-1',
      inboxId: 'inbox-1',
      createdBy: 'u1',
      triageEnabled: true,
    });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    // LLM returned a UUID that isn't in the offered epics list. Triage
    // is supposed to downgrade these to uncertain itself, but the
    // ingest pipeline runs the same check as belt-and-braces.
    triageMockResponse = {
      decision: 'place',
      parentNodeId: 'epic-NEVER',
      reason: 'I made this up',
      confidence: 95,
    };

    const result = await ensureNodeForIssue('m1', 'inbox-1', issue(106), ctx);

    expect(result.status).toBe('triaged_uncertain');
    expect(createNodeCalls.length).toBe(0);
    const rows = [...dbState.triageDecisions.values()];
    expect(rows[0]).toMatchObject({ decision: 'uncertain' });
  });
});
