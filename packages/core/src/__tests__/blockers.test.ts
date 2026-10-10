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

  it('classifies the vocabulary', () => {
    expect(classifyBlocker('awaiting review on the PR')).toBe('pr_open');
    expect(classifyBlocker('Vendor has not answered')).toBe('external');
  });
});
