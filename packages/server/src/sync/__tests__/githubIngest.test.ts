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
  // Versions rows. Populated by individual tests that exercise the
  // release-lane routing path in ensureNodeForIssue.
  versions: Array<{ id: string; mapId: string; name: string; status: string; sortOrder: number }>;
};
const dbState: DbState = {
  maps: new Map(),
  nodes: new Map(),
  integrations: [],
  triageDecisions: new Map(),
  versions: [],
};

// Counter for generating triage decision ids.
let nextTriageDecisionId = 1;

// Track update calls for assertions
const updateNodeCalls: Array<{ nodeId: string; input: Record<string, unknown> }> = [];
const moveNodeCalls: Array<{ nodeId: string; newParentId: string }> = [];
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
    } else if (step.table === 'versions') {
      rows = dbState.versions.map((v) => ({ ...v }));
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
      lastInputHash: col('lastInputHash'),
    },
    // Release-lane resolver lookups select against this table.
    versions: {
      __name: 'versions',
      id: col('id'),
      mapId: col('mapId'),
      name: col('name'),
      status: col('status'),
      sortOrder: col('sortOrder'),
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
    ne: (column: { __col?: string }, value: unknown): Pred => ({
      __pred: true,
      check: (row) => row[column.__col ?? ''] !== value,
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

// In-memory state for the cost-opt #142 debounce + hash mocks. The
// production module keeps its own Map; we mirror just enough of the
// behaviour here so callers (the SUT) can short-circuit predictably.
// Tests reset this state in `beforeEach`.
const _debounceState = new Map<string, number>();
let _debounceWindowMs = 0; // 0 disables debounce by default in tests
function debounceKey(mapId: string, externalId: string): string {
  return `${mapId}/${externalId}`;
}

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
  TRIAGE_AUTO_CONFIRM_SKIP_CONFIDENCE: 95,
  // Mirror the real gate (skip + closed + conf >= 95) so ingest tests
  // exercise the auto-confirm lever without importing the real module.
  shouldAutoConfirmSkip: vi.fn(
    (
      decision: { decision: string; confidence: number },
      issueState: 'open' | 'closed',
    ) =>
      decision.decision === 'skip' &&
      issueState === 'closed' &&
      decision.confidence >= 95,
  ),
  // #142 cost-opt helpers. computeInputHash returns a deterministic
  // string derived from the issue inputs so hash-match tests can
  // pre-seed dbState.triageDecisions.lastInputHash with the same
  // value the SUT will compute.
  computeInputHash: vi.fn((issue: {
    title: string;
    body?: string | null;
    state: 'open' | 'closed';
    labels?: Array<{ name: string }> | null;
  }) => {
    const labels = (issue.labels ?? []).map((l) => l.name).slice().sort();
    return `hash:${issue.title}:${issue.body ?? ''}:${labels.join(',')}:${issue.state}`;
  }),
  isWithinDebounceWindow: vi.fn((mapId: string, externalId: string, now: number = Date.now()) => {
    if (_debounceWindowMs <= 0) return false;
    const lastAt = _debounceState.get(debounceKey(mapId, externalId));
    if (lastAt === undefined) return false;
    return now - lastAt < _debounceWindowMs;
  }),
  markTriageDebounce: vi.fn((mapId: string, externalId: string, now: number = Date.now()) => {
    if (_debounceWindowMs <= 0) return;
    _debounceState.set(debounceKey(mapId, externalId), now);
  }),
  clearTriageDebounce: vi.fn((mapId: string, externalId: string) => {
    _debounceState.delete(debounceKey(mapId, externalId));
  }),
}));

