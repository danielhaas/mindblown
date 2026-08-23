import { describe, it, expect } from 'vitest';
import { prBlocksIssueClose, prBlocksNodeReopen } from '../linkedPr.js';
import type { LinkedPrState } from '../types.js';

function pr(state: LinkedPrState['state']): LinkedPrState {
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
    lastSyncedAt: '2026-08-23T00:00:00.000Z',
  };
}

describe('prBlocksIssueClose', () => {
  it('blocks while the PR is in flight', () => {
    expect(prBlocksIssueClose(pr('open'))).toBe(true);
  });

  it('blocks after an abandoned close — the work never landed', () => {
    expect(prBlocksIssueClose(pr('closed'))).toBe(true);
  });

  it('does not block once merged', () => {
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

  it('allows the reset once the PR died unmerged', () => {
    expect(prBlocksNodeReopen(pr('closed'), false)).toBe(false);
  });

  it('allows without a mirror', () => {
    expect(prBlocksNodeReopen(null, false)).toBe(false);
  });
});
