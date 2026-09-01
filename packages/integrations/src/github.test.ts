import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { ExternalLink, LinkedPrState, Node } from '@mindblown/core';
import {
  updateGitHubIssue,
  reopenGitHubIssue,
  findClosingPrsForIssue,
  probeIssueLanded,
  getIssueCloseEvent,
  GitHubScanTruncatedError,
  GitHubApiError,
  GitHubPaginationLimitError,
  GitHubCrossOriginPaginationError,
  fetchChangedIssues,
  importGitHubIssues,
  parseLinkNext,
  type IssueLandingProbe,
} from './github.js';

/**
 * Regression cover for the premature-close bug (2026-08-03).
 *
 * A coding agent marks its MindBlown node done when it OPENS the pull
 * request. The outbound sync read that as "work finished" and closed the
 * linked GitHub issue as COMPLETED, while the PR was still open and in
 * several cases still red. The work then looked shipped and nobody chased
 * the branch.
 */

const LINK: ExternalLink = {
  provider: 'github',
  externalId: 'FulcrumCRM/crm#6096',
  url: 'https://github.com/FulcrumCRM/crm/issues/6096',
  syncEnabled: true,
} as ExternalLink;

function node(overrides: Partial<Node> = {}): Node {
  return {
    id: 'n1',
    mapId: 'm1',
    parentId: null,
    childrenIds: [],
    text: '#6096 Upward multi-hop controlling-person look-through',
    description: null,
    x: null,
    y: null,
    collapsed: false,
    effortEstimate: null,
    actualEffort: null,
    percentComplete: null,
    status: null,
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
    externalLinks: [LINK],
    priorityRank: null,
    completedAt: null,
    claimedBySession: null,
    claimedAt: null,
    scopes: [],
    requirementId: null,
    requirementPriority: null,
    requirementText: null,
    phaseId: null,
    verificationText: null,
    verificationUrl: null,
    verificationVideoUrl: null,
    autoProgress: 'off',
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    ...overrides,
  } as Node;
}

function pr(state: LinkedPrState['state']): LinkedPrState {
  return {
    number: 6122,
    repo: 'FulcrumCRM/crm',
    url: 'https://github.com/FulcrumCRM/crm/pull/6122',
    head: 'fix/6096',
    base: 'main',
    author: 'django-dev-max',
    draft: false,
    state,
    mergeable: true,
    changedFiles: [],
    reviews: [],
    checks: { state: null, failures: [] },
    lastSyncedAt: '2026-07-27T20:41:35.000Z',
  };
}

/**
 * The body of the PATCH the function sent to GitHub.
 *
 * Searches the call list rather than reading `calls[0]`: the close path
 * may probe GitHub (a GET) before it decides, so the PATCH is no longer
 * guaranteed to be the first call.
 */
function sentPatch(): Record<string, unknown> {
  const calls = vi.mocked(globalThis.fetch).mock.calls;
  const patch = calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH');
  expect(patch, 'no PATCH was sent to GitHub').toBeDefined();
  return JSON.parse((patch![1] as RequestInit).body as string);
}

/**
 * A landing probe stub. `updateGitHubIssue` takes the probe as an
 * injected dependency precisely so a test can state the GitHub-side
 * truth ("a PR is open for this issue") without simulating the timeline
 * API — the timeline walk itself is covered by findClosingPrsForIssue's
 * own tests.
 */