// Helpers exposed for cost-opt tests below — they configure the
// mock's debounce window and read/seed its internal map without
// importing the SUT module.
function _testSetDebounceWindowMs(ms: number): void {
  _debounceWindowMs = ms;
}
function _testResetDebounceState(): void {
  _debounceState.clear();
  _debounceWindowMs = 0;
}
function _testSeedDebounce(mapId: string, externalId: string, ts: number): void {
  _debounceState.set(debounceKey(mapId, externalId), ts);
}

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
    versions: [],
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
  moveNode: async (nodeId: string, newParentId: string) => {
    moveNodeCalls.push({ nodeId, newParentId });
    const row = dbState.nodes.get(nodeId);
    if (!row) return null;
    row.parentId = newParentId;
    return { id: nodeId, parentId: newParentId } as never;
  },
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
      attachments: [],
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
  ghLabelsToTags,
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
  dbState.versions = [];
  moveNodeCalls.length = 0;
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
  // #142 cost-opt — clear debounce state between tests so a stamp
  // from one case doesn't leak into the next.
  _testResetDebounceState();
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

  // Release-lane routing: a freshly ingested node defaults into the
  // map's active lane (highest sortOrder among status='active') so it
  // is visible to the dispatch queue instead of landing in the
  // Unversioned bucket. Replaced the milestone-title routing, which
  // was dead code in practice (0/1200 sampled issues carried a GH
  // milestone).
  it('routes a new node into the active lane with the highest sortOrder', async () => {
    dbState.maps.set('m1', { rootNodeId: 'root-1', inboxId: 'inbox-1', createdBy: 'u1' });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    dbState.versions.push(
      { id: 'v1-uuid', mapId: 'm1', name: 'V1', status: 'active', sortOrder: 10 },
      { id: 'v15-uuid', mapId: 'm1', name: 'V1.5', status: 'active', sortOrder: 15 },
      { id: 'v2-uuid', mapId: 'm1', name: 'V2', status: 'planning', sortOrder: 20 },
    );

    await ensureNodeForIssue(
      'm1',
      'inbox-1',
      issue(101, { title: 'route me' }),
      { owner: 'owner', repo: 'repo', createdBy: 'u1' },
    );

    const updateCall = updateNodeCalls.find((c) => c.input.externalLinks);
    expect(updateCall?.input.versionId).toBe('v15-uuid');
  });

  it('leaves versionId unset when the map has no active lane', async () => {
    dbState.maps.set('m1', { rootNodeId: 'root-1', inboxId: 'inbox-1', createdBy: 'u1' });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    dbState.versions.push(
      { id: 'v2-uuid', mapId: 'm1', name: 'V2', status: 'planning', sortOrder: 20 },
    );

    await ensureNodeForIssue(
      'm1',
      'inbox-1',
      issue(102, { title: 'planning-only map' }),
      { owner: 'owner', repo: 'repo', createdBy: 'u1' },
    );

    const updateCall = updateNodeCalls.find((c) => c.input.externalLinks);
    expect('versionId' in (updateCall?.input ?? {})).toBe(false);
  });

  it("ignores another map's active lane", async () => {
    dbState.maps.set('m1', { rootNodeId: 'root-1', inboxId: 'inbox-1', createdBy: 'u1' });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    dbState.versions.push(
      { id: 'other-uuid', mapId: 'OTHER', name: 'V9', status: 'active', sortOrder: 90 },
    );

    await ensureNodeForIssue(
      'm1',
      'inbox-1',
      issue(103, { title: 'foreign lane' }),
      { owner: 'owner', repo: 'repo', createdBy: 'u1' },
    );

    const updateCall = updateNodeCalls.find((c) => c.input.externalLinks);
    expect('versionId' in (updateCall?.input ?? {})).toBe(false);
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
    // suggested_parent_node_id mirrors the LLM's pick — set on every
    // place decision, regardless of confidence / auto-apply outcome.
    // Same column the Override modal later pre-selects from on
    // low-confidence places.
    expect(rows[0].suggestedParentNodeId).toBe('epic-1');
  });

  it('triage_enabled=true + place LOW-confidence → row persisted, node PARKED under the Inbox', async () => {
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

    // Inbox fallback: the decision is persisted for review AND a node
    // is parked under the Inbox — the review queue demonstrably never
    // drains, and an invisible ticket is a buried ticket.
    expect(result.status).toBe('created');
    expect(result.triage?.decision).toBe('place');
    expect(createNodeCalls.length).toBe(1);
    expect(createNodeCalls[0].parentId).toBe('inbox-1');
    const rows = [...dbState.triageDecisions.values()];
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      decision: 'place',
      confidence: 60,
      decidedBy: 'auto',
    });
    // placed_node_id points at the parked node.
    expect(rows[0].placedNodeId).toBe(result.nodeId);
    // suggested_parent_node_id still carries the LLM's pick — the
    // Override modal pre-selects it when the operator re-routes the
    // parked node out of the Inbox.
    expect(rows[0].suggestedParentNodeId).toBe('epic-1');
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
    expect(rows[0]).toMatchObject({ decision: 'skip', reviewed: false });
  });

  it('skip ≥95 on a CLOSED issue → persisted already-reviewed (auto-confirm lever)', async () => {
    dbState.maps.set('m1', {
      rootNodeId: 'root-1',
      inboxId: 'inbox-1',
      createdBy: 'u1',
      triageEnabled: true,
    });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    triageMockResponse = {
      decision: 'skip',
      reason: 'Pattern 1 (closed-no-fit): tactical PR below roadmap granularity',
      confidence: 96,
    };

    const result = await ensureNodeForIssue(
      'm1',
      'inbox-1',
      issue(104, { state: 'closed', closed_at: new Date().toISOString() }),
      ctx,
      { allowClosedWithinDays: 30 },
    );

    expect(result.status).toBe('triaged_skip');
    expect(createNodeCalls.length).toBe(0);
    const rows = [...dbState.triageDecisions.values()];
    expect(rows.length).toBe(1);
    // reviewed=true at persist time, but decidedBy stays 'auto' so a
    // later webhook or reclassify can still overwrite the row.
    expect(rows[0]).toMatchObject({
      decision: 'skip',
      reviewed: true,
      decidedBy: 'auto',
    });
    expect(rows[0].reviewedAt).toBeInstanceOf(Date);
  });

  it('skip ≥95 on an OPEN issue → still queues for review (lever is closed-only)', async () => {
    dbState.maps.set('m1', {
      rootNodeId: 'root-1',
      inboxId: 'inbox-1',
      createdBy: 'u1',
      triageEnabled: true,
    });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    triageMockResponse = {
      decision: 'skip',
      reason: 'vendor coordination, not coding work',
      confidence: 98,
    };

    const result = await ensureNodeForIssue('m1', 'inbox-1', issue(105), ctx);

    expect(result.status).toBe('triaged_skip');
    const rows = [...dbState.triageDecisions.values()];
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ decision: 'skip', reviewed: false });
  });

  it('skip at 94 on a CLOSED issue → below threshold, queues for review', async () => {
    dbState.maps.set('m1', {
      rootNodeId: 'root-1',
      inboxId: 'inbox-1',
      createdBy: 'u1',
      triageEnabled: true,
    });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    triageMockResponse = {
      decision: 'skip',
      reason: 'probably noise but not certain',
      confidence: 94,
    };

    const result = await ensureNodeForIssue(
      'm1',
      'inbox-1',
      issue(106, { state: 'closed', closed_at: new Date().toISOString() }),
      ctx,
      { allowClosedWithinDays: 30 },
    );

    expect(result.status).toBe('triaged_skip');
    const rows = [...dbState.triageDecisions.values()];
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ decision: 'skip', reviewed: false });
  });

  it('triage_enabled=true + uncertain → row persisted, node PARKED under the Inbox', async () => {
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

    expect(result.status).toBe('created');
    expect(result.triage?.decision).toBe('uncertain');
    expect(createNodeCalls.length).toBe(1);
    expect(createNodeCalls[0].parentId).toBe('inbox-1');
    const rows = [...dbState.triageDecisions.values()];
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ decision: 'uncertain' });
    expect(rows[0].placedNodeId).toBe(result.nodeId);
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

    // Downgraded to uncertain → parked under the Inbox like any other
    // uncertain decision. Crucially NOT auto-placed under the
    // hallucinated parent.
    expect(result.status).toBe('created');
    expect(result.triage?.decision).toBe('uncertain');
    expect(createNodeCalls.length).toBe(1);
    expect(createNodeCalls[0].parentId).toBe('inbox-1');
    const rows = [...dbState.triageDecisions.values()];
    expect(rows[0]).toMatchObject({ decision: 'uncertain' });
  });
});

