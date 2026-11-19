import { describe, it, expect } from 'vitest';
import { groupBlockers, classifyBlocker } from '../blockers.js';

describe('groupBlockers (#322)', () => {
  it('one group per cause, decisions per named person, predecessors as their own group; orphans first', () => {
    const groups = groupBlockers([
      { id: 'a', blockedReason: 'PR green, cannot merge: CI red on main', predecessorIds: [] },
      { id: 'b', blockedReason: 'CI is red on main again', predecessorIds: [] },
      { id: 'c', blockedReason: 'Waiting on Thomas for the gate wording', predecessorIds: [] },
      { id: 'd', blockedReason: 'Claim swept off worker, in_progress with nobody on it', predecessorIds: [] },
      { id: 'e', blockedReason: null, predecessorIds: ['x'] },
      { id: 'f', blockedReason: 'something unusual', predecessorIds: [] },
    ]);
    expect(groups.map((g) => [g.kind, g.nodeIds])).toEqual([
      ['orphaned_claim', ['d']],
      ['merge_blocked', ['a', 'b']],
      ['decision', ['c']],
      ['dependency', ['e']],
      ['other', ['f']],
    ]);
    expect(groups.find((g) => g.kind === 'decision')).toMatchObject({ unblocker: 'Thomas' });
  });

  it('stalled leaves get their own group, ranked first; a reason or predecessor wins over the flag', () => {
    const groups = groupBlockers([
      { id: 'a', blockedReason: 'CI is red on main', predecessorIds: [] },
      { id: 's1', blockedReason: null, predecessorIds: [], stalled: true },
      { id: 's2', blockedReason: null, predecessorIds: [], stalled: true },
      { id: 'w', blockedReason: null, predecessorIds: ['x'], stalled: true },
    ]);
    expect(groups.map((g) => [g.kind, g.nodeIds])).toEqual([
      ['stalled', ['s1', 's2']],
      ['merge_blocked', ['a']],
      ['dependency', ['w']],
    ]);
    expect(groups[0].label).toBe('Stalled — in progress, nobody working on it');
  });

  it('classifies the vocabulary', () => {
    expect(classifyBlocker('awaiting review on the PR')).toBe('pr_open');
    expect(classifyBlocker('Vendor has not answered')).toBe('external');
    // The fleet worker's own notes (claude-fleet fleet-worker land_pr) are merge blocks, not reviews.
    expect(classifyBlocker('Fleet worker x: CI failed on PR #995 (445fab60). Fix the branch or close the PR; it merges by itself once CI is green.')).toBe('merge_blocked');
    expect(classifyBlocker('Fleet worker x: PR #22 has merge conflicts with its base. Resolve them.')).toBe('merge_blocked');
  });
});