function probeStub(result: Partial<IssueLandingProbe>) {
  return vi.fn(async () => ({
    closingPrs: [],
    defaultBranch: 'main',
    landed: null,
    inFlight: false,
    ...result,
  }));
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ number: 6096, state: 'open' }),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('updateGitHubIssue — issue state vs. linked PR', () => {
  it('does not touch the issue state while the linked PR is still open', async () => {
    await updateGitHubIssue(
      node({ status: 'done', percentComplete: 100, linkedPr: pr('open') }),
      LINK,
      'tok',
    );

    expect(sentPatch()).not.toHaveProperty('state');
  });

  it('does not touch the issue state when the linked PR was closed unmerged', async () => {
    await updateGitHubIssue(
      node({ status: 'done', percentComplete: 100, linkedPr: pr('closed') }),
      LINK,
      'tok',
    );

    expect(sentPatch()).not.toHaveProperty('state');
  });

  it('still syncs title and labels while a PR is in flight', async () => {
    await updateGitHubIssue(
      node({ status: 'done', percentComplete: 100, linkedPr: pr('open'), tags: ['compliance'] }),
      LINK,
      'tok',
    );

    const patch = sentPatch();
    expect(patch.title).toBe('#6096 Upward multi-hop controlling-person look-through');
    expect(patch.labels).toEqual(['compliance']);
  });

  // Unit-Kontrakt, kein Happy-Path-Nachweis: `handlePrClosed` setzt beim
  // Merge `linkedPr: null`, ein persistiertes 'merged' entsteht nur über
  // ein nachträgliches `pull_request.edited`. Den echten Merge-Weg decken
  // GitHubs eigenes `Closes #N` und der `linkedPr: null`-Test darunter ab.
  it('closes the issue once the PR is merged', async () => {
    await updateGitHubIssue(
      node({ status: 'done', percentComplete: 100, linkedPr: pr('merged') }),
      LINK,
      'tok',
    );

    expect(sentPatch().state).toBe('closed');
  });

  it('closes the issue for done work that has no linked PR at all', async () => {
    // Non-code work — a Susi assessment, an ops task — has no PR. MindBlown
    // is the only thing that can close it, so the old behaviour must stand.
    // It now costs a probe first: "our mirror is empty" is not the same
    // claim as "GitHub has no PR for this issue".
    const probe = probeStub({});
    await updateGitHubIssue(node({ status: 'done', linkedPr: null }), LINK, 'tok', {
      probe,
    });

    expect(probe).toHaveBeenCalled();
    expect(sentPatch().state).toBe('closed');
  });

  it('closes on percentComplete=100 alone when no PR is linked', async () => {
    await updateGitHubIssue(node({ percentComplete: 100 }), LINK, 'tok', {
      probe: probeStub({}),
    });

    expect(sentPatch().state).toBe('closed');
  });

  it('reopens an unfinished node with no linked PR', async () => {
    await updateGitHubIssue(node({ status: 'in_progress', percentComplete: 40 }), LINK, 'tok');

    expect(sentPatch().state).toBe('open');
  });

  it('keeps the issue open when the PR merged off the default branch', async () => {
    // release/v1 hotfix: merged, but NOT on main — the work hasn't
    // landed where GitHub would auto-close, so we must not close either.
    await updateGitHubIssue(
      node({
        status: 'done',
        percentComplete: 100,
        linkedPr: { ...pr('merged'), landedOnDefault: false },
      }),
      LINK,
      'tok',
    );

    expect(sentPatch()).not.toHaveProperty('state');
  });

  it('closes when the node was re-marked done AFTER the PR died', async () => {
    // Livelock escape: abandoned PR (mirror pinned 'closed'), work later
    // ships via direct commit, node re-marked done — the fresh claim
    // postdates the PR death and wins over the stale mirror.
    await updateGitHubIssue(
      node({
        status: 'done',
        percentComplete: 100,
        completedAt: '2026-08-23T10:00:00.000Z',
        linkedPr: { ...pr('closed'), lastSyncedAt: '2026-08-01T00:00:00.000Z' },
      }),
      LINK,
      'tok',
      { probe: probeStub({}) },
    );

    expect(sentPatch().state).toBe('closed');
  });

  it('reopens an unfinished node even while its PR is in flight', async () => {
    // Only the CLOSING direction is gated. A manual node reset to
    // in_progress must be able to reopen a prematurely-closed issue —
    // otherwise the reset can never repair the issue, and the catchup
    // reconciler would even revert the reset (issue closed + node
    // not-done reads as a close transition).
    await updateGitHubIssue(
      node({ status: 'in_progress', percentComplete: 40, linkedPr: pr('open') }),
      LINK,
      'tok',
    );

    expect(sentPatch().state).toBe('open');
  });
});

