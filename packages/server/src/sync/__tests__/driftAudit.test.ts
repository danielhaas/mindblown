/**
 * Tests for the daily drift-audit sweep.
 *
 * Mocks the DB (drizzle's select chain), the GitHub fetcher
 * (`importGitHubIssues` / `mintInstallationToken`), so the audit logic
 * exercises end-to-end without Postgres or network.
 *
 * Cases covered:
 *   - Clean map (every open issue is linked) → no report.
 *   - Drifted map (N issues unlinked) → one report with exampleIssues
 *     truncated to 5.
 *   - `autoImportNewIssues = false` → skipped (no report even if drift
 *     exists on the repo).
 *   - No GitHub binding → skipped (filtered out by the resolveTargets
 *     query — we model that by simply not putting the map in the dataset).
 *   - PAT fallback when an App-binding token mint fails → still produces
 *     a report.
 *   - Token-error surfacing (#70): when an App-token mint fails AND no
 *     PAT fallback works, the failing map appears in `tokenErrors` with
 *     a reason derived from the error. Tested in 4 variants below.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitHubIssue } from '@mindblown/integrations';

// ── DB state ──────────────────────────────────────────────────────

type MapRow = {
  id: string;
  name: string;
  workspaceId: string;
  githubInstallationId: string | null;
  githubRepoOwner: string | null;
  githubRepoName: string | null;
  autoImportNewIssues: boolean;
};

type NodeRow = {
  id: string;
  mapId: string;
  externalLinks: Array<{ provider: string; externalId: string }>;
};

type IntegrationRow = {
  workspaceId: string;
  provider: string;
  enabled: boolean;
  config: { owner?: string; repo?: string; token?: string };
};

const dbState = {
  maps: [] as MapRow[],
  nodes: [] as NodeRow[],
  integrations: [] as IntegrationRow[],
};

// ── Predicate-aware drizzle mock ──────────────────────────────────

type Pred = { __pred: true; check: (row: Record<string, unknown>) => boolean };
function isPred(x: unknown): x is Pred {
  return !!x && typeof x === 'object' && (x as { __pred?: true }).__pred === true;
}

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
      const col = ref?.__col;
      out[alias] = col ? row[col] : undefined;
    }
    return out;
  };
  const resolve = async (): Promise<Record<string, unknown>[]> => {
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

// ── GitHub mocks ──────────────────────────────────────────────────

const importedByRepo = new Map<string, Array<{ issue: GitHubIssue; externalLink: { externalId: string } }>>();
const mintErrors = new Map<string, string>(); // installationId → error message
const importErrors = new Map<string, string>(); // owner/repo → error message

vi.mock('@mindblown/integrations', () => ({
  importGitHubIssues: async (
    owner: string,
    repo: string,
    _token: string,
    _opts?: unknown,
  ) => {
    const key = `${owner}/${repo}`;
    const err = importErrors.get(key);
    if (err) throw new Error(err);
    return importedByRepo.get(key) ?? [];
  },
  mintInstallationToken: async (installationId: string) => {
    const err = mintErrors.get(installationId);
    if (err) throw new Error(err);
    return `tok-${installationId}`;
  },
}));

// ── SUT import (after mocks) ──────────────────────────────────────

import { auditDrift } from '../driftAudit.js';

// ── Fixtures ──────────────────────────────────────────────────────

function ghIssue(number: number, overrides: Partial<GitHubIssue> = {}): GitHubIssue {
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

function setupRepoIssues(
  owner: string,
  repo: string,
  issueNumbers: number[],
): void {
  importedByRepo.set(
    `${owner}/${repo}`,
    issueNumbers.map((n) => ({
      issue: ghIssue(n),
      externalLink: { externalId: `${owner}/${repo}#${n}` },
    })),
  );
}

function linkNodeToIssue(mapId: string, owner: string, repo: string, issueNumber: number): void {
  dbState.nodes.push({
    id: `node-${mapId}-${issueNumber}`,
    mapId,
    externalLinks: [
      { provider: 'github', externalId: `${owner}/${repo}#${issueNumber}` },
    ],
  });
}

beforeEach(() => {
  dbState.maps = [];
  dbState.nodes = [];
  dbState.integrations = [];
  importedByRepo.clear();
  mintErrors.clear();
  importErrors.clear();
});

// ── Tests ─────────────────────────────────────────────────────────

describe('auditDrift', () => {
  it('returns empty array when every open issue has a linked node', async () => {
    dbState.maps.push({
      id: 'm1',
      name: 'Map One',
      workspaceId: 'ws',
      githubInstallationId: 'inst-1',
      githubRepoOwner: 'owner',
      githubRepoName: 'repo',
      autoImportNewIssues: true,
    });
    setupRepoIssues('owner', 'repo', [1, 2, 3]);
    linkNodeToIssue('m1', 'owner', 'repo', 1);
    linkNodeToIssue('m1', 'owner', 'repo', 2);
    linkNodeToIssue('m1', 'owner', 'repo', 3);

    const { reports, tokenErrors } = await auditDrift();
    expect(reports).toEqual([]);
    expect(tokenErrors).toEqual([]);
  });

  it('returns a DriftReport when issues exist with no linked node', async () => {
    dbState.maps.push({
      id: 'm1',
      name: 'Roadmap',
      workspaceId: 'ws',
      githubInstallationId: 'inst-1',
      githubRepoOwner: 'owner',
      githubRepoName: 'repo',
      autoImportNewIssues: true,
    });
    setupRepoIssues('owner', 'repo', [10, 11, 12]);
    linkNodeToIssue('m1', 'owner', 'repo', 10);
    // 11 and 12 are unlinked

    const { reports, tokenErrors } = await auditDrift();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({
      mapId: 'm1',
      mapName: 'Roadmap',
      repo: 'owner/repo',
      onlyInGitHub: 2,
      exampleIssues: [11, 12],
    });
    expect(tokenErrors).toEqual([]);
  });

  it('truncates exampleIssues to 5 even when N is much larger', async () => {
    dbState.maps.push({
      id: 'm1',
      name: 'Big Map',
      workspaceId: 'ws',
      githubInstallationId: 'inst-1',
      githubRepoOwner: 'owner',
      githubRepoName: 'repo',
      autoImportNewIssues: true,
    });
    // 8 open issues, none linked
    setupRepoIssues('owner', 'repo', [1, 2, 3, 4, 5, 6, 7, 8]);

    const { reports } = await auditDrift();
    expect(reports).toHaveLength(1);
    expect(reports[0].onlyInGitHub).toBe(8);
    expect(reports[0].exampleIssues).toEqual([1, 2, 3, 4, 5]);
  });

  it('skips maps with autoImportNewIssues=false', async () => {
    dbState.maps.push({
      id: 'm1',
      name: 'Opt-out Map',
      workspaceId: 'ws',
      githubInstallationId: 'inst-1',
      githubRepoOwner: 'owner',
      githubRepoName: 'repo',
      autoImportNewIssues: false, // opted out
    });
    setupRepoIssues('owner', 'repo', [1, 2, 3]);
    // Zero nodes linked — would be drift if the map were opted in.

    const { reports, tokenErrors } = await auditDrift();
    expect(reports).toEqual([]);
    expect(tokenErrors).toEqual([]);
  });

  it('skips maps with no GitHub binding (owner/repo null)', async () => {
    dbState.maps.push({
      id: 'm1',
      name: 'Unbound Map',
      workspaceId: 'ws',
      githubInstallationId: null,
      githubRepoOwner: null,
      githubRepoName: null,
      autoImportNewIssues: true,
    });
    // No repo to fetch — even if we put issues in importedByRepo,
    // the resolveTargets isNotNull predicate filters this out.
    setupRepoIssues('owner', 'repo', [1, 2, 3]);

    const { reports, tokenErrors } = await auditDrift();
    expect(reports).toEqual([]);
    expect(tokenErrors).toEqual([]);
  });

  it('reports one map per opted-in target, not aggregated by repo', async () => {
    // Two maps bound to the SAME repo, both opted in, with different
    // linked nodes. We want one report each.
    dbState.maps.push({
      id: 'mA',
      name: 'Map A',
      workspaceId: 'ws',
      githubInstallationId: 'inst-1',
      githubRepoOwner: 'owner',
      githubRepoName: 'repo',
      autoImportNewIssues: true,
    });
    dbState.maps.push({
      id: 'mB',
      name: 'Map B',
      workspaceId: 'ws',
      githubInstallationId: 'inst-1',
      githubRepoOwner: 'owner',
      githubRepoName: 'repo',
      autoImportNewIssues: true,
    });
    setupRepoIssues('owner', 'repo', [1, 2, 3]);
    linkNodeToIssue('mA', 'owner', 'repo', 1); // mA misses 2, 3
    linkNodeToIssue('mB', 'owner', 'repo', 1);
    linkNodeToIssue('mB', 'owner', 'repo', 2); // mB misses 3

    const { reports } = await auditDrift();
    const byId = new Map(reports.map((r) => [r.mapId, r]));
    expect(byId.get('mA')?.onlyInGitHub).toBe(2);
    expect(byId.get('mB')?.onlyInGitHub).toBe(1);
  });

  it('falls back to a PAT integration when the App token mint fails', async () => {
    dbState.maps.push({
      id: 'm1',
      name: 'App+PAT Map',
      workspaceId: 'ws',
      githubInstallationId: 'inst-1',
      githubRepoOwner: 'owner',
      githubRepoName: 'repo',
      autoImportNewIssues: true,
    });
    dbState.integrations.push({
      workspaceId: 'ws',
      provider: 'github',
      enabled: true,
      config: { owner: 'owner', repo: 'repo', token: 'pat-fallback' },
    });
    mintErrors.set('inst-1', 'install revoked');
    setupRepoIssues('owner', 'repo', [42]);
    // No node linked → expect drift

    const { reports, tokenErrors } = await auditDrift();
    expect(reports).toHaveLength(1);
    expect(reports[0].onlyInGitHub).toBe(1);
    expect(reports[0].exampleIssues).toEqual([42]);
    // PAT fallback worked → no token error reported (the earlier
    // App-mint failure is dropped once the PAT succeeds).
    expect(tokenErrors).toEqual([]);
  });

  it('logs and skips a map whose GitHub fetch throws, without aborting other maps', async () => {
    dbState.maps.push({
      id: 'mGood',
      name: 'Good Map',
      workspaceId: 'wsA',
      githubInstallationId: 'inst-good',
      githubRepoOwner: 'good',
      githubRepoName: 'repo',
      autoImportNewIssues: true,
    });
    dbState.maps.push({
      id: 'mBad',
      name: 'Bad Map',
      workspaceId: 'wsB',
      githubInstallationId: 'inst-bad',
      githubRepoOwner: 'bad',
      githubRepoName: 'repo',
      autoImportNewIssues: true,
    });
    setupRepoIssues('good', 'repo', [7]); // drift in good
    importErrors.set('bad/repo', 'GitHub 503');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { reports, tokenErrors } = await auditDrift();
    warnSpy.mockRestore();

    // mGood still reports its drift; mBad failed silently.
    expect(reports.map((r) => r.mapId)).toEqual(['mGood']);
    expect(reports[0].onlyInGitHub).toBe(1);
    // Per-map fetch errors do NOT populate tokenErrors — those are
    // reserved for token-resolution failures (App revoked / PAT missing).
    expect(tokenErrors).toEqual([]);
  });

  // ── Token-error surfacing (#70) ─────────────────────────────────

  it('reports a tokenError when App mint fails AND no PAT fallback exists', async () => {
    dbState.maps.push({
      id: 'm1',
      name: 'Revoked Install Map',
      workspaceId: 'ws',
      githubInstallationId: 'inst-revoked',
      githubRepoOwner: 'owner',
      githubRepoName: 'repo',
      autoImportNewIssues: true,
    });
    // App mint throws; no PAT integration in dbState.integrations →
    // map can't resolve a token at all.
    mintErrors.set('inst-revoked', 'install revoked');
    // Even though issues exist on the repo, the map is skipped from
    // the audit entirely — no fetch happens, no report.
    setupRepoIssues('owner', 'repo', [1, 2, 3]);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { reports, tokenErrors } = await auditDrift();
    warnSpy.mockRestore();

    expect(reports).toEqual([]);
    expect(tokenErrors).toHaveLength(1);
    expect(tokenErrors[0]).toEqual({
      mapId: 'm1',
      mapName: 'Revoked Install Map',
      // Reason format: `app: <error message>` — see resolveTargets()
      // in driftAudit.ts.
      reason: 'app: install revoked',
    });
  });

  it('omits a tokenError when App mint fails BUT PAT fallback succeeds', async () => {
    // This is the existing PAT-fallback case re-asserted at the
    // tokenErrors contract level: a downstream PAT save means there
    // is NO token error to surface, even though the App mint blew up.
    dbState.maps.push({
      id: 'm1',
      name: 'App+PAT Map',
      workspaceId: 'ws',
      githubInstallationId: 'inst-revoked',
      githubRepoOwner: 'owner',
      githubRepoName: 'repo',
      autoImportNewIssues: true,
    });
    dbState.integrations.push({
      workspaceId: 'ws',
      provider: 'github',
      enabled: true,
      config: { owner: 'owner', repo: 'repo', token: 'pat-fallback' },
    });
    mintErrors.set('inst-revoked', 'install revoked');
    setupRepoIssues('owner', 'repo', [1]);

    const { reports, tokenErrors } = await auditDrift();
    // Map IS audited normally because the PAT works.
    expect(reports).toHaveLength(1);
    expect(reports[0].mapId).toBe('m1');
    // And tokenErrors is empty — the App-mint failure was recovered.
    expect(tokenErrors).toEqual([]);
  });

  it('reports tokenErrors alongside reports for a mix of normal + token-errored maps', async () => {
    // mNormal — drifted, audits cleanly.
    dbState.maps.push({
      id: 'mNormal',
      name: 'Normal Map',
      workspaceId: 'wsA',
      githubInstallationId: 'inst-ok',
      githubRepoOwner: 'good',
      githubRepoName: 'repo',
      autoImportNewIssues: true,
    });
    setupRepoIssues('good', 'repo', [5]); // unlinked → drift

    // mBroken — App revoked, no PAT → tokenError.
    dbState.maps.push({
      id: 'mBroken',
      name: 'Broken Token Map',
      workspaceId: 'wsB',
      githubInstallationId: 'inst-revoked',
      githubRepoOwner: 'bad',
      githubRepoName: 'repo',
      autoImportNewIssues: true,
    });
    mintErrors.set('inst-revoked', 'install revoked');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { reports, tokenErrors } = await auditDrift();
    warnSpy.mockRestore();

    expect(reports.map((r) => r.mapId)).toEqual(['mNormal']);
    expect(reports[0].onlyInGitHub).toBe(1);
    expect(tokenErrors).toHaveLength(1);
    expect(tokenErrors[0].mapId).toBe('mBroken');
    expect(tokenErrors[0].reason).toBe('app: install revoked');
  });

  it('preserves the raw error message in tokenError.reason for non-revocation failures', async () => {
    // Defensive: the resolver stringifies arbitrary errors into
    // `reason`. Make sure a non-"install revoked" message threads
    // through verbatim so the operator UI can render the actual cause.
    dbState.maps.push({
      id: 'm1',
      name: 'JWT Map',
      workspaceId: 'ws',
      githubInstallationId: 'inst-jwt',
      githubRepoOwner: 'owner',
      githubRepoName: 'repo',
      autoImportNewIssues: true,
    });
    mintErrors.set('inst-jwt', 'JWT signature invalid');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { reports, tokenErrors } = await auditDrift();
    warnSpy.mockRestore();

    expect(reports).toEqual([]);
    expect(tokenErrors).toHaveLength(1);
    expect(tokenErrors[0].reason).toBe('app: JWT signature invalid');
  });
});
