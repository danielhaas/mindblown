import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { ExternalLink, LinkedPrState, Node } from '@mindblown/core';
import {
  updateGitHubIssue,
  reopenGitHubIssue,
  findClosingPrsForIssue,
  probeIssueLanded,
  getIssueCloseEvent,
  GitHubScanTruncatedError,
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
    const page1 = Array.from({ length: 100 }, () => ({ event: 'labeled' }));
    stubResponses([page1, [crossRef(7794)], prPayload()]);

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
    // 20 full pages and still no end in sight. Returning the prefix
    // would read as "nothing references this issue" — the most dangerous
    // possible wrong answer here.
    const fullPage = Array.from({ length: 100 }, () => ({ event: 'labeled' }));
    stubResponses(Array.from({ length: 25 }, () => fullPage));

    await expect(
      findClosingPrsForIssue('FulcrumCRM', 'crm', 6096, 'tok'),
    ).rejects.toBeInstanceOf(GitHubScanTruncatedError);
  });

  it('holds the issue open when the scan was truncated', async () => {
    // End-to-end consequence of the throw above: a truncated scan must
    // reach the outbound sync as "no evidence", not as "no PR".
    const fullPage = Array.from({ length: 100 }, () => ({ event: 'labeled' }));
    stubResponses([
      { default_branch: 'main' },
      ...Array.from({ length: 25 }, () => fullPage),
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
    const page1 = Array.from({ length: 100 }, (_, i) =>
      i === 0
        ? { event: 'closed', actor: { login: 'old' }, commit_id: null, created_at: '2026-01-01T00:00:00Z' }
        : { event: 'labeled' },
    );
    vi.stubGlobal(
      'fetch',
      (() => {
        const pages = [
          page1,
          [
            {
              event: 'closed',
              actor: { login: 'mindblown-by-project-li[bot]' },
              commit_id: 'newest',
              created_at: '2026-08-30T00:00:00Z',
            },
          ],
        ];
        let i = 0;
        return vi.fn(async () => ({ ok: true, status: 200, json: async () => pages[i++] }));
      })(),
    );

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