describe('updateGitHubIssue — the close needs evidence, not a done-flag', () => {
  it('does NOT close when GitHub reports an open PR the mirror never saw', async () => {
    // THE incident. crm#7357 was closed 6 seconds after its PR was
    // created, crm#6305 after 21: the agent marks the node done on PR
    // open, and the `pull_request.opened` webhook has not been applied
    // yet (or the repo isn't subscribed to it at all), so `linkedPr` is
    // null and the mirror gate has nothing to veto with. The probe is
    // what closes that hole.
    const probe = probeStub({
      inFlight: true,
      closingPrs: [
        {
          number: 7794,
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          baseRef: 'main',
          url: 'https://github.com/FulcrumCRM/crm/pull/7794',
        },
      ],
    });

    const result = await updateGitHubIssue(
      node({ status: 'done', percentComplete: 100, linkedPr: null }),
      LINK,
      'tok',
      { probe },
    );

    expect(sentPatch()).not.toHaveProperty('state');
    expect(result.stateAction).toBe('held');
    expect(result.holdReason).toBe('pr_in_flight');
  });

  it('does NOT close when the probe itself fails — no evidence, no close', async () => {
    const result = await updateGitHubIssue(
      node({ status: 'done', percentComplete: 100, linkedPr: null }),
      LINK,
      'tok',
      { probe: async () => { throw new Error('GitHub API 502'); } },
    );

    expect(sentPatch()).not.toHaveProperty('state');
    expect(result.holdReason).toBe('probe_failed');
  });

  it('closes as COMPLETED once the probe finds a merged PR on the default branch', async () => {
    const result = await updateGitHubIssue(
      node({ status: 'done', percentComplete: 100, linkedPr: null }),
      LINK,
      'tok',
      {
        probe: probeStub({
          landed: {
            number: 7794,
            state: 'closed',
            merged: true,
            mergedAt: '2026-08-11T09:00:00.000Z',
            mergeCommitSha: 'deadbeefcafe',
            baseRef: 'main',
            url: 'https://github.com/FulcrumCRM/crm/pull/7794',
          },
        }),
      },
    );

    const patch = sentPatch();
    expect(patch.state).toBe('closed');
    expect(patch.state_reason).toBe('completed');
    // Handed back so the caller can persist it and skip the probe next time.
    expect(result.mergeCommitSha).toBe('deadbeefcafe');
    expect(result.mergedPrNumber).toBe(7794);
  });

  it('closes without probing when the link already carries a merge commit', async () => {
    const probe = probeStub({});
    const result = await updateGitHubIssue(
      node({ status: 'done', percentComplete: 100, linkedPr: null }),
      { ...LINK, mergeCommitSha: 'deadbeefcafe', mergedPrNumber: 7794 },
      'tok',
      { probe },
    );

    expect(probe).not.toHaveBeenCalled();
    expect(sentPatch().state_reason).toBe('completed');
    expect(result.stateAction).toBe('closed_completed');
  });

  it('always names the state_reason explicitly', async () => {
    // GitHub fills an unqualified `state: closed` with COMPLETED. That
    // silent default is the value every one of the incident tickets
    // carries; it must never again be something we let happen by
    // omission.
    await updateGitHubIssue(
      node({ status: 'done', percentComplete: 100, linkedPr: pr('merged') }),
      LINK,
      'tok',
    );

    expect(sentPatch().state_reason).toBe('completed');
  });

  it('does not probe at all while the mirror already vetoes the close', async () => {
    // The cheap local answer must short-circuit the API call.
    const probe = probeStub({});
    await updateGitHubIssue(
      node({ status: 'done', percentComplete: 100, linkedPr: pr('open') }),
      LINK,
      'tok',
      { probe },
    );

    expect(probe).not.toHaveBeenCalled();
  });
});

