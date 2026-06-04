/**
 * Tests for the issue.reopened triage-lifecycle hook (#95 Phase 2).
 *
 * The webhook path lives in routes/integrations.ts; the re-triage
 * decision lives in the exported `syncTriageRowsForReopen` helper.
 * We exercise the helper directly so we don't have to fake a full
 * Octokit/webhook payload — the webhook handler itself is a thin
 * `if (action === 'reopened') call(externalId)` wrapper.
 *
 * Three scenarios per spec:
 *   1. Existing un-reviewed decision row + reopen → re-triage runs,
 *      issue_state flips to 'open', decision is rewritten by Claude.
 *   2. Operator-reviewed row + reopen → re-triage SKIPPED, but
 *      issue_state still flips to 'open' (audit-only column tracks
 *      current GH state regardless of decision-immutability).
 *   3. Map's triage_enabled=false → re-triage SKIPPED, issue_state
 *      still updated.
 *
 * The "no existing row" → run through standard ingest case is
 * covered by the existing githubIngest.test.ts triage fork suite; it
 * never hits syncTriageRowsForReopen.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitHubIssue } from '@mindblown/integrations';

// ── In-memory state ───────────────────────────────────────────────

interface TriageRow {
  id: string;
  mapId: string;
  externalId: string;
  issueTitle: string;
  issueState: 'open' | 'closed';
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
const mapRows = new Map<string, { id: string; triageEnabled: boolean }>();

function seedRow(overrides: Partial<TriageRow> & { id: string; mapId: string; externalId: string }): TriageRow {
  const row: TriageRow = {
    issueTitle: 'an issue',
    issueState: 'closed', // most tests reopen from closed
    decision: 'uncertain',
    reason: 'r',
    confidence: 40,
    placedNodeId: null,
    decidedAt: new Date(),
    decidedBy: 'auto',
    reviewed: false,
    reviewedAt: null,
    reviewedBy: null,
    ...overrides,
  };
  triageRows.set(overrides.id, row);
  return row;
}

// ── Predicate-aware DB stub (shape mirrors triage-routes.test.ts) ─

type Predicate = { __pred: true; check: (row: Record<string, unknown>) => boolean };
function applyPred(rows: Record<string, unknown>[], pred: unknown): Record<string, unknown>[] {
  if (!pred || typeof pred !== 'object') return rows;
  const p = pred as { __pred?: true; check?: (row: Record<string, unknown>) => boolean };
  if (!p.__pred || typeof p.check !== 'function') return rows;
  return rows.filter((r) => p.check!(r));
}

function buildSelectChain() {
  const step: { table?: string; pred?: unknown } = {};
  const resolve = async (): Promise<Record<string, unknown>[]> => {
    let rows: Record<string, unknown>[] = [];
    if (step.table === 'triageDecisions') {
      rows = [...triageRows.values()].map((r) => ({ ...r }));
    } else if (step.table === 'maps') {
      rows = [...mapRows.values()].map((m) => ({ ...m }));
    }
    return applyPred(rows, step.pred);
  };
  const thenable = {
    then: (onF: (v: Record<string, unknown>[]) => unknown, onR?: (e: unknown) => unknown) =>
      resolve().then(onF, onR),
    catch: (onR: (e: unknown) => unknown) => resolve().catch(onR),
    where: (pred: unknown) => {
      step.pred = pred;
      return thenable;
    },
    orderBy: () => thenable,
    limit: () => thenable,
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
    maps: { __name: 'maps', id: col('id'), triageEnabled: col('triageEnabled') },
    versions: { __name: 'versions' },
    nodes: { __name: 'nodes', id: col('id'), externalLinks: col('externalLinks') },
    integrations: { __name: 'integrations' },
    triageDecisions: {
      __name: 'triageDecisions',
      id: col('id'),
      mapId: col('mapId'),
      externalId: col('externalId'),
      issueTitle: col('issueTitle'),
      placedNodeId: col('placedNodeId'),
      reviewed: col('reviewed'),
      decidedBy: col('decidedBy'),
      issueState: col('issueState'),
    },
    // Phase 3 (#96) — recordTriageHistory writes into this table. The
    // test doesn't assert on the contents but the recorder still
    // attempts an insert, so the symbol must exist or the import
    // resolves to undefined and drizzle throws.
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
    sql: vi.fn(),
  };
});

// Triage + mapContext stubs. vi.mock factories are hoisted above all
// top-level code, so any spy they reference must also be hoisted —
// declare via vi.hoisted, re-expose for ergonomic test assertions.
const hoisted = vi.hoisted(() => ({
  triageMock: vi.fn(async () => ({
    decision: 'place' as const,
    parentNodeId: 'epic-1',
    reason: 'reclassified, matches Frontend',
    confidence: 90,
  })),
}));
const triageMock = hoisted.triageMock;
vi.mock('../../sync/triage.js', () => ({ triageIssue: hoisted.triageMock }));

vi.mock('../../sync/mapContext.js', () => ({
  buildMapContext: vi.fn(async (mapId: string) => ({
    mapId,
    mapName: 'm',
    mapDescription: '',
    epics: [{ nodeId: 'epic-1', title: 'Frontend', description: 'UI' }],
  })),
}));

// The integrations module imports a bunch of other modules at top-level
// that we don't exercise here — stub them out so the import resolves.
vi.mock('@mindblown/integrations', () => ({
  createGitHubIssue: vi.fn(),
  getGitHubIssue: vi.fn(),
  importGitHubIssues: vi.fn(),
  extractVersionFromMilestone: vi.fn(),
  processWebhook: vi.fn(),
  verifyWebhookSignature: vi.fn(),
  mintInstallationToken: vi.fn(),
  isGitHubAppConfigured: vi.fn(),
}));
vi.mock('../../sync/githubCatchup.js', () => ({ reconcileRepo: vi.fn() }));
vi.mock('../../sync/driftAudit.js', () => ({ runDriftAudit: vi.fn() }));
vi.mock('../../sync/webhookAuthCheck.js', () => ({ recordWebhookCall: vi.fn() }));
vi.mock('../../auth.js', () => ({ requireAdmin: vi.fn() }));
vi.mock('../../sync/parentEpicRollup.js', () => ({ rollupParentsForChildTitle: vi.fn() }));
vi.mock('../../sync/githubIngest.js', () => ({
  ingestNewIssuesForRepo: vi.fn(),
  ensureInboxNode: vi.fn(),
  ensureNodeForIssue: vi.fn(),
  findNodesByExternalIds: vi.fn(),
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../db/nodes.js', () => ({
  getNode: vi.fn(),
  updateNode: vi.fn(),
}));
// Phase 3 follow-up (#104 item 9): syncTriageRowsForReopen now calls
// applyTriageLabel on the post-reclassify decision. Stub it so the
// reopen test can assert on the call without standing up the GH context
// + per-map writeback flag machinery (covered separately in
// triage-label-writeback.test.ts).
const applyTriageLabelMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../sync/triageLabelWriteback.js', () => ({
  applyTriageLabel: applyTriageLabelMock,
}));

import { syncTriageRowsForReopen } from '../integrations.js';

// ── Fixtures ──────────────────────────────────────────────────────

function reopenedIssue(number: number): GitHubIssue {
  return {
    id: number * 1000,
    number,
    title: 'Reopened issue',
    body: 'now has more context',
    state: 'open',
    labels: [],
    assignees: [],
    milestone: null,
    html_url: `https://github.com/o/r/issues/${number}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null,
  } as GitHubIssue;
}

beforeEach(() => {
  triageRows.clear();
  mapRows.clear();
  triageMock.mockClear();
  triageMock.mockResolvedValue({
    decision: 'place' as const,
    parentNodeId: 'epic-1',
    reason: 'reclassified, matches Frontend',
    confidence: 90,
  });
  applyTriageLabelMock.mockClear();
});

// ── Scenarios ─────────────────────────────────────────────────────

describe('syncTriageRowsForReopen', () => {
  it('unreviewed row on a triage-enabled map → issue_state flips, re-triage runs, decision rewritten', async () => {
    mapRows.set('m1', { id: 'm1', triageEnabled: true });
    seedRow({
      id: 'tr-1',
      mapId: 'm1',
      externalId: 'o/r#42',
      issueState: 'closed',
      decision: 'uncertain',
      confidence: 30,
      reviewed: false,
      decidedBy: 'auto',
    });

    await syncTriageRowsForReopen('o/r#42', reopenedIssue(42));

    const row = triageRows.get('tr-1')!;
    expect(row.issueState).toBe('open');
    expect(triageMock).toHaveBeenCalledOnce();
    // Mock returns place + 90.
    expect(row.decision).toBe('place');
    expect(row.confidence).toBe(90);
    expect(row.decidedBy).toBe('auto');
    expect(row.reviewed).toBe(false);
  });

  it('operator-reviewed row → issue_state still flips to open, but decision/reviewer UNCHANGED', async () => {
    mapRows.set('m1', { id: 'm1', triageEnabled: true });
    seedRow({
      id: 'tr-1',
      mapId: 'm1',
      externalId: 'o/r#42',
      issueState: 'closed',
      decision: 'skip',
      reason: 'operator said no',
      confidence: 100,
      reviewed: true,
      decidedBy: 'operator',
      reviewedBy: 'u-1',
      reviewedAt: new Date('2026-06-01'),
    });

    await syncTriageRowsForReopen('o/r#42', reopenedIssue(42));

    const row = triageRows.get('tr-1')!;
    // issue_state mirrors current GH — flips even on protected rows.
    expect(row.issueState).toBe('open');
    // Decision NOT rewritten — operator-protect kicked in BEFORE LLM call.
    expect(triageMock).not.toHaveBeenCalled();
    expect(row.decision).toBe('skip');
    expect(row.reason).toBe('operator said no');
    expect(row.confidence).toBe(100);
    expect(row.reviewed).toBe(true);
    expect(row.decidedBy).toBe('operator');
    expect(row.reviewedBy).toBe('u-1');
  });

  it('triage_enabled=false → issue_state flips, but no re-triage', async () => {
    mapRows.set('m1', { id: 'm1', triageEnabled: false });
    seedRow({
      id: 'tr-1',
      mapId: 'm1',
      externalId: 'o/r#42',
      issueState: 'closed',
      decision: 'place',
      confidence: 80,
      reviewed: false,
      decidedBy: 'auto',
    });

    await syncTriageRowsForReopen('o/r#42', reopenedIssue(42));

    const row = triageRows.get('tr-1')!;
    expect(row.issueState).toBe('open');
    expect(triageMock).not.toHaveBeenCalled();
    // Decision untouched.
    expect(row.decision).toBe('place');
    expect(row.confidence).toBe(80);
  });

  it('no matching row → no-op (no throw, triageIssue not called)', async () => {
    mapRows.set('m1', { id: 'm1', triageEnabled: true });
    // No row seeded for o/r#999.
    await syncTriageRowsForReopen('o/r#999', reopenedIssue(999));
    expect(triageMock).not.toHaveBeenCalled();
    expect(triageRows.size).toBe(0);
  });

  it('multiple maps with the same externalId → re-triage runs per-eligible-map', async () => {
    mapRows.set('m1', { id: 'm1', triageEnabled: true });
    mapRows.set('m2', { id: 'm2', triageEnabled: true });
    seedRow({
      id: 'tr-1',
      mapId: 'm1',
      externalId: 'o/r#42',
      issueState: 'closed',
      decision: 'uncertain',
      reviewed: false,
      decidedBy: 'auto',
    });
    seedRow({
      id: 'tr-2',
      mapId: 'm2',
      externalId: 'o/r#42',
      issueState: 'closed',
      decision: 'skip',
      reviewed: false,
      decidedBy: 'auto',
    });

    await syncTriageRowsForReopen('o/r#42', reopenedIssue(42));

    expect(triageMock).toHaveBeenCalledTimes(2);
    expect(triageRows.get('tr-1')!.issueState).toBe('open');
    expect(triageRows.get('tr-2')!.issueState).toBe('open');
  });

  it('non-place reclassify on a previously-placed row clears placedNodeId (orphan-cleanup)', async () => {
    mapRows.set('m1', { id: 'm1', triageEnabled: true });
    seedRow({
      id: 'tr-1',
      mapId: 'm1',
      externalId: 'o/r#42',
      issueState: 'closed',
      decision: 'place',
      confidence: 80,
      placedNodeId: 'orphan-node',
      reviewed: false,
      decidedBy: 'auto',
    });
    triageMock.mockResolvedValueOnce({
      decision: 'skip' as const,
      parentNodeId: undefined,
      reason: 'no longer relevant after reopen',
      confidence: 92,
    } as unknown as Awaited<ReturnType<typeof triageMock>>);

    await syncTriageRowsForReopen('o/r#42', reopenedIssue(42));

    const row = triageRows.get('tr-1')!;
    expect(row.decision).toBe('skip');
    expect(row.placedNodeId).toBeNull();
  });

  // Phase 3 follow-up (#104 item 9): reopen-driven re-triage that flips
  // place ↔ skip must call applyTriageLabel so the GH label doesn't go
  // stale. The label helper is internally gated on the per-map
  // `triage_label_writeback` flag — the call must happen unconditionally
  // (the helper decides whether to fire); this test confirms the call
  // shape is correct (mapId + externalId + new decision).
  it("reopen + re-triage flips decision → applyTriageLabel called with the new decision", async () => {
    mapRows.set('m1', { id: 'm1', triageEnabled: true });
    seedRow({
      id: 'tr-1',
      mapId: 'm1',
      externalId: 'o/r#42',
      issueState: 'closed',
      decision: 'place',
      confidence: 70,
      placedNodeId: 'node-x',
      reviewed: false,
      decidedBy: 'auto',
    });
    // The re-triage flips the decision to 'skip'.
    triageMock.mockResolvedValueOnce({
      decision: 'skip' as const,
      parentNodeId: undefined,
      reason: 'no longer relevant after reopen',
      confidence: 92,
    } as unknown as Awaited<ReturnType<typeof triageMock>>);

    await syncTriageRowsForReopen('o/r#42', reopenedIssue(42));

    expect(applyTriageLabelMock).toHaveBeenCalledOnce();
    expect(applyTriageLabelMock).toHaveBeenCalledWith({
      mapId: 'm1',
      externalId: 'o/r#42',
      decision: 'skip',
    });
  });

  it("reopen on a triage-disabled map → no applyTriageLabel call (no re-triage means no label change)", async () => {
    mapRows.set('m1', { id: 'm1', triageEnabled: false });
    seedRow({
      id: 'tr-1',
      mapId: 'm1',
      externalId: 'o/r#42',
      issueState: 'closed',
      decision: 'place',
      reviewed: false,
      decidedBy: 'auto',
    });
    await syncTriageRowsForReopen('o/r#42', reopenedIssue(42));
    expect(applyTriageLabelMock).not.toHaveBeenCalled();
  });

  it("reopen on operator-reviewed row → no applyTriageLabel call (decision is immutable here)", async () => {
    mapRows.set('m1', { id: 'm1', triageEnabled: true });
    seedRow({
      id: 'tr-1',
      mapId: 'm1',
      externalId: 'o/r#42',
      issueState: 'closed',
      decision: 'skip',
      reviewed: true,
      decidedBy: 'operator',
    });
    await syncTriageRowsForReopen('o/r#42', reopenedIssue(42));
    expect(applyTriageLabelMock).not.toHaveBeenCalled();
  });

  it('LLM throws on one row → continues with the next row, issue_state still flipped', async () => {
    mapRows.set('m1', { id: 'm1', triageEnabled: true });
    mapRows.set('m2', { id: 'm2', triageEnabled: true });
    seedRow({
      id: 'tr-1',
      mapId: 'm1',
      externalId: 'o/r#42',
      issueState: 'closed',
      decision: 'uncertain',
      reviewed: false,
      decidedBy: 'auto',
    });
    seedRow({
      id: 'tr-2',
      mapId: 'm2',
      externalId: 'o/r#42',
      issueState: 'closed',
      decision: 'uncertain',
      reviewed: false,
      decidedBy: 'auto',
    });
    triageMock.mockRejectedValueOnce(new Error('LLM down'));

    await syncTriageRowsForReopen('o/r#42', reopenedIssue(42));

    // Both rows had issue_state flipped (that happens in the first
    // bulk UPDATE before the per-row loop).
    expect(triageRows.get('tr-1')!.issueState).toBe('open');
    expect(triageRows.get('tr-2')!.issueState).toBe('open');
    // tr-1 LLM threw, decision stays uncertain.
    expect(triageRows.get('tr-1')!.decision).toBe('uncertain');
    // tr-2 LLM ran (default mock returns place + 90).
    expect(triageRows.get('tr-2')!.decision).toBe('place');
    expect(triageMock).toHaveBeenCalledTimes(2);
  });
});
