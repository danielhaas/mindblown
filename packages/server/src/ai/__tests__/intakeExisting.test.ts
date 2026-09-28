/**
 * The facts the intake model gets about existing work (#409): what a node
 * hit says about itself, when a done ticket counts as "fixed by a merged
 * PR", how forge-only hits are listed, and the keyword query the forge
 * search gets from a prose description.
 */

import { describe, it, expect } from 'vitest';
import type { Node as CoreNode } from '@mindblown/core';
import { nodeMatchFacts, describeNodeMatch, preSearchLines, keywordQuery } from '../intakeExisting.js';

function node(over: Partial<CoreNode> & { id: string; text: string }): CoreNode {
  return {
    mapId: 'm1',
    parentId: 'r1',
    childrenIds: [],
    description: null,
    status: null,
    percentComplete: null,
    completedAt: null,
    externalLinks: [],
    linkedPr: null,
    ...over,
  } as unknown as CoreNode;
}

const issueLink = (n: number, state: 'open' | 'closed', extra: Record<string, unknown> = {}) => ({
  provider: 'github',
  externalId: `o/r#${n}`,
  url: `https://x/${n}`,
  syncEnabled: true,
  lastSyncedAt: null,
  state,
  ...extra,
});

describe('nodeMatchFacts', () => {
  it('reads status, done date and the linked issue', () => {
    const f = nodeMatchFacts(
      node({ id: 'a', text: 'A', status: 'done', completedAt: '2026-09-01T00:00:00Z', externalLinks: [issueLink(42, 'closed')] }),
    );
    expect(f).toEqual({ status: 'done', closedAt: '2026-09-01T00:00:00Z', issueNumber: 42, issueUrl: 'https://x/42', issueState: 'closed', fixedByPr: false });
  });

  it('done + merged PR that landed = fixed by PR; done by hand is not', () => {
    const shipped = nodeMatchFacts(
      node({
        id: 'a', text: 'A', status: 'done', completedAt: '2026-09-01T00:00:00Z',
        linkedPr: { number: 9, repo: 'o/r', url: '', head: 'h', base: 'main', author: null, draft: false, state: 'merged' } as never,
      }),
    );
    expect(shipped.fixedByPr).toBe(true);
    const viaLink = nodeMatchFacts(
      node({ id: 'b', text: 'B', status: 'done', externalLinks: [issueLink(3, 'closed', { mergeCommitSha: 'abc' })] }),
    );
    expect(viaLink.fixedByPr).toBe(true);
    const byHand = nodeMatchFacts(node({ id: 'c', text: 'C', status: 'done', completedAt: '2026-09-01T00:00:00Z' }));
    expect(byHand.fixedByPr).toBe(false);
    // Merged but still open by the close gate's rules (merged off the default branch) is not shipped.
    const offDefault = nodeMatchFacts(
      node({
        id: 'd', text: 'D', status: 'done',
        linkedPr: { number: 9, repo: 'o/r', url: '', head: 'h', base: 'release/v1', author: null, draft: false, state: 'merged', landedOnDefault: false } as never,
      }),
    );
    expect(offDefault.fixedByPr).toBe(false);
  });

  it('ignores a PR link when looking for the issue', () => {
    const f = nodeMatchFacts(node({ id: 'a', text: 'A', externalLinks: [issueLink(5, 'open', { isPullRequest: true })] }));
    expect(f.issueNumber).toBeNull();
  });
});

describe('describeNodeMatch', () => {
  it('is one readable clause list', () => {
    const line = describeNodeMatch(
      node({
        id: 'a', text: 'A', status: 'done', completedAt: '2026-09-01T00:00:00Z',
        externalLinks: [issueLink(42, 'closed', { mergeCommitSha: 'abc' })],
      }),
    );
    expect(line).toBe('status done, done 2026-09-01, issue #42 closed, fixed by a merged PR');
    expect(describeNodeMatch(node({ id: 'b', text: 'B' }))).toBe('no status');
  });
});

describe('preSearchLines', () => {
  it('lists node hits with facts, then forge hits not linked to any node', () => {
    const nodes = [
      node({ id: 'a', text: 'Close issue on merge', status: 'done', completedAt: '2026-09-01T00:00:00Z', externalLinks: [issueLink(42, 'closed')] }),
      node({ id: 'b', text: 'Other', externalLinks: [issueLink(50, 'open')] }),
    ];
    const lines = preSearchLines({
      nodeHits: [{ nodeId: 'a', score: 0.71 }, { nodeId: 'gone', score: 0.9 }],
      forgeHits: [
        { number: 50, title: 'Other on GH', state: 'open', closedAt: null, url: 'u', externalId: 'o/r#50' },
        { number: 77, title: 'Never imported', state: 'closed', closedAt: '2026-08-02T00:00:00Z', url: 'u', externalId: 'o/r#77' },
      ],
      nodes,
    });
    expect(lines).toEqual([
      '1. "Close issue on merge" [a] — status done, done 2026-09-01, issue #42 closed; similarity 0.71',
      '2. issue #77 "Never imported" — closed (closed 2026-08-02), NOT in this map',
    ]);
  });
});

describe('keywordQuery', () => {
  it('keeps a few long, non-stopword terms', () => {
    const words = keywordQuery('When a PR is merged the linked issue should close, but only if no other PR is still open for it.').split(' ');
    expect(words.length).toBeLessThanOrEqual(5);
    expect(words).toContain('merged');
    expect(words).toContain('linked');
    expect(words).not.toContain('the');
    expect(words).not.toContain('should');
  });

  it('handles German and empty input', () => {
    expect(keywordQuery('Der Webhook schliesst das Issue nicht')).toBe('schliesst webhook issue');
    expect(keywordQuery('a b c')).toBe('');
  });
});