describe('findClosingPrsForIssue', () => {
  function stubResponses(responses: unknown[]): void {
    let i = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => responses[i++],
      })),
    );
  }

  /**
   * A URL-driven stub for endpoints that page via the `Link` header.
   *
   * Each route either serves a fixed `body` (single response) or a list
   * of `pages`; for the latter the stub advertises the next page as
   * `?after=<index>` in `Link`, and serves page N only at that URL. So a
   * caller that ignores the header sees page 1 and nothing else — which
   * is exactly the failure this fixture has to be able to show.
   */
  function stubLinkedPages(
    routes: Array<{
      match: (url: URL) => boolean;
      pages?: unknown[][];
      body?: unknown;
    }>,
  ) {
    const fetchMock = vi.fn(async (rawUrl: string) => {
      const url = new URL(String(rawUrl));
      const route = routes.find((r) => r.match(url));
      if (!route) throw new Error(`unstubbed URL: ${url}`);

      if (route.pages === undefined) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => route.body,
        };
      }

      const index = Number(url.searchParams.get('after') ?? '0');
      const data = route.pages[index] ?? [];
      const next = new URL(url.toString());
      next.searchParams.set('after', String(index + 1));
      const headers = new Headers(
        index + 1 < route.pages.length
          ? { link: `<${next.toString()}>; rel="next"` }
          : {},
      );
      return { ok: true, status: 200, headers, json: async () => data };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const isTimeline = (u: URL) => u.pathname.endsWith('/timeline');
  const isRepo = (u: URL) => /^\/repos\/[^/]+\/[^/]+$/.test(u.pathname);
  const isPull = (u: URL) => u.pathname.includes('/pulls/');

  function crossRef(prNumber: number, repo = 'FulcrumCRM/crm') {
    return {
      event: 'cross-referenced',
      source: {
        type: 'issue',
        issue: {
          number: prNumber,
          pull_request: { url: 'x' },
          repository: { full_name: repo },
        },
      },
    };
  }

  function prPayload(overrides: Record<string, unknown> = {}) {
    return {
      number: 7794,
      state: 'closed',
      merged: true,
      merged_at: '2026-08-11T09:00:00.000Z',
      merge_commit_sha: 'deadbeefcafe',
      base: { ref: 'main' },
      html_url: 'https://github.com/FulcrumCRM/crm/pull/7794',
      title: 'fix(x): something',
      body: 'Closes #6096',
      ...overrides,
    };
  }

  it('returns a PR whose body carries a closing keyword for the issue', async () => {
    stubResponses([[crossRef(7794)], prPayload()]);

    const prs = await findClosingPrsForIssue('FulcrumCRM', 'crm', 6096, 'tok');

    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      number: 7794,
      merged: true,
      mergeCommitSha: 'deadbeefcafe',
      baseRef: 'main',
    });
  });

  it('drops a PR that merely MENTIONS the issue without a closing keyword', async () => {
    // A cross-reference is not a closing ref. Treating "see #6096" as
    // one would make an unrelated PR count as this ticket's evidence.
    stubResponses([
      [crossRef(7794)],
      prPayload({ body: 'Context: see #6096 for background', title: 'chore: unrelated' }),
    ]);

    expect(await findClosingPrsForIssue('FulcrumCRM', 'crm', 6096, 'tok')).toEqual([]);
  });

  it('ignores cross-references from another repo', async () => {
    stubResponses([[crossRef(7794, 'other/repo')]]);

    expect(await findClosingPrsForIssue('FulcrumCRM', 'crm', 6096, 'tok')).toEqual([]);
  });

  it('ignores cross-references from issues that are not PRs', async () => {
    stubResponses([
      [
        {
          event: 'cross-referenced',
          source: {
            type: 'issue',
            issue: { number: 12, repository: { full_name: 'FulcrumCRM/crm' } },
          },
        },
      ],
    ]);

    expect(await findClosingPrsForIssue('FulcrumCRM', 'crm', 6096, 'tok')).toEqual([]);
  });

  it('treats a merge onto a NON-default branch as not landed', async () => {
    stubResponses([
      { default_branch: 'main' },
      [crossRef(7794)],
      prPayload({ base: { ref: 'release/v1' } }),
    ]);

    const probe = await probeIssueLanded('FulcrumCRM', 'crm', 6096, 'tok');

    expect(probe.closingPrs).toHaveLength(1);
    expect(probe.landed).toBeNull();
  });

  it('finds a cross-reference that sits behind page 1', async () => {
    // The timeline is sorted ASCENDING, so on a long-lived ticket the
    // closing PR is on the LAST page. Reading only page 1 reported "no
    // closing PR" for exactly the issues most likely to have one — and
    // "no closing PR" is what lets the outbound sync close as COMPLETED.
    // This is the one route by which the original incident could return
    // through the new code.
    stubLinkedPages([
      {
        match: isTimeline,
        pages: [[{ event: 'labeled' }], [crossRef(7794)]],
      },
      { match: isPull, body: prPayload() },
    ]);

    const prs = await findClosingPrsForIssue('FulcrumCRM', 'crm', 6096, 'tok');

    expect(prs.map((p) => p.number)).toEqual([7794]);
  });

  it('keeps the NEWEST candidates when more than the lookup cap reference the issue', async () => {
    // 30 cross-references, cap 25. Ascending order means the oldest are
    // first, so a head-cut would resolve mentions from two years ago and
    // discard the PR that actually closed the ticket.
    //
    // The fetch stub answers BY URL, not by call order. A positional
    // stub cannot see this bug at all: it hands back the same payload
    // sequence whichever 25 candidates the code asked for, so the
    // assertion passes under the head-cut too. (It did — the first
    // version of this test survived the mutation.)
    const refs = Array.from({ length: 30 }, (_, i) => crossRef(1000 + i));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const pr = /\/pulls\/(\d+)$/.exec(String(url));
        return {
          ok: true,
          status: 200,
          json: async () =>
            pr
              ? prPayload({ number: Number(pr[1]), body: 'Closes #6096' })
              : refs,
        };
      }),
    );

    const prs = await findClosingPrsForIssue('FulcrumCRM', 'crm', 6096, 'tok');

    expect(prs).toHaveLength(25);
    expect(prs.map((p) => p.number)).toEqual(
      Array.from({ length: 25 }, (_, i) => 1005 + i),
    );
    // The point of the assertion above, stated on its own so it cannot
    // be read past: the most recent reference must survive the cut.
    expect(prs.at(-1)!.number).toBe(1029);
  });

  it('refuses to answer from a partial scan rather than reporting "no PRs"', async () => {
    // 20 pages and GitHub still advertises another. Returning the prefix
    // would read as "nothing references this issue" — the most dangerous
    // possible wrong answer here.
    stubLinkedPages([
      {
        match: isTimeline,
        pages: Array.from({ length: 25 }, () => [{ event: 'labeled' }]),
      },
    ]);

    await expect(
      findClosingPrsForIssue('FulcrumCRM', 'crm', 6096, 'tok'),
    ).rejects.toBeInstanceOf(GitHubScanTruncatedError);
  });

  it('holds the issue open when the scan was truncated', async () => {
    // End-to-end consequence of the throw above: a truncated scan must
    // reach the outbound sync as "no evidence", not as "no PR".
    stubLinkedPages([
      { match: isRepo, body: { default_branch: 'main' } },
      {
        match: isTimeline,
        pages: Array.from({ length: 25 }, () => [{ event: 'labeled' }]),
      },
      { match: (u) => u.pathname.includes('/issues/'), body: { number: 6096 } },
    ]);

    const result = await updateGitHubIssue(
      node({ status: 'done', percentComplete: 100, linkedPr: null }),
      LINK,
      'tok',
    );

    expect(result.stateAction).toBe('held');
    expect(result.holdReason).toBe('probe_failed');
    expect(result.holdError).toContain('GitHubScanTruncatedError');
  });

  it('reports an open closing PR as in flight', async () => {
    stubResponses([
      { default_branch: 'main' },
      [crossRef(7794)],
      prPayload({ state: 'open', merged: false, merged_at: null, merge_commit_sha: null }),
    ]);

    const probe = await probeIssueLanded('FulcrumCRM', 'crm', 6096, 'tok');

    expect(probe.inFlight).toBe(true);
    expect(probe.landed).toBeNull();
  });
});

