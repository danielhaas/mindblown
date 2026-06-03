/**
 * End-to-end tests for `runDriftAudit` — the wrapper that calls
 * `auditDrift()` → `runAutoBackfill()` → `pushKumaHeartbeat()`.
 *
 * The cases here mirror the brief's "5 scenarios" but at the
 * full-flow level — what does Kuma actually see for each combination
 * of drift detection + auto-backfill outcome?
 *
 * `auditDrift` and `runAutoBackfill` are mocked directly so we exercise
 * the orchestration / Kuma-push logic without re-testing their own
 * internals (which have their own test files).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks for the SUT's collaborators ─────────────────────────────

// We can't easily mock `auditDrift` from within its own module, so
// instead we mock the GitHub fetch + DB layer underneath `auditDrift`
// (same pattern as the existing `driftAudit.test.ts`) and let
// `runDriftAudit` exercise the real `auditDrift`. This double-binds
// the SUT to `auditDrift`'s own correctness, but its behaviour is
// already pinned by the other test file's 8 cases — we only need to
// drive its return value via the DB + GitHub mocks here.

const runAutoBackfillMock = vi.fn();
const pushKumaMock = vi.fn(
  async (_url: string, _status: string, _msg: string, _tag: string): Promise<void> => undefined,
);

// Predicate-aware drizzle mock (same shape as driftAudit.test.ts).
type Pred = { __pred: true; check: (row: Record<string, unknown>) => boolean };
function isPred(x: unknown): x is Pred {
  return !!x && typeof x === 'object' && (x as { __pred?: true }).__pred === true;
}

interface MapRow {
  id: string;
  name: string;
  workspaceId: string;
  githubInstallationId: string | null;
  githubRepoOwner: string | null;
  githubRepoName: string | null;
  autoImportNewIssues: boolean;
}

const dbState = {
  maps: [] as MapRow[],
  nodes: [] as Array<{ id: string; mapId: string; externalLinks: Array<{ provider: string; externalId: string }> }>,
  integrations: [] as Array<{ workspaceId: string; provider: string; enabled: boolean; config: Record<string, unknown> }>,
  /** When set, every `db.select(...)` chain throws on resolve. */
  failureOnSelect: null as Error | null,
};

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('drizzle-orm');
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

