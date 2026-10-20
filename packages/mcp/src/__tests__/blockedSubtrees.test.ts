import { describe, it, expect } from 'vitest';
import { blockedBelowCounts } from '../blockedSubtrees.js';

describe('blocked_digest subtree counts', () => {
  // root → inbox → {open, done}; the done leaf keeps its blockedReason but is
  // already filtered out of the blocked list, so it must not count (Sonarpipe: 3 vs 1).
  const nodes = [
    { id: 'root', parentId: null },
    { id: 'inbox', parentId: 'root' },
    { id: 'open', parentId: 'inbox' },
    { id: 'done', parentId: 'inbox' },
  ];

  it('counts only the leaves it is given, on every ancestor', () => {
    const counts = blockedBelowCounts([nodes[2]], nodes);
    expect(counts.get('inbox')).toBe(1);
    expect(counts.get('root')).toBe(1);
    expect(counts.has('open')).toBe(false);
  });

  it('is empty when nothing is blocked', () => {
    expect(blockedBelowCounts([], nodes).size).toBe(0);
  });
});