describe('getIssueCloseEvent', () => {
  it('reports the LATEST close event, with its commit id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          { event: 'closed', actor: { login: 'someone' }, commit_id: null, created_at: '2026-07-01T00:00:00Z' },
          { event: 'reopened', actor: { login: 'someone' } },
          {
            event: 'closed',
            actor: { login: 'mindblown-by-project-li[bot]' },
            commit_id: 'abc123',
            created_at: '2026-08-01T00:00:00Z',
          },
        ],
      })),
    );

    const ev = await getIssueCloseEvent('FulcrumCRM', 'crm', 6096, 'tok');

    expect(ev).toMatchObject({
      actor: 'mindblown-by-project-li[bot]',
      commitId: 'abc123',
      createdAt: '2026-08-01T00:00:00Z',
    });
  });

  it('reports commitId null for an API close — the population the audit hunts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          {
            event: 'closed',
            actor: { login: 'mindblown-by-project-li[bot]' },
            commit_id: null,
            created_at: '2026-08-10T13:09:33Z',
          },
        ],
      })),
    );

    const ev = await getIssueCloseEvent('FulcrumCRM', 'crm', 7357, 'tok');

    expect(ev?.commitId).toBeNull();
  });

  it('reads past page 1 to find the latest close', async () => {
    // The events endpoint is ascending too. Answering from page 1 on a
    // busy issue reports a close that has since been superseded — and
    // both the audit and the abandoned-PR path branch on that close's
    // `commitId` and `stateReason`.
    const fetchMock = vi.fn(async (rawUrl: string) => {
      const url = new URL(String(rawUrl));
      const index = Number(url.searchParams.get('after') ?? '0');
      const pages = [
        [
          {
            event: 'closed',
            actor: { login: 'old' },
            commit_id: null,
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
        [
          {
            event: 'closed',
            actor: { login: 'mindblown-by-project-li[bot]' },
            commit_id: 'newest',
            created_at: '2026-08-30T00:00:00Z',
          },
        ],
      ];
      const next = new URL(url.toString());
      next.searchParams.set('after', String(index + 1));
      return {
        ok: true,
        status: 200,
        headers: new Headers(
          index + 1 < pages.length ? { link: `<${next.toString()}>; rel="next"` } : {},
        ),
        json: async () => pages[index] ?? [],
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const ev = await getIssueCloseEvent('FulcrumCRM', 'crm', 6096, 'tok');

    expect(ev?.commitId).toBe('newest');
  });

  it('returns null when the issue was never closed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [{ event: 'labeled' }],
      })),
    );

    expect(await getIssueCloseEvent('FulcrumCRM', 'crm', 5468, 'tok')).toBeNull();
  });
});

describe('reopenGitHubIssue', () => {
  it('PATCHes state=open with an explicit reopened reason', async () => {
    await reopenGitHubIssue({ externalId: 'FulcrumCRM/crm#6085' }, 'tok');

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(call[0])).toContain('/repos/FulcrumCRM/crm/issues/6085');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({
      state: 'open',
      state_reason: 'reopened',
    });
  });
});

/**
 * The defect this block exists for (crm#10147).
 *
 * On 2026-09-01 the closed-issue audit was run without `since` against a
 * repo of ~10 000 issues and died on:
 *
 *   422 "Pagination with the page parameter is not supported for large
 *        datasets, please use cursor based pagination (after/before)"
 *
 * It came through 1490 tests, two review rounds and 29 mutations for one
 * reason: **no fixture had the size**. Every stub answered whatever page
 * it was asked for, so a `page++` loop and a `Link`-following loop were
 * indistinguishable.
 *
 * `bigRepo()` is that missing fixture. It refuses any request carrying a
 * `page` parameter past the depth limit — as GitHub does — and serves
 * the continuation ONLY at the opaque cursor URL it advertises in its
 * own `Link` header. A loop that counts pages cannot pass it; a loop
 * that follows the header cannot fail it.
 *
 * The stub answers BY URL, never by call order. A positional stub is the
 * trap here: it returns the same sequence regardless of the URL asked
 * for, so it would go green under both implementations. That exact
 * mistake already shipped in this file once (the newest-candidates test
 * in `findClosingPrsForIssue`) and only mutation caught it.
 */