vi.mock('../../db/schema.js', () => {
  const col = (name: string) => ({ __col: name });
  return {
    maps: {
      __name: 'maps',
      id: col('id'),
      name: col('name'),
      workspaceId: col('workspaceId'),
      githubInstallationId: col('githubInstallationId'),
      githubRepoOwner: col('githubRepoOwner'),
      githubRepoName: col('githubRepoName'),
      autoImportNewIssues: col('autoImportNewIssues'),
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

type Projection = Record<string, { __col?: string } | undefined>;

function buildChain(projection?: Projection): { from: (table: { __name?: string }) => unknown } {
  const step: { table?: string; pred?: unknown } = {};
  const projectRow = (row: Record<string, unknown>): Record<string, unknown> => {
    if (!projection) return row;
    const out: Record<string, unknown> = {};
    for (const [alias, ref] of Object.entries(projection)) {
      const colName = ref?.__col;
      out[alias] = colName ? row[colName] : undefined;
    }
    return out;
  };
  const resolve = async (): Promise<Record<string, unknown>[]> => {
    if (dbState.failureOnSelect) throw dbState.failureOnSelect;
    let rows: Record<string, unknown>[] = [];
    if (step.table === 'maps') {
      rows = dbState.maps.map((m) => ({ ...m }));
    } else if (step.table === 'nodes') {
      rows = dbState.nodes.map((n) => ({ ...n }));
    } else if (step.table === 'integrations') {
      rows = dbState.integrations.map((i) => ({ ...i }));
    }
    if (isPred(step.pred)) {
      rows = rows.filter((r) => (step.pred as Pred).check(r));
    }
    return rows.map(projectRow);
  };
  const thenable: {
    then: (
      onFulfilled: (v: Record<string, unknown>[]) => unknown,
      onRejected?: (err: unknown) => unknown,
    ) => Promise<unknown>;
    catch: (onRejected: (err: unknown) => unknown) => Promise<unknown>;
    where: (pred: unknown) => unknown;
  } = {
    then: (onFulfilled, onRejected) => resolve().then(onFulfilled, onRejected),
    catch: (onRejected) => resolve().catch(onRejected),
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

vi.mock('../../db/connection.js', () => ({
  db: {
    select: (cols?: Projection) => buildChain(cols),
  },
}));

import type { GitHubIssue } from '@mindblown/integrations';

const importedByRepo = new Map<string, Array<{ issue: GitHubIssue; externalLink: { externalId: string } }>>();
let importThrows: Error | null = null;

vi.mock('@mindblown/integrations', () => ({
  importGitHubIssues: async (owner: string, repo: string, _t: string, _o?: unknown) => {
    if (importThrows) throw importThrows;
    return importedByRepo.get(`${owner}/${repo}`) ?? [];
  },
  mintInstallationToken: async (installationId: string) => `tok-${installationId}`,
}));

vi.mock('../autoBackfill.js', () => ({
  runAutoBackfill: (...args: unknown[]) => runAutoBackfillMock(...args),
}));

vi.mock('../kumaPush.js', () => ({
  pushKumaHeartbeat: (...args: unknown[]) => pushKumaMock(...(args as Parameters<typeof pushKumaMock>)),
}));

// ── SUT import (after mocks) ──────────────────────────────────────

import { runDriftAudit, formatAutoBackfillMsg } from '../driftAudit.js';
import type { AutoBackfillSummary } from '../autoBackfill.js';

function ghIssue(number: number): GitHubIssue {
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
  };
}

function setupDriftyMap(mapId: string, mapName: string, driftCount: number): void {
  dbState.maps.push({
    id: mapId,
    name: mapName,
    workspaceId: 'ws',
    githubInstallationId: 'inst-1',
    githubRepoOwner: 'owner',
    githubRepoName: 'repo',
    autoImportNewIssues: true,
  });
  importedByRepo.set(
    'owner/repo',
    Array.from({ length: driftCount }, (_, i) => ({
      issue: ghIssue(i + 1),
      externalLink: { externalId: `owner/repo#${i + 1}` },
    })),
  );
}

function summary(
  totalImported: number,
  totalManualPending: number,
): AutoBackfillSummary {
  return { totalImported, totalManualPending, outcomes: [] };
}

beforeEach(() => {
  runAutoBackfillMock.mockReset();
  pushKumaMock.mockReset();
  pushKumaMock.mockResolvedValue(undefined);
  dbState.maps = [];
  dbState.nodes = [];
  dbState.integrations = [];
  dbState.failureOnSelect = null;
  importedByRepo.clear();
  importThrows = null;
  process.env.KUMA_GITHUB_DRIFT_PUSH_URL = 'https://kuma.example/api/push/x';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.KUMA_GITHUB_DRIFT_PUSH_URL;
});

// ── Cases ─────────────────────────────────────────────────────────

describe('runDriftAudit', () => {
  it('no drift → Kuma status=up msg=no-drift, no auto-backfill call', async () => {
    // No maps, no drift. auditDrift returns [], runDriftAudit pushes
    // clean and skips autoBackfill entirely.
    const result = await runDriftAudit();

    expect(runAutoBackfillMock).not.toHaveBeenCalled();
    expect(pushKumaMock).toHaveBeenCalledTimes(1);
    const [, status, msg] = pushKumaMock.mock.calls[0];
    expect(status).toBe('up');
    expect(msg).toBe('no-drift');
    expect(result.reports).toEqual([]);
    expect(result.autoBackfill).toEqual({ totalImported: 0, totalManualPending: 0, outcomes: [] });
  });

  it('drift fully auto-healed → Kuma status=up msg=auto-backfilled-N', async () => {
    setupDriftyMap('m1', 'Map One', 3);
    runAutoBackfillMock.mockResolvedValue(summary(3, 0));

    await runDriftAudit();

    expect(runAutoBackfillMock).toHaveBeenCalledTimes(1);
    expect(pushKumaMock).toHaveBeenCalledTimes(1);
    const [, status, msg] = pushKumaMock.mock.calls[0];
    expect(status).toBe('up');
    expect(msg).toBe('auto-backfilled-3');
  });

  it('drift partially auto-healed → Kuma status=down msg=auto-backfilled-X,manual-Y', async () => {
    setupDriftyMap('m1', 'Mixed', 4);
    runAutoBackfillMock.mockResolvedValue(summary(2, 100));

    await runDriftAudit();

    const [, status, msg] = pushKumaMock.mock.calls[0];
    expect(status).toBe('down');
    expect(msg).toBe('auto-backfilled-2,manual-100');
  });

  it('drift all over cap → Kuma status=down msg=manual-N', async () => {
    setupDriftyMap('m1', 'Over Cap', 75);
    runAutoBackfillMock.mockResolvedValue(summary(0, 75));

    await runDriftAudit();

    const [, status, msg] = pushKumaMock.mock.calls[0];
    expect(status).toBe('down');
    expect(msg).toBe('manual-75');
  });

  it('auditDrift itself throws (DB outage) → Kuma status=down msg=audit_failed:<reason>, no auto-backfill', async () => {
    // Force the FIRST DB query (resolveTargets in auditDrift) to throw.
    // This bubbles out of auditDrift → runDriftAudit's outer catch.
    dbState.failureOnSelect = new Error('drizzle connection lost');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runDriftAudit();
    errSpy.mockRestore();

    expect(runAutoBackfillMock).not.toHaveBeenCalled();
    expect(pushKumaMock).toHaveBeenCalledTimes(1);
    const [, status, msg] = pushKumaMock.mock.calls[0];
    expect(status).toBe('down');
    expect(msg).toMatch(/^audit_failed:/);
    expect(msg).toMatch(/drizzle connection lost/);
    expect(result.error).toMatch(/drizzle connection lost/);
  });

  it('per-map fetch failure (importGitHubIssues throws) → swallowed by auditDrift, run still reports no-drift', async () => {
    // This is the "case 4 — Backfill itself throws" analogue at the
    // audit-fetch level: a per-map fetch failure is caught inside
    // auditDrift and reported via console.warn, so the SWEEP completes
    // and runDriftAudit pushes "no-drift" (or auto-backfill if other
    // maps drifted). Documents the per-map error-handling contract.
    setupDriftyMap('m1', 'Will Fail', 1);
    importThrows = new Error('GitHub 503');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runDriftAudit();
    warnSpy.mockRestore();

    expect(result.error).toBeUndefined();
    const [, status, msg] = pushKumaMock.mock.calls[0];
    expect(status).toBe('up');
    expect(msg).toBe('no-drift');
  });

  it('Kuma URL unset → no push attempted, audit still returns its result', async () => {
    delete process.env.KUMA_GITHUB_DRIFT_PUSH_URL;

    const result = await runDriftAudit();

    expect(pushKumaMock).not.toHaveBeenCalled();
    expect(result.reports).toEqual([]);
  });

  it('Kuma push itself throws → runDriftAudit still returns its result', async () => {
    pushKumaMock.mockRejectedValueOnce(new Error('kuma 502'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runDriftAudit();
    warnSpy.mockRestore();

    expect(result.reports).toEqual([]);
    expect(pushKumaMock).toHaveBeenCalledTimes(1);
  });

  it('formatAutoBackfillMsg shapes the msg string consistently', () => {
    expect(formatAutoBackfillMsg(summary(0, 0))).toBe('no-drift');
    expect(formatAutoBackfillMsg(summary(3, 0))).toBe('auto-backfilled-3');
    expect(formatAutoBackfillMsg(summary(0, 5))).toBe('manual-5');
    expect(formatAutoBackfillMsg(summary(2, 5))).toBe('auto-backfilled-2,manual-5');
  });

  // ── token-errors suffix coverage (#87) ──────────────────────────
  // These cases pin the contract that token errors append a
  // `,token-errors-N` suffix to the Kuma msg WITHOUT flipping status.
  // The status-flip debate is filed as #87 item 5 for deferral.

  it('no drift + token error → status=up msg=no-drift,token-errors-1', async () => {
    // Build a map with installationId set but no PAT, so resolveTargets
    // produces a tokenError via the (now-fixed) PAT-missing or
    // App-mint-failed path. Easiest setup: pre-existing case where
    // an App install token mint succeeds and the map audits cleanly,
    // BUT a sibling map has no installationId and no PAT, so the
    // resolver pushes a `pat: missing` tokenError for it.
    setupDriftyMap('m1', 'Clean Map', 0);
    // Sibling map: no installation, no matching PAT → tokenError.
    dbState.maps.push({
      id: 'm2',
      name: 'Orphan Map',
      workspaceId: 'wsX',
      githubInstallationId: null,
      githubRepoOwner: 'orphan-owner',
      githubRepoName: 'orphan-repo',
      autoImportNewIssues: true,
    });
    // m1 has no drift to audit; the m1 setup also wired importedByRepo
    // for owner/repo with zero entries. m2 is dropped before any fetch
    // because no token resolves.

    const result = await runDriftAudit();

    expect(runAutoBackfillMock).not.toHaveBeenCalled();
    expect(pushKumaMock).toHaveBeenCalledTimes(1);
    const [, status, msg] = pushKumaMock.mock.calls[0];
    expect(status).toBe('up');
    expect(msg).toBe('no-drift,token-errors-1');
    expect(result.tokenErrors).toHaveLength(1);
    expect(result.tokenErrors[0].reason).toBe('pat: missing');
  });

  it('drift-with-backfill + token error → suffix appended to backfill msg', async () => {
    setupDriftyMap('m1', 'Drifty Map', 3);
    runAutoBackfillMock.mockResolvedValue(summary(3, 0));
    // Add a second orphaned map → 1 tokenError.
    dbState.maps.push({
      id: 'm2',
      name: 'Orphan Map',
      workspaceId: 'wsX',
      githubInstallationId: null,
      githubRepoOwner: 'orphan-owner',
      githubRepoName: 'orphan-repo',
      autoImportNewIssues: true,
    });

    await runDriftAudit();

    const [, status, msg] = pushKumaMock.mock.calls[0];
    // Status stays UP because backfill healed all drift — token errors
    // don't flip status (see deferred-debate comment in driftAudit.ts).
    expect(status).toBe('up');
    expect(msg).toBe('auto-backfilled-3,token-errors-1');
  });

  it('audit_failed error-return path includes tokenErrors: [] in shape', async () => {
    // Force the FIRST DB query (resolveTargets) to throw — auditDrift's
    // outer catch in runDriftAudit fires, and the early-return shape
    // MUST include `tokenErrors: []` (not undefined) so the operator
    // endpoint's response shape stays consistent.
    dbState.failureOnSelect = new Error('drizzle connection lost');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runDriftAudit();
    errSpy.mockRestore();

    expect(result.tokenErrors).toEqual([]);
    expect(result.error).toMatch(/drizzle connection lost/);
    const [, status, msg] = pushKumaMock.mock.calls[0];
    expect(status).toBe('down');
    expect(msg).toMatch(/^audit_failed:/);
  });
});