// ── #142 cost-opt — hash-match + debounce short-circuits ─────────

describe('ensureNodeForIssue — triage cost-opt (#142)', () => {
  const ctx = { owner: 'owner', repo: 'repo', createdBy: 'u1' };

  function seedTriageMap(): void {
    dbState.maps.set('m1', {
      rootNodeId: 'root-1',
      inboxId: 'inbox-1',
      createdBy: 'u1',
      triageEnabled: true,
    });
    dbState.nodes.set('inbox-1', {
      id: 'inbox-1',
      mapId: 'm1',
      parentId: 'root-1',
      externalLinks: [],
    });
  }

  // The mocked computeInputHash returns
  // `hash:${title}:${body ?? ''}:${labels.sorted.join(',')}:${state}`.
  // Tests pre-seed `lastInputHash` with the same shape so the SUT
  // matches on the hash-match precheck path.
  function expectedHash(iss: GitHubIssue): string {
    const labels = (iss.labels ?? []).map((l) => l.name).slice().sort();
    return `hash:${iss.title}:${iss.body ?? ''}:${labels.join(',')}:${iss.state}`;
  }

  // ── Body-hash idempotency ────────────────────────────────────

  it('hash-match precheck → SKIPS LLM call, bumps decided_at, returns triaged_hash_match', async () => {
    seedTriageMap();
    const iss = issue(200, { title: 'cached', body: 'body-A' });
    // Pre-seed an existing decision whose lastInputHash equals the
    // hash the SUT will compute for `iss`.
    const oldDecidedAt = new Date(2020, 0, 1);
    dbState.triageDecisions.set('triage-pre', {
      id: 'triage-pre',
      mapId: 'm1',
      externalId: 'owner/repo#200',
      issueTitle: 'cached',
      issueState: 'open',
      decision: 'skip',
      reason: 'unrelated',
      confidence: 80,
      placedNodeId: null,
      suggestedParentNodeId: null,
      decidedAt: oldDecidedAt,
      decidedBy: 'auto',
      reviewed: false,
      lastInputHash: expectedHash(iss),
    });

    const result = await ensureNodeForIssue('m1', 'inbox-1', iss, ctx);

    expect(result.status).toBe('triaged_hash_match');
    expect(result.triage?.decisionId).toBe('triage-pre');
    expect(result.triage?.decision).toBe('skip');
    expect(result.triage?.confidence).toBe(80);
    // LLM was NOT called.
    expect(triageMockCalls.length).toBe(0);
    // decided_at was bumped (the hash-match path runs an UPDATE on
    // the existing row inside the precheck tx).
    const row = dbState.triageDecisions.get('triage-pre')!;
    expect((row.decidedAt as Date).getTime()).toBeGreaterThan(oldDecidedAt.getTime());
    // No node was created (decision is skip).
    expect(createNodeCalls.length).toBe(0);
  });

  it('hash-match on a node-less UNCERTAIN row → lazy Inbox parking, no LLM call', async () => {
    // The pre-existing backlog of node-less uncertain rows must drain:
    // their text never changes, so every webhook lands here — parking
    // uses the STORED decision, no LLM round-trip.
    seedTriageMap();
    const iss = issue(206, { title: 'backlog issue', body: 'unchanged' });
    dbState.triageDecisions.set('triage-backlog', {
      id: 'triage-backlog',
      mapId: 'm1',
      externalId: 'owner/repo#206',
      issueTitle: 'backlog issue',
      issueState: 'open',
      decision: 'uncertain',
      reason: 'could be anything',
      confidence: 40,
      placedNodeId: null,
      suggestedParentNodeId: null,
      decidedAt: new Date(2020, 0, 1),
      decidedBy: 'auto',
      reviewed: false,
      lastInputHash: expectedHash(iss),
    });

    const result = await ensureNodeForIssue('m1', 'inbox-1', iss, ctx);

    expect(result.status).toBe('created');
    expect(triageMockCalls.length).toBe(0);
    expect(createNodeCalls.length).toBe(1);
    expect(createNodeCalls[0].parentId).toBe('inbox-1');
    const row = dbState.triageDecisions.get('triage-backlog')!;
    expect(row.placedNodeId).toBe(result.nodeId);
  });

  it('hash-mismatch → LLM call runs, new hash is persisted on the row', async () => {
    seedTriageMap();
    triageMockResponse = {
      decision: 'skip',
      reason: 'unrelated',
      confidence: 80,
    };
    const iss = issue(201, { title: 'new content', body: 'fresh body' });
    dbState.triageDecisions.set('triage-stale', {
      id: 'triage-stale',
      mapId: 'm1',
      externalId: 'owner/repo#201',
      issueTitle: 'old',
      issueState: 'open',
      decision: 'skip',
      reason: 'old reason',
      confidence: 60,
      placedNodeId: null,
      suggestedParentNodeId: null,
      decidedAt: new Date(2020, 0, 1),
      decidedBy: 'auto',
      reviewed: false,
      lastInputHash: 'hash:stale:::open', // intentionally different
    });

    const result = await ensureNodeForIssue('m1', 'inbox-1', iss, ctx);

    expect(result.status).toBe('triaged_skip');
    // LLM was called exactly once.
    expect(triageMockCalls.length).toBe(1);
    // The row's hash was overwritten with the new content's hash.
    const row = dbState.triageDecisions.get('triage-stale')!;
    expect(row.lastInputHash).toBe(expectedHash(iss));
  });

  it('null lastInputHash (legacy / never-triaged row) → LLM call runs, hash is populated', async () => {
    seedTriageMap();
    triageMockResponse = {
      decision: 'skip',
      reason: 'unrelated',
      confidence: 80,
    };
    const iss = issue(202, { title: 'untouched legacy' });
    dbState.triageDecisions.set('triage-legacy', {
      id: 'triage-legacy',
      mapId: 'm1',
      externalId: 'owner/repo#202',
      issueTitle: 'untouched legacy',
      issueState: 'open',
      decision: 'skip',
      reason: 'r',
      confidence: 50,
      placedNodeId: null,
      suggestedParentNodeId: null,
      decidedAt: new Date(),
      decidedBy: 'auto',
      reviewed: false,
      lastInputHash: null,
    });

    const result = await ensureNodeForIssue('m1', 'inbox-1', iss, ctx);

    expect(result.status).toBe('triaged_skip');
    expect(triageMockCalls.length).toBe(1);
    const row = dbState.triageDecisions.get('triage-legacy')!;
    expect(row.lastInputHash).toBe(expectedHash(iss));
  });

  it('first-time triage (no existing row) → LLM call runs, hash is persisted on insert', async () => {
    seedTriageMap();
    triageMockResponse = {
      decision: 'skip',
      reason: 'unrelated',
      confidence: 80,
    };
    const iss = issue(203);

    const result = await ensureNodeForIssue('m1', 'inbox-1', iss, ctx);

    expect(result.status).toBe('triaged_skip');
    expect(triageMockCalls.length).toBe(1);
    const rows = [...dbState.triageDecisions.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].lastInputHash).toBe(expectedHash(iss));
  });

  it('triage_error → hash is NOT persisted (so the next webhook retries the LLM)', async () => {
    seedTriageMap();
    triageMockResponse = {
      decision: 'uncertain',
      reason: 'triage_error: upstream 503',
      confidence: 0,
    };
    const iss = issue(204);

    const result = await ensureNodeForIssue('m1', 'inbox-1', iss, ctx);

    const rows = [...dbState.triageDecisions.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].lastInputHash).toBeNull();
    // And no Inbox parking either: a parked node would make the
    // node-existence precheck skip every future triage of this issue,
    // freezing the transient LLM error in place.
    expect(result.status).toBe('triaged_uncertain');
    expect(createNodeCalls.length).toBe(0);
  });

  it('a parked node GRADUATES when re-triage turns high-confidence', async () => {
    dbState.maps.set('m1', {
      rootNodeId: 'root-1',
      inboxId: 'inbox-1',
      createdBy: 'u1',
      triageEnabled: true,
    });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    // Previously parked node for this issue, sitting under the Inbox.
    dbState.nodes.set('parked-1', {
      id: 'parked-1',
      mapId: 'm1',
      parentId: 'inbox-1',
      externalLinks: [{ provider: 'github', externalId: 'owner/repo#301' }],
    });
    triageMockResponse = {
      decision: 'place',
      parentNodeId: 'epic-1',
      reason: 'body was clarified',
      confidence: 95,
    };

    const result = await ensureNodeForIssue('m1', 'inbox-1', issue(301), ctx);

    expect(result.status).toBe('created');
    expect(result.nodeId).toBe('parked-1');
    // Graduation MOVES the parked node — no duplicate is created.
    expect(createNodeCalls.length).toBe(0);
    expect(moveNodeCalls).toEqual([{ nodeId: 'parked-1', newParentId: 'epic-1' }]);
  });

  it('a parked node stays parked (no duplicate) when re-triage is still uncertain', async () => {
    dbState.maps.set('m1', {
      rootNodeId: 'root-1',
      inboxId: 'inbox-1',
      createdBy: 'u1',
      triageEnabled: true,
    });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    dbState.nodes.set('parked-2', {
      id: 'parked-2',
      mapId: 'm1',
      parentId: 'inbox-1',
      externalLinks: [{ provider: 'github', externalId: 'owner/repo#302' }],
    });
    triageMockResponse = {
      decision: 'uncertain',
      reason: 'still unclear',
      confidence: 45,
    };

    const result = await ensureNodeForIssue('m1', 'inbox-1', issue(302), ctx);

    expect(result.status).toBe('triaged_uncertain');
    expect(result.nodeId).toBe('parked-2');
    expect(createNodeCalls.length).toBe(0);
    expect(moveNodeCalls.length).toBe(0);
  });

  it('a NON-parked existing node still short-circuits to skipped_exists', async () => {
    dbState.maps.set('m1', {
      rootNodeId: 'root-1',
      inboxId: 'inbox-1',
      createdBy: 'u1',
      triageEnabled: true,
    });
    dbState.nodes.set('inbox-1', { id: 'inbox-1', mapId: 'm1', parentId: 'root-1', externalLinks: [] });
    dbState.nodes.set('placed-1', {
      id: 'placed-1',
      mapId: 'm1',
      parentId: 'epic-1',
      externalLinks: [{ provider: 'github', externalId: 'owner/repo#303' }],
    });

    const result = await ensureNodeForIssue('m1', 'inbox-1', issue(303), ctx);

    expect(result.status).toBe('skipped_exists');
    expect(triageMockCalls.length).toBe(0);
  });

  it('closed issue + uncertain → decision-only, no Inbox parking', async () => {
    seedTriageMap();
    triageMockResponse = {
      decision: 'uncertain',
      reason: 'could be anything',
      confidence: 40,
    };

    const result = await ensureNodeForIssue(
      'm1',
      'inbox-1',
      issue(207, { state: 'closed', closed_at: new Date().toISOString() }),
      ctx,
      { allowClosedWithinDays: 30 },
    );

    expect(result.status).toBe('triaged_uncertain');
    expect(createNodeCalls.length).toBe(0);
  });

  // ── Per-issue debounce window ───────────────────────────────

  it('within debounce window → short-circuit BEFORE precheck tx, no LLM call, no DB write', async () => {
    seedTriageMap();
    _testSetDebounceWindowMs(60_000);
    _testSeedDebounce('m1', 'owner/repo#205', Date.now());

    const result = await ensureNodeForIssue('m1', 'inbox-1', issue(205), ctx);

    expect(result.status).toBe('triaged_debounced');
    // Neither the LLM nor the precheck tx ran.
    expect(triageMockCalls.length).toBe(0);
    expect(dbState.triageDecisions.size).toBe(0);
    expect(advisoryLocksTaken.length).toBe(0);
  });

  it('past the debounce window → LLM call runs', async () => {
    seedTriageMap();
    triageMockResponse = {
      decision: 'skip',
      reason: 'unrelated',
      confidence: 80,
    };
    _testSetDebounceWindowMs(60_000);
    // Stamp the debounce well outside the window.
    _testSeedDebounce('m1', 'owner/repo#206', Date.now() - 120_000);

    const result = await ensureNodeForIssue('m1', 'inbox-1', issue(206), ctx);

    expect(result.status).toBe('triaged_skip');
    expect(triageMockCalls.length).toBe(1);
  });

  it('successful LLM call stamps the debounce → second call within window is debounced', async () => {
    seedTriageMap();
    triageMockResponse = {
      decision: 'skip',
      reason: 'unrelated',
      confidence: 80,
    };
    _testSetDebounceWindowMs(60_000);
    const iss = issue(207, { body: 'a' });

    const first = await ensureNodeForIssue('m1', 'inbox-1', iss, ctx);
    expect(first.status).toBe('triaged_skip');
    expect(triageMockCalls.length).toBe(1);

    // Same externalId, different content (so the hash short-circuit
    // wouldn't fire either). Debounce should still squash it.
    const second = await ensureNodeForIssue(
      'm1',
      'inbox-1',
      issue(207, { body: 'b' }),
      ctx,
    );
    expect(second.status).toBe('triaged_debounced');
    expect(triageMockCalls.length).toBe(1); // unchanged
  });

  it('hash-match path stamps the debounce so a burst rides on the single short-circuit', async () => {
    seedTriageMap();
    _testSetDebounceWindowMs(60_000);
    const iss = issue(208, { title: 'hot' });
    dbState.triageDecisions.set('triage-hot', {
      id: 'triage-hot',
      mapId: 'm1',
      externalId: 'owner/repo#208',
      issueTitle: 'hot',
      issueState: 'open',
      decision: 'skip',
      reason: 'r',
      confidence: 80,
      placedNodeId: null,
      suggestedParentNodeId: null,
      decidedAt: new Date(2020, 0, 1),
      decidedBy: 'auto',
      reviewed: false,
      lastInputHash: expectedHash(iss),
    });

    const first = await ensureNodeForIssue('m1', 'inbox-1', iss, ctx);
    expect(first.status).toBe('triaged_hash_match');

    // A second-burst delivery with DIFFERENT content (would normally
    // call LLM) is squashed by the debounce that the hash-match path
    // stamped.
    const second = await ensureNodeForIssue(
      'm1',
      'inbox-1',
      issue(208, { title: 'hot', body: 'new body' }),
      ctx,
    );
    expect(second.status).toBe('triaged_debounced');
    // LLM never called across the whole burst.
    expect(triageMockCalls.length).toBe(0);
  });

  it('triage_error → does NOT stamp the debounce (so retry can happen)', async () => {
    seedTriageMap();
    triageMockResponse = {
      decision: 'uncertain',
      reason: 'triage_error: upstream 503',
      confidence: 0,
    };
    _testSetDebounceWindowMs(60_000);

    const first = await ensureNodeForIssue('m1', 'inbox-1', issue(209), ctx);
    expect(first.status).toBe('triaged_uncertain');
    expect(triageMockCalls.length).toBe(1);

    // Second call with same content — would normally be debounced,
    // but the prior call was a triage_error so the debounce wasn't
    // stamped. The LLM is re-tried.
    const second = await ensureNodeForIssue('m1', 'inbox-1', issue(209), ctx);
    // It's either triaged_uncertain again (LLM still failing) or
    // hash-match (the row's hash was NOT persisted on the error,
    // so we should NOT see hash-match either — must be a real LLM call).
    expect(second.status).toBe('triaged_uncertain');
    expect(triageMockCalls.length).toBe(2);
  });
});

describe('GH label → node tags sync (raw names, matches MindBlown convention)', () => {
  it('ghLabelsToTags maps label names to raw tags, sorted', () => {
    expect(ghLabelsToTags([{ name: 'kira-skip' }, { name: 'area:backend' }])).toEqual([
      'area:backend',
      'kira-skip',
    ]);
  });

  it('ghLabelsToTags returns [] for undefined/empty input', () => {
    expect(ghLabelsToTags(undefined)).toEqual([]);
    expect(ghLabelsToTags([])).toEqual([]);
  });

  it('ghLabelsToTags filters out priority:* labels (priority lives on its own node field)', () => {
    const next = ghLabelsToTags([
      { name: 'type:bug' },
      { name: 'priority:P1' },
      { name: 'area:frontend' },
      { name: 'priority:P0' },
    ]);
    expect(next).toEqual(['area:frontend', 'type:bug']);
  });

  it('ghLabelsToTags result is sorted for stable diff against existing tags', () => {
    const next = ghLabelsToTags([{ name: 'zeta' }, { name: 'alpha' }, { name: 'mike' }]);
    expect(next).toEqual(['alpha', 'mike', 'zeta']);
  });
});