function bigRepo(opts: {
  /** Pages of items, in order. Page 1 is served from the base URL. */
  pages: unknown[][];
  /** Depth at which `?page=N` starts being refused, like GitHub's limit. */
  refusePageParamFrom?: number;
}) {
  const refuseFrom = opts.refusePageParamFrom ?? 2;
  const PAGINATION_422 =
    '{"message":"Pagination with the page parameter is not supported for large ' +
    'datasets, please use cursor based pagination (after/before)"}';

  const fetchMock = vi.fn(async (rawUrl: string) => {
    const url = new URL(String(rawUrl));
    const pageParam = url.searchParams.get('page');
    const cursor = url.searchParams.get('after');

    if (pageParam && Number(pageParam) >= refuseFrom) {
      return {
        ok: false,
        status: 422,
        headers: new Headers(),
        text: async () => PAGINATION_422,
      };
    }

    // Cursor `after=<n>` means "the page with index n" (0-based).
    const index = cursor ? Number(cursor) : 0;
    const data = opts.pages[index] ?? [];
    const hasNext = index + 1 < opts.pages.length;

    // GitHub advertises the NEXT page in the Link header, and on a large
    // dataset it advertises it as a cursor — never as `page=`.
    const nextUrl = new URL(url.toString());
    nextUrl.searchParams.delete('page');
    nextUrl.searchParams.set('after', String(index + 1));
    const headers = new Headers(
      hasNext ? { link: `<${nextUrl.toString()}>; rel="next"` } : {},
    );

    return { ok: true, status: 200, headers, json: async () => data };
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function issuePage(numbers: number[]) {
  return numbers.map((n) => ({
    number: n,
    title: `issue ${n}`,
    state: 'closed',
    updated_at: '2026-08-30T00:00:00Z',
    labels: [],
    milestone: null,
    body: null,
  }));
}

describe('parseLinkNext', () => {
  it('picks rel="next" out of a multi-rel header', () => {
    expect(
      parseLinkNext(
        '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"',
      ),
    ).toBe('https://api.github.com/x?page=2');
  });

  it('reads a cursor-paginated next link the same way', () => {
    // The caller must not care which scheme GitHub chose — that is the
    // whole reason this follows the header instead of building the query.
    expect(
      parseLinkNext('<https://api.github.com/x?after=Y3Vyc29yOnYyOpHOAA%3D%3D>; rel="next"'),
    ).toBe('https://api.github.com/x?after=Y3Vyc29yOnYyOpHOAA%3D%3D');
  });

  it('returns null on the last page and on a missing header', () => {
    expect(parseLinkNext('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(parseLinkNext(null)).toBeNull();
    expect(parseLinkNext(undefined)).toBeNull();
  });

  it('accepts an unquoted rel', () => {
    expect(parseLinkNext('<https://api.github.com/x?page=2>; rel=next')).toBe(
      'https://api.github.com/x?page=2',
    );
  });

  /*
   * The four forms below are the ones that made the first parser answer
   * wrongly, and each is its own case because each fails differently.
   *
   * Three of them return `null` on a header that DOES advertise a next
   * page — and `null` means the paginator stops and reports
   * `truncated: false`, i.e. a prefix presented as the complete list.
   * That is the fail-open shape this whole change set exists to remove,
   * arriving through the parser instead of through the loop.
   */

  it('keeps a target URL that contains a comma', () => {
    // RFC 8288 permits it precisely because `<>` delimits the target.
    // Splitting the header on `,` cut this entry in half and lost the
    // `rel="next"` that followed. `?labels=bug,urgent` is one filter
    // away from any of today's call sites.
    expect(
      parseLinkNext('<https://api.github.com/x?labels=bug,urgent&page=2>; rel="next"'),
    ).toBe('https://api.github.com/x?labels=bug,urgent&page=2');
  });

  it('does NOT treat rel="nextpage" as next', () => {
    // The dangerous direction of the same bug: not a missed page but a
    // followed one. A substring match paged into an unrelated relation.
    expect(parseLinkNext('<https://api.github.com/x?page=2>; rel="nextpage"')).toBeNull();
  });

  it('finds rel when another parameter comes first', () => {
    // The old regex required `rel` immediately after the first `;`.
    expect(
      parseLinkNext(
        '<https://api.github.com/x?page=2>; type="application/json"; rel="next"',
      ),
    ).toBe('https://api.github.com/x?page=2');
  });

  it('keeps a comma inside a QUOTED parameter value', () => {
    // This is the case Ray's proposed `<([^>]*)>\s*;\s*([^,<]*)` still
    // gets wrong: the params blob stops at the comma inside `title`, so
    // `rel="next"` is never seen and the walk silently ends. I measured
    // it before adopting the suggestion — hence the quote-aware scanner
    // rather than a wider regex.
    expect(
      parseLinkNext('<https://api.github.com/x?page=2>; title="Foo, Bar"; rel="next"'),
    ).toBe('https://api.github.com/x?page=2');
  });

  it('handles a space-separated multi-relation rel', () => {
    // RFC 8288 allows `rel="next prev"`. Token comparison covers it;
    // equality against the whole value would not.
    expect(parseLinkNext('<https://api.github.com/x?page=2>; rel="next prev"')).toBe(
      'https://api.github.com/x?page=2',
    );
  });
});

describe('pagination stays on the origin it started on', () => {
  /**
   * MF1. `githubFetchPage` attaches `Authorization: Bearer <token>` to
   * whatever URL it is handed, and before this change set every such URL
   * was built internally. Following `Link` means one now arrives in a
   * response header — so an off-origin `next` would send the
   * installation token to that host, over plain http:// if the header
   * says so.
   *
   * This test is Ray's probe: it records every URL fetched together with
   * the Authorization header it carried, and asserts the token never
   * leaves api.github.com.
   */
  function evilLinkStub(nextUrl: string) {
    const seen: Array<{ url: string; auth: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({
          url: String(url),
          auth: (init?.headers as Record<string, string>)?.Authorization,
        });
        return {
          ok: true,
          status: 200,
          headers: new Headers({ link: `<${nextUrl}>; rel="next"` }),
          json: async () => issuePage([1]),
        };
      }),
    );
    return seen;
  }

  it('refuses to follow a Link pointing at another host', async () => {
    const seen = evilLinkStub('http://evil.example/steal?after=1');

    await expect(
      fetchChangedIssues('FulcrumCRM', 'crm', 'ghs_SUPER_SECRET', null),
    ).rejects.toBeInstanceOf(GitHubCrossOriginPaginationError);

    // The point of the guard, stated as the property that matters: the
    // token was never sent anywhere but GitHub.
    expect(seen).toHaveLength(1);
    for (const call of seen) {
      expect(new URL(call.url).origin).toBe('https://api.github.com');
    }
    expect(seen.some((c) => String(c.url).includes('evil.example'))).toBe(false);
  });

  it('refuses a downgrade to http on the same host', async () => {
    // `http://api.github.com` is a different origin, and the token would
    // go over the wire in clear text.
    evilLinkStub('http://api.github.com/repos/FulcrumCRM/crm/issues?after=1');

    await expect(
      fetchChangedIssues('FulcrumCRM', 'crm', 'tok', null),
    ).rejects.toBeInstanceOf(GitHubCrossOriginPaginationError);
  });

  it('refuses a non-absolute Link target', async () => {
    evilLinkStub('/repos/FulcrumCRM/crm/issues?after=1');

    await expect(
      fetchChangedIssues('FulcrumCRM', 'crm', 'tok', null),
    ).rejects.toBeInstanceOf(GitHubCrossOriginPaginationError);
  });

  it('still follows a same-origin Link', async () => {
    // The guard must not be so tight that it breaks the fix it protects.
    const fetchMock = bigRepo({ pages: [issuePage([1]), issuePage([2])] });

    const result = await fetchChangedIssues('FulcrumCRM', 'crm', 'tok', null);

    expect(result.issues.map((i) => i.number)).toEqual([1, 2]);
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  it('throws rather than quietly returning the first page', async () => {
    // Refusing to follow means the listing is INCOMPLETE. Returning what
    // we have with `truncated: false` would turn a security guard into
    // the exact fail-open this PR removes.
    evilLinkStub('http://evil.example/steal?after=1');

    const err = await fetchChangedIssues('FulcrumCRM', 'crm', 'tok', null).catch((e) => e);

    expect(err).toBeInstanceOf(GitHubCrossOriginPaginationError);
    expect(err.message).toContain('evil.example');
  });
});

describe('pagination on a repo too large for ?page=', () => {
  it('fetchChangedIssues walks past the page limit by following Link', async () => {
    // THE regression. A `page++` loop asks for `?page=2` and gets the
    // 422; only a Link-follower reaches pages 2 and 3.
    bigRepo({ pages: [issuePage([1, 2]), issuePage([3, 4]), issuePage([5])] });

    const result = await fetchChangedIssues('FulcrumCRM', 'crm', 'tok', null);

    expect(result.issues.map((i) => i.number)).toEqual([1, 2, 3, 4, 5]);
    expect(result.truncated).toBe(false);
  });

  it('importGitHubIssues walks past the page limit too', async () => {
    // Same endpoint, second call site — it carried its own copy of the loop.
    bigRepo({ pages: [issuePage([1]), issuePage([2]), issuePage([3])] });

    const imported = await importGitHubIssues('FulcrumCRM', 'crm', 'tok', {
      includeAll: true,
    });

    expect(imported.map((i) => i.issue.number)).toEqual([1, 2, 3]);
  });

  it('never puts a `page` parameter on the wire at all', async () => {
    // The stub only refuses `page >= 2`, so an implementation could
    // sneak page 1 through and still pass the tests above. It must not:
    // the point is that we stop choosing the scheme.
    //
    // Page 1 is deliberately FULL (100 items). A length-driven loop
    // ("a full page means there is another") would append `page=2` here
    // and this assertion is what catches it — with a short first page
    // such a loop stops early and the test goes green for the wrong
    // reason.
    const fetchMock = bigRepo({
      pages: [issuePage(Array.from({ length: 100 }, (_, i) => i + 1)), issuePage([101])],
    });

    await fetchChangedIssues('FulcrumCRM', 'crm', 'tok', null);

    for (const call of fetchMock.mock.calls) {
      expect(new URL(String(call[0])).searchParams.get('page')).toBeNull();
    }
  });

  it('follows the cursor GitHub advertises rather than one we invent', async () => {
    const fetchMock = bigRepo({ pages: [issuePage([1]), issuePage([2])] });

    await fetchChangedIssues('FulcrumCRM', 'crm', 'tok', null);

    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('after=1');
  });

  it('keeps the caller-supplied query across pages (since survives)', async () => {
    // The continuation URL comes from GitHub and already carries the
    // original query; rebuilding it ourselves would silently widen the
    // window.
    const fetchMock = bigRepo({ pages: [issuePage([1]), issuePage([2])] });

    await fetchChangedIssues('FulcrumCRM', 'crm', 'tok', '2026-08-01T00:00:00Z');

    // Assert the plural in the name before asserting the property: the
    // loop below is vacuously true on a single call, so without this the
    // test claims "across pages" while checking one page — the same
    // hollow shape M30 exposed in its sibling.
    expect(fetchMock.mock.calls).toHaveLength(2);
    for (const call of fetchMock.mock.calls) {
      expect(new URL(String(call[0])).searchParams.get('since')).toBe(
        '2026-08-01T00:00:00Z',
      );
    }
  });

  it('the per-issue timeline scan follows Link as well', async () => {
    // fetchAllIssuePages was NOT broken — the depth limit does not reach
    // a single issue's timeline — but it is on the same mechanism now,
    // so this file has one way to paginate instead of two.
    const fetchMock = vi.fn(async (rawUrl: string) => {
      const url = new URL(String(rawUrl));
      if (url.pathname.endsWith('/timeline')) {
        const after = url.searchParams.get('after');
        if (!after) {
          const next = new URL(url.toString());
          next.searchParams.set('after', '1');
          return {
            ok: true,
            status: 200,
            headers: new Headers({ link: `<${next.toString()}>; rel="next"` }),
            json: async () => [{ event: 'labeled' }],
          };
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => [
            {
              event: 'cross-referenced',
              source: {
                type: 'issue',
                issue: {
                  number: 7794,
                  pull_request: { url: 'x' },
                  repository: { full_name: 'FulcrumCRM/crm' },
                },
              },
            },
          ],
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          number: 7794,
          state: 'closed',
          merged: true,
          merged_at: '2026-08-11T09:00:00.000Z',
          merge_commit_sha: 'deadbeefcafe',
          base: { ref: 'main' },
          html_url: 'u',
          title: 't',
          body: 'Closes #6096',
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const prs = await findClosingPrsForIssue('FulcrumCRM', 'crm', 6096, 'tok');

    expect(prs.map((p) => p.number)).toEqual([7794]);
  });
});

describe('GitHubPaginationLimitError', () => {
  it('turns the raw 422 into a message that names the way out', async () => {
    // Until this fix reaches an instance, the message IS the operator's
    // only self-help. The raw body names the mechanism ("use cursor
    // based pagination") but not the parameter that avoids the problem
    // from the caller's side.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 422,
        headers: new Headers(),
        text: async () =>
          '{"message":"Pagination with the page parameter is not supported for large datasets, please use cursor based pagination (after/before)"}',
      })),
    );

    const err = await fetchChangedIssues('FulcrumCRM', 'crm', 'tok', null).catch((e) => e);

    expect(err).toBeInstanceOf(GitHubPaginationLimitError);
    expect(err.status).toBe(422);
    expect(err.message).toContain('since');
    expect(err.message).toContain('Original:');
  });

  it('leaves every other 422 as a plain GitHubApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 422,
        headers: new Headers(),
        text: async () => '{"message":"Validation Failed"}',
      })),
    );

    const err = await fetchChangedIssues('FulcrumCRM', 'crm', 'tok', null).catch((e) => e);

    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err).not.toBeInstanceOf(GitHubPaginationLimitError);
  });
});
