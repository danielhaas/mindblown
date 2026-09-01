import { describe, it, expect } from 'vitest';
import {
  prBlocksIssueClose,
  prBlocksNodeReopen,
  hasCloseSnapshot,
  issueCloseAction,
} from '../linkedPr.js';
import type { ExternalLink, LinkedPrState } from '../types.js';

const PR_CLOSED_AT = '2026-08-23T00:00:00.000Z';
const BEFORE_CLOSE = '2026-08-22T00:00:00.000Z';
const AFTER_CLOSE = '2026-08-23T12:00:00.000Z';

function pr(
  state: LinkedPrState['state'],
  extra: Partial<LinkedPrState> = {},
): LinkedPrState {
  return {
    number: 1,
    repo: 'o/r',
    url: 'u',
    head: 'h',
    base: 'main',
    author: null,
    draft: false,
    state,
    mergeable: null,
    changedFiles: [],
    reviews: [],
    checks: { state: null, failures: [] },
    lastSyncedAt: PR_CLOSED_AT,
    ...extra,
  };
}

describe('prBlocksIssueClose', () => {
  it('blocks while the PR is in flight', () => {
    expect(prBlocksIssueClose(pr('open'))).toBe(true);
  });

  it('blocks after an abandoned close — the work never landed', () => {
    expect(prBlocksIssueClose(pr('closed'))).toBe(true);
    expect(prBlocksIssueClose(pr('closed'), BEFORE_CLOSE)).toBe(true);
  });

  it('yields to a done-claim made AFTER the PR died (no livelock)', () => {
    expect(prBlocksIssueClose(pr('closed'), AFTER_CLOSE)).toBe(false);
  });

  it('blocks a merge that did not land on the default branch', () => {
    expect(prBlocksIssueClose(pr('merged', { landedOnDefault: false }))).toBe(true);
  });

  it('does not block once merged (legacy mirrors without the flag included)', () => {
    expect(prBlocksIssueClose(pr('merged'))).toBe(false);
  });

  it('does not block without a mirror', () => {
    expect(prBlocksIssueClose(null)).toBe(false);
    expect(prBlocksIssueClose(undefined)).toBe(false);
  });
});

describe('prBlocksNodeReopen', () => {
  it('blocks only for an in-flight PR with no snapshot', () => {
    expect(prBlocksNodeReopen(pr('open'), false)).toBe(true);
  });

  it('allows a lossless restore when a snapshot exists', () => {
    expect(prBlocksNodeReopen(pr('open'), true)).toBe(false);
  });

  it('allows the reset once the PR died unmerged (stale done-claim)', () => {
    expect(prBlocksNodeReopen(pr('closed'), false)).toBe(false);
    expect(prBlocksNodeReopen(pr('closed'), false, BEFORE_CLOSE)).toBe(false);
  });

  it('honors a done-claim made AFTER the PR died (no flip-flop)', () => {
    expect(prBlocksNodeReopen(pr('closed'), false, AFTER_CLOSE)).toBe(true);
  });

  it('protects shipped release work (merged off the default branch)', () => {
    expect(prBlocksNodeReopen(pr('merged', { landedOnDefault: false }), false)).toBe(true);
  });

  it('allows without a mirror', () => {
    expect(prBlocksNodeReopen(null, false)).toBe(false);
  });
});

describe('issueCloseAction', () => {
  const link = (extra: Partial<ExternalLink> = {}): ExternalLink =>
    ({
      provider: 'github',
      externalId: 'o/r#1',
      url: 'u',
      syncEnabled: true,
      lastSyncedAt: null,
      ...extra,
    }) as ExternalLink;

  it('closes on a recorded merge commit — the only hard local evidence', () => {
    expect(issueCloseAction(null, link({ mergeCommitSha: 'abc123' }))).toEqual({
      kind: 'close',
      stateReason: 'completed',
      because: 'merge_commit',
    });
  });

  it('trusts the merge commit even while a PR mirror is armed', () => {
    // A follow-up PR opened after the work landed must not re-hide a
    // legitimately shipped ticket.
    expect(
      issueCloseAction(pr('open'), link({ mergeCommitSha: 'abc123' })),
    ).toEqual({ kind: 'close', stateReason: 'completed', because: 'merge_commit' });
  });

  it('holds while the mirror shows a PR that has not landed', () => {
    expect(issueCloseAction(pr('open'), link())).toEqual({
      kind: 'hold',
      because: 'pr_not_landed',
    });
    expect(issueCloseAction(pr('closed'), link())).toEqual({
      kind: 'hold',
      because: 'pr_not_landed',
    });
    expect(
      issueCloseAction(pr('merged', { landedOnDefault: false }), link()),
    ).toEqual({ kind: 'hold', because: 'pr_not_landed' });
  });

  it('closes on a mirror that survived as a default-branch merge', () => {
    expect(issueCloseAction(pr('merged'), link())).toEqual({
      kind: 'close',
      stateReason: 'completed',
      because: 'mirror_merged',
    });
  });

  it('demands a probe when nothing local says the work landed', () => {
    // THE incident shape: node marked done seconds after the PR opened,
    // the `pull_request.opened` webhook not applied yet, so no mirror.
    // The old gate read that as "no PR exists" and closed COMPLETED.
    expect(issueCloseAction(null, link())).toEqual({ kind: 'probe' });
    expect(issueCloseAction(undefined, undefined)).toEqual({ kind: 'probe' });
  });

  it('probes rather than holds when a later done-claim supersedes a dead PR', () => {
    // The livelock escape has to survive the new decision layer: an
    // abandoned PR plus a fresher done-claim must still be able to
    // reach a close (via the probe), not sit blocked forever.
    expect(
      issueCloseAction(
        { ...pr('closed'), lastSyncedAt: PR_CLOSED_AT },
        link(),
        AFTER_CLOSE,
      ),
    ).toEqual({ kind: 'probe' });
  });
});

describe('hasCloseSnapshot', () => {
  it('detects either captured field, treating null/undefined as absent', () => {
    expect(hasCloseSnapshot({ previousPercentComplete: 40, previousStatus: null })).toBe(true);
    expect(hasCloseSnapshot({ previousPercentComplete: 0, previousStatus: null })).toBe(true);
    expect(hasCloseSnapshot({ previousPercentComplete: null, previousStatus: 'todo' })).toBe(true);
    expect(hasCloseSnapshot({ previousPercentComplete: null, previousStatus: null })).toBe(false);
    expect(hasCloseSnapshot({})).toBe(false);
  });
});
