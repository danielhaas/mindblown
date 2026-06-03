/**
 * Tests for the Kuma push heartbeat wired into `runAllCatchups`.
 *
 * The reconcile body itself is heavily DB-bound and covered by manual
 * persona tests against `mind.project.li`; the unit-test angle here is
 * exclusively the observability hook:
 *
 *   - URL set + clean catchup → fetch called once with status=up
 *   - URL set + ingestErrored>0 → fetch called once with status=down
 *   - URL set + stateSyncErrored>0 → status=down
 *   - URL set + reconcile error string → status=down
 *   - URL unset → fetch NOT called
 *   - Kuma push throws → catchup results unchanged (no exception)
 *
 * We mock `discoverTargets` indirectly by stubbing the DB layer so
 * `runAllCatchups` sees zero targets (clean tick), then mock
 * `pushKumaHeartbeat` to capture what it would have sent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock the DB so discoverTargets returns nothing ────────────────
// runAllCatchups will then iterate zero repos → results=[]. The
// "exercises real per-repo paths" cases are deliberately out of scope
// here; we test the per-repo paths separately by calling
// `pushCatchupHeartbeat` directly with synthetic results.

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('drizzle-orm');
  return {
    ...actual,
    eq: () => ({ __pred: true }),
    and: () => ({ __pred: true }),
    isNotNull: () => ({ __pred: true }),
    sql: Object.assign(
      (..._args: unknown[]) => ({ __sql: true }),
      { raw: (s: string) => ({ __sql: true, raw: s }) },
    ),
  };
});

vi.mock('../../db/schema.js', () => ({
  maps: {},
  nodes: {},
  integrations: {},
  githubRepoSync: {},
}));

vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [], // discoverTargets → empty
        then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
      }),
    }),
    execute: async () => undefined,
  },
}));

vi.mock('../../db/nodes.js', () => ({
  getNode: vi.fn(),
  updateNode: vi.fn(),
}));

vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

vi.mock('@mindblown/integrations', () => ({
  fetchChangedIssues: vi.fn(async () => []),
  mintInstallationToken: vi.fn(async () => 'tok'),
}));

vi.mock('../parentEpicRollup.js', () => ({
  parseParentReferences: () => [],
  applyRollupForFetchedIssues: vi.fn(async () => undefined),
}));

vi.mock('../githubIngest.js', () => ({
  ingestNewIssuesForRepo: vi.fn(async () => ({ created: 0, errored: 0 })),
}));

// Mock pushKumaHeartbeat so we can observe + control its behaviour.
const pushKumaMock = vi.fn(
  async (_url: string, _status: string, _msg: string, _tag: string): Promise<void> => undefined,
);
vi.mock('../kumaPush.js', () => ({
  pushKumaHeartbeat: (url: string, status: string, msg: string, tag: string) =>
    pushKumaMock(url, status, msg, tag),
}));

// ── SUT import (after mocks) ──────────────────────────────────────

import { runAllCatchups, pushCatchupHeartbeat, type ReconcileResult } from '../githubCatchup.js';

function makeResult(overrides: Partial<ReconcileResult> = {}): ReconcileResult {
  return {
    repo: 'owner/repo',
    fetched: 0,
    applied: 0,
    skipped: 0,
    noTransition: 0,
    stateSyncErrored: 0,
    ingested: 0,
    ingestErrored: 0,
    durationMs: 12,
    since: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('runAllCatchups → Kuma heartbeat', () => {
  beforeEach(() => {
    pushKumaMock.mockReset();
    pushKumaMock.mockResolvedValue(undefined);
    delete process.env.KUMA_GITHUB_CATCHUP_PUSH_URL;
  });

  afterEach(() => {
    delete process.env.KUMA_GITHUB_CATCHUP_PUSH_URL;
  });

  it('does not call pushKumaHeartbeat when the env var is unset', async () => {
    await runAllCatchups();
    expect(pushKumaMock).not.toHaveBeenCalled();
  });

  it('pushes status=up when the env var is set and the tick is clean (no repos)', async () => {
    process.env.KUMA_GITHUB_CATCHUP_PUSH_URL = 'https://kuma.example/api/push/abc';
    await runAllCatchups();
    expect(pushKumaMock).toHaveBeenCalledTimes(1);
    const [url, status, msg, tag] = pushKumaMock.mock.calls[0];
    expect(url).toBe('https://kuma.example/api/push/abc');
    expect(status).toBe('up');
    // Zero repos = zero of everything.
    expect(msg).toMatch(/repos=0/);
    expect(msg).toMatch(/fetched=0/);
    expect(msg).toMatch(/errored=0/);
    expect(tag).toContain('catchup heartbeat');
  });

  it('does not throw if pushKumaHeartbeat throws (push failure must not affect main flow)', async () => {
    process.env.KUMA_GITHUB_CATCHUP_PUSH_URL = 'https://kuma.example/api/push/abc';
    pushKumaMock.mockRejectedValueOnce(new Error('kuma down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The catchup must still resolve cleanly with its results array even
    // if the heartbeat rejects — Kuma being broken must NEVER break the
    // catchup loop.
    const results = await runAllCatchups();
    warnSpy.mockRestore();
    expect(Array.isArray(results)).toBe(true);
    expect(pushKumaMock).toHaveBeenCalledTimes(1);
  });
});

describe('pushCatchupHeartbeat (direct helper)', () => {
  beforeEach(() => {
    pushKumaMock.mockReset();
    pushKumaMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.KUMA_GITHUB_CATCHUP_PUSH_URL;
  });

  it('skips entirely when the env var is unset', async () => {
    delete process.env.KUMA_GITHUB_CATCHUP_PUSH_URL;
    await pushCatchupHeartbeat([makeResult({ fetched: 3, applied: 2 })]);
    expect(pushKumaMock).not.toHaveBeenCalled();
  });

  it('pushes status=up when every repo is clean', async () => {
    process.env.KUMA_GITHUB_CATCHUP_PUSH_URL = 'https://k/api/push/x';
    await pushCatchupHeartbeat([
      makeResult({ fetched: 5, applied: 3, ingested: 2 }),
      makeResult({ repo: 'b/c', fetched: 1, applied: 1 }),
    ]);
    expect(pushKumaMock).toHaveBeenCalledTimes(1);
    const [_url, status, msg] = pushKumaMock.mock.calls[0];
    expect(status).toBe('up');
    expect(msg).toMatch(/repos=2/);
    expect(msg).toMatch(/fetched=6/);
    expect(msg).toMatch(/applied=4/);
    expect(msg).toMatch(/ingested=2/);
    expect(msg).toMatch(/errored=0/);
  });

  it('pushes status=down when any repo has ingestErrored > 0', async () => {
    process.env.KUMA_GITHUB_CATCHUP_PUSH_URL = 'https://k/api/push/x';
    await pushCatchupHeartbeat([
      makeResult({ fetched: 5, applied: 3 }),
      makeResult({ repo: 'b/c', fetched: 2, ingestErrored: 1 }),
    ]);
    const [, status, msg] = pushKumaMock.mock.calls[0];
    expect(status).toBe('down');
    expect(msg).toMatch(/errored=1/);
  });

  it('pushes status=down when any repo has stateSyncErrored > 0', async () => {
    process.env.KUMA_GITHUB_CATCHUP_PUSH_URL = 'https://k/api/push/x';
    await pushCatchupHeartbeat([
      makeResult({ fetched: 3, stateSyncErrored: 1 }),
    ]);
    const [, status, msg] = pushKumaMock.mock.calls[0];
    expect(status).toBe('down');
    expect(msg).toMatch(/errored=1/);
  });

  it('pushes status=down when any repo has an error string set', async () => {
    process.env.KUMA_GITHUB_CATCHUP_PUSH_URL = 'https://k/api/push/x';
    await pushCatchupHeartbeat([
      makeResult({ error: 'fetch: 503' }),
    ]);
    const [, status] = pushKumaMock.mock.calls[0];
    expect(status).toBe('down');
  });
});
