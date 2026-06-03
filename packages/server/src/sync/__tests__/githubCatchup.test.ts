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

// Local `GitHubApiError` stand-in so the SUT's `instanceof` check
// passes when tests throw it from the fetch mock. Class is defined
// inside the `vi.mock` factory (hoisted) and re-imported through the
// mocked module below — putting the class at top-level would be
// captured by the closure BEFORE the hoist, throwing TDZ.
vi.mock('@mindblown/integrations', () => {
  class MockGitHubApiError extends Error {
    readonly status: number;
    readonly body: string;
    constructor(status: number, body = '') {
      super(`GitHub API ${status}: ${body}`);
      this.name = 'GitHubApiError';
      this.status = status;
      this.body = body;
    }
  }
  return {
    fetchChangedIssues: vi.fn(async () => []),
    mintInstallationToken: vi.fn(async () => 'tok'),
    GitHubApiError: MockGitHubApiError,
  };
});

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

// Mock the systemd watchdog ping so we can verify it fires only on
// fully-clean ticks (the failure mode the watchdog catches is a frozen
// catchup loop — pinging on partial failures defeats its purpose).
const sdWatchdogMock = vi.fn(async (): Promise<boolean> => true);
vi.mock('../sdNotify.js', () => ({
  sdNotifyWatchdog: () => sdWatchdogMock(),
}));

// ── SUT import (after mocks) ──────────────────────────────────────

import {
  runAllCatchups,
  pushCatchupHeartbeat,
  isHealthyTick,
  reconcileRepo,
  _resetAuthFailureCountersForTests,
  _getAuthFailureCountForTests,
  type ReconcileResult,
} from '../githubCatchup.js';
import { fetchChangedIssues, GitHubApiError } from '@mindblown/integrations';

// Re-aliased for readability in tests: this is the mock class from
// the `vi.mock` factory above, not the real one.
const MockGitHubApiError = GitHubApiError;

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
    sdWatchdogMock.mockReset();
    sdWatchdogMock.mockResolvedValue(true);
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

