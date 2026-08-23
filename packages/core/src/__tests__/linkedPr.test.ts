import { describe, it, expect } from 'vitest';
import { prBlocksIssueClose, prBlocksNodeReopen, hasCloseSnapshot } from '../linkedPr.js';
import type { LinkedPrState } from '../types.js';

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

describe('hasCloseSnapshot', () => {
  it('detects either captured field, treating null/undefined as absent', () => {
    expect(hasCloseSnapshot({ previousPercentComplete: 40, previousStatus: null })).toBe(true);
    expect(hasCloseSnapshot({ previousPercentComplete: 0, previousStatus: null })).toBe(true);
    expect(hasCloseSnapshot({ previousPercentComplete: null, previousStatus: 'todo' })).toBe(true);
    expect(hasCloseSnapshot({ previousPercentComplete: null, previousStatus: null })).toBe(false);
    expect(hasCloseSnapshot({})).toBe(false);
  });
});