describe('runAllCatchups → systemd watchdog', () => {
  beforeEach(() => {
    sdWatchdogMock.mockReset();
    sdWatchdogMock.mockResolvedValue(true);
    pushKumaMock.mockReset();
    pushKumaMock.mockResolvedValue(undefined);
    delete process.env.KUMA_GITHUB_CATCHUP_PUSH_URL;
  });

  it('pings the watchdog after a clean tick (zero repos, no errors)', async () => {
    // With the DB mocked to return zero targets, results is [], every()
    // returns true, isHealthyTick returns true → watchdog should fire.
    await runAllCatchups();
    expect(sdWatchdogMock).toHaveBeenCalledTimes(1);
  });

  it('does not throw when sdNotifyWatchdog rejects (notify failure must not affect main flow)', async () => {
    sdWatchdogMock.mockRejectedValueOnce(new Error('notify socket gone'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const results = await runAllCatchups();
    warnSpy.mockRestore();
    expect(Array.isArray(results)).toBe(true);
    expect(sdWatchdogMock).toHaveBeenCalledTimes(1);
  });
});

describe('isHealthyTick', () => {
  it('returns true for an empty results array (sweep completed without crashing)', () => {
    expect(isHealthyTick([])).toBe(true);
  });

  it('returns true when every repo is clean', () => {
    expect(
      isHealthyTick([makeResult({ fetched: 3, applied: 2 })]),
    ).toBe(true);
  });

  it('returns false when any repo reports ingestErrored > 0', () => {
    expect(
      isHealthyTick([
        makeResult(),
        makeResult({ repo: 'b/c', ingestErrored: 1 }),
      ]),
    ).toBe(false);
  });

  it('returns false when any repo reports stateSyncErrored > 0', () => {
    expect(
      isHealthyTick([makeResult({ stateSyncErrored: 1 })]),
    ).toBe(false);
  });

  it('returns false when any repo carries an error string', () => {
    expect(
      isHealthyTick([makeResult({ error: 'fetch: 503' })]),
    ).toBe(false);
  });
});

// ── 401-escalation tests (#75) ───────────────────────────────────
//
// Scenario: `fetchChangedIssues` throws a `GitHubApiError` with
// `status=401` (App install revoked, PAT expired, etc.). The catchup
// must track consecutive failures per repo and push a dedicated Kuma
// alarm once we cross `CATCHUP_AUTH_FAILURE_THRESHOLD`. On any
// successful fetch the counter resets.

const fetchChangedIssuesMock = vi.mocked(fetchChangedIssues);

function makeTarget(owner: string, repo: string) {
  return {
    owner,
    repo,
    resolveToken: async (): Promise<string> => 'tok',
  };
}

describe('reconcileRepo → 401 auth-failure escalation (#75)', () => {
  beforeEach(() => {
    _resetAuthFailureCountersForTests();
    pushKumaMock.mockReset();
    pushKumaMock.mockResolvedValue(undefined);
    fetchChangedIssuesMock.mockReset();
    delete process.env.KUMA_GITHUB_AUTH_FAILURE_PUSH_URL;
    delete process.env.CATCHUP_AUTH_FAILURE_THRESHOLD;
  });

  afterEach(() => {
    _resetAuthFailureCountersForTests();
    delete process.env.KUMA_GITHUB_AUTH_FAILURE_PUSH_URL;
    delete process.env.CATCHUP_AUTH_FAILURE_THRESHOLD;
  });

  it('does NOT push on the first 401 (counter below default threshold of 3)', async () => {
    process.env.KUMA_GITHUB_AUTH_FAILURE_PUSH_URL = 'https://kuma/api/push/auth';
    fetchChangedIssuesMock.mockRejectedValue(new MockGitHubApiError(401, 'Bad credentials'));

    const result = await reconcileRepo(makeTarget('o', 'r'));

    expect(result.error).toMatch(/^fetch: GitHub API 401/);
    expect(pushKumaMock).not.toHaveBeenCalled();
    expect(_getAuthFailureCountForTests('o/r')).toBe(1);
  });

  it('does NOT push on the second consecutive 401', async () => {
    process.env.KUMA_GITHUB_AUTH_FAILURE_PUSH_URL = 'https://kuma/api/push/auth';
    fetchChangedIssuesMock.mockRejectedValue(new MockGitHubApiError(401, 'Bad credentials'));

    await reconcileRepo(makeTarget('o', 'r'));
    await reconcileRepo(makeTarget('o', 'r'));

    expect(pushKumaMock).not.toHaveBeenCalled();
    expect(_getAuthFailureCountForTests('o/r')).toBe(2);
  });

  it('pushes status=down msg=auth_failed:owner/repo on the third consecutive 401', async () => {
    process.env.KUMA_GITHUB_AUTH_FAILURE_PUSH_URL = 'https://kuma/api/push/auth';
    fetchChangedIssuesMock.mockRejectedValue(new MockGitHubApiError(401, 'Bad credentials'));

    await reconcileRepo(makeTarget('o', 'r'));
    await reconcileRepo(makeTarget('o', 'r'));
    await reconcileRepo(makeTarget('o', 'r'));

    expect(pushKumaMock).toHaveBeenCalledTimes(1);
    const [url, status, msg, tag] = pushKumaMock.mock.calls[0];
    expect(url).toBe('https://kuma/api/push/auth');
    expect(status).toBe('down');
    expect(msg).toBe('auth_failed:o/r');
    expect(tag).toContain('github auth failure');
    expect(_getAuthFailureCountForTests('o/r')).toBe(3);
  });

  it('continues to push on every subsequent 401 once over the threshold', async () => {
    process.env.KUMA_GITHUB_AUTH_FAILURE_PUSH_URL = 'https://kuma/api/push/auth';
    fetchChangedIssuesMock.mockRejectedValue(new MockGitHubApiError(401, 'Bad credentials'));

    // 4 consecutive 401s: ticks 3 and 4 each push.
    for (let i = 0; i < 4; i++) {
      await reconcileRepo(makeTarget('o', 'r'));
    }

    // Pushes fired on ticks 3 and 4.
    expect(pushKumaMock).toHaveBeenCalledTimes(2);
    expect(pushKumaMock.mock.calls[0][2]).toBe('auth_failed:o/r');
    expect(pushKumaMock.mock.calls[1][2]).toBe('auth_failed:o/r');
    expect(_getAuthFailureCountForTests('o/r')).toBe(4);
  });

  it('resets the counter to 0 on the next successful fetch', async () => {
    process.env.KUMA_GITHUB_AUTH_FAILURE_PUSH_URL = 'https://kuma/api/push/auth';
    fetchChangedIssuesMock
      .mockRejectedValueOnce(new MockGitHubApiError(401, 'Bad credentials'))
      .mockRejectedValueOnce(new MockGitHubApiError(401, 'Bad credentials'))
      .mockResolvedValueOnce([]) // success — counter resets
      .mockRejectedValueOnce(new MockGitHubApiError(401, 'Bad credentials'));

    await reconcileRepo(makeTarget('o', 'r')); // 1 failure
    await reconcileRepo(makeTarget('o', 'r')); // 2 failures
    expect(_getAuthFailureCountForTests('o/r')).toBe(2);
    await reconcileRepo(makeTarget('o', 'r')); // success → reset
    expect(_getAuthFailureCountForTests('o/r')).toBe(0);
    await reconcileRepo(makeTarget('o', 'r')); // 1 failure again
    expect(_getAuthFailureCountForTests('o/r')).toBe(1);

    // Counter never crossed threshold across this run — no push.
    expect(pushKumaMock).not.toHaveBeenCalled();
  });

  it('tracks counters PER repo — repo A escalating must not affect repo B', async () => {
    process.env.KUMA_GITHUB_AUTH_FAILURE_PUSH_URL = 'https://kuma/api/push/auth';
    fetchChangedIssuesMock.mockImplementation(async (owner) => {
      throw new MockGitHubApiError(401, `Bad credentials for ${owner}`);
    });

    // Repo A: 3 failures → push.
    await reconcileRepo(makeTarget('a', 'a'));
    await reconcileRepo(makeTarget('a', 'a'));
    await reconcileRepo(makeTarget('a', 'a'));
    // Repo B: 1 failure → no push.
    await reconcileRepo(makeTarget('b', 'b'));

    // Exactly one push — and it's for repo A.
    expect(pushKumaMock).toHaveBeenCalledTimes(1);
    expect(pushKumaMock.mock.calls[0][2]).toBe('auth_failed:a/a');
    expect(_getAuthFailureCountForTests('a/a')).toBe(3);
    expect(_getAuthFailureCountForTests('b/b')).toBe(1);
  });

  it('honours CATCHUP_AUTH_FAILURE_THRESHOLD=1 — first 401 immediately pushes', async () => {
    process.env.KUMA_GITHUB_AUTH_FAILURE_PUSH_URL = 'https://kuma/api/push/auth';
    process.env.CATCHUP_AUTH_FAILURE_THRESHOLD = '1';
    fetchChangedIssuesMock.mockRejectedValue(new MockGitHubApiError(401, 'Bad credentials'));

    await reconcileRepo(makeTarget('o', 'r'));

    expect(pushKumaMock).toHaveBeenCalledTimes(1);
    expect(pushKumaMock.mock.calls[0][2]).toBe('auth_failed:o/r');
  });

  it('does NOT push when KUMA_GITHUB_AUTH_FAILURE_PUSH_URL is unset (no-op like catchup heartbeat)', async () => {
    delete process.env.KUMA_GITHUB_AUTH_FAILURE_PUSH_URL;
    fetchChangedIssuesMock.mockRejectedValue(new MockGitHubApiError(401, 'Bad credentials'));

    // 5 consecutive 401s — would push twice if the URL were set.
    for (let i = 0; i < 5; i++) {
      await reconcileRepo(makeTarget('o', 'r'));
    }

    expect(pushKumaMock).not.toHaveBeenCalled();
    // Counter still ticks up — the env-var gate is at the push side
    // only, so a later turn-on of the alarm sees the right state.
    expect(_getAuthFailureCountForTests('o/r')).toBe(5);
  });

  it('does NOT escalate on a non-401 fetch error (5xx, network)', async () => {
    process.env.KUMA_GITHUB_AUTH_FAILURE_PUSH_URL = 'https://kuma/api/push/auth';
    fetchChangedIssuesMock.mockRejectedValue(new MockGitHubApiError(503, 'Service Unavailable'));

    await reconcileRepo(makeTarget('o', 'r'));
    await reconcileRepo(makeTarget('o', 'r'));
    await reconcileRepo(makeTarget('o', 'r'));
    await reconcileRepo(makeTarget('o', 'r'));

    expect(pushKumaMock).not.toHaveBeenCalled();
    expect(_getAuthFailureCountForTests('o/r')).toBe(0);
  });
});
