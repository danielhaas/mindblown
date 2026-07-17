import { describe, it, expect } from 'vitest';
import type { Node } from '@mindblown/core';
import { collectScopeMatches, hasActiveScopeFilter } from '../scopeFilter.js';
import type { ScopeFilters } from '../scopeFilter.js';

/**
 * Unit tests for the shared version/sprint/phase scope walk. This is the
 * exact code path KanbanView and GanttView use to pre-filter their rows
 * (they consume the DIRECT match set without ancestor expansion), and
 * the store's getVisibleNodes builds on it too — so the inheritance
 * semantics pinned here hold for every view.
 */

function makeNode(id: string, parentId: string | null, overrides: Partial<Node> = {}): Node {
  return {
    id,
    mapId: 'm1',
    parentId,
    childrenIds: [],
    text: id,
    versionId: null,
    cycleId: null,
    phaseId: null,
    ...overrides,
  } as Node;
}

/**
 * Tree (same shape as the viewScope fixture):
 *   root
 *   ├─ epicA (versionId v1, phaseId p1)
 *   │   ├─ a1  untagged → inherits v1 + p1
 *   │   └─ a2  versionId v2 (overrides), inherits p1
 *   └─ epicB (untagged)
 *       ├─ b1  versionId v1, cycleId c1, phaseId p2
 *       └─ b2  untagged
 */
function buildNodes(): Record<string, Node> {
  return {
    root: makeNode('root', null, { childrenIds: ['epicA', 'epicB'] }),
    epicA: makeNode('epicA', 'root', { childrenIds: ['a1', 'a2'], versionId: 'v1', phaseId: 'p1' }),
    epicB: makeNode('epicB', 'root', { childrenIds: ['b1', 'b2'] }),
    a1: makeNode('a1', 'epicA'),
    a2: makeNode('a2', 'epicA', { versionId: 'v2' }),
    b1: makeNode('b1', 'epicB', { versionId: 'v1', cycleId: 'c1', phaseId: 'p2' }),
    b2: makeNode('b2', 'epicB'),
  };
}

const NO_FILTERS: ScopeFilters = { versionId: null, cycleId: null, phaseId: null };

function matchIds(filters: Partial<ScopeFilters>): string[] {
  return [...collectScopeMatches(buildNodes(), 'root', { ...NO_FILTERS, ...filters })].sort();
}

describe('hasActiveScopeFilter', () => {
  it('is false when all filters are null', () => {
    expect(hasActiveScopeFilter(NO_FILTERS)).toBe(false);
  });

  it('is true when any single filter is set', () => {
    expect(hasActiveScopeFilter({ ...NO_FILTERS, versionId: 'v1' })).toBe(true);
    expect(hasActiveScopeFilter({ ...NO_FILTERS, cycleId: 'c1' })).toBe(true);
    expect(hasActiveScopeFilter({ ...NO_FILTERS, phaseId: 'p1' })).toBe(true);
  });
});

describe('collectScopeMatches', () => {
  it('returns an empty set when no filter is active (callers must guard)', () => {
    expect(matchIds({})).toEqual([]);
  });

  it('version filter matches tagged nodes and untagged descendants (inheritance), child override wins', () => {
    // a1 inherits v1 from epicA; a2's own v2 overrides → out; b1 tagged v1 directly.
    expect(matchIds({ versionId: 'v1' })).toEqual(['a1', 'b1', 'epicA']);
    expect(matchIds({ versionId: 'v2' })).toEqual(['a2']);
  });

  it('phase filter uses the identical inheritance semantics', () => {
    // a1 AND a2 inherit p1 from epicA — a2's version override is irrelevant here.
    expect(matchIds({ phaseId: 'p1' })).toEqual(['a1', 'a2', 'epicA']);
    expect(matchIds({ phaseId: 'p2' })).toEqual(['b1']);
  });

  it('cycle filter matches only the tagged subtree', () => {
    expect(matchIds({ cycleId: 'c1' })).toEqual(['b1']);
  });

  it('multiple filters combine with AND', () => {
    // version v1 AND phase p1: epicA + a1 (a2 fails version, b1 fails phase).
    expect(matchIds({ versionId: 'v1', phaseId: 'p1' })).toEqual(['a1', 'epicA']);
    // version v2 AND phase p1: only a2 (own v2, inherited p1).
    expect(matchIds({ versionId: 'v2', phaseId: 'p1' })).toEqual(['a2']);
    // phase p2 AND cycle c1: only b1 carries both.
    expect(matchIds({ phaseId: 'p2', cycleId: 'c1' })).toEqual(['b1']);
    // all three: b1 matches; adding a phase that nothing shares with c1 empties it.
    expect(matchIds({ versionId: 'v1', cycleId: 'c1', phaseId: 'p2' })).toEqual(['b1']);
    expect(matchIds({ versionId: 'v1', cycleId: 'c1', phaseId: 'p1' })).toEqual([]);
  });

  it('a filter value matching nothing yields the empty set', () => {
    expect(matchIds({ phaseId: 'p999' })).toEqual([]);
    expect(matchIds({ versionId: 'v999' })).toEqual([]);
  });

  it('tolerates a missing root id', () => {
    expect([...collectScopeMatches(buildNodes(), 'nope', { ...NO_FILTERS, phaseId: 'p1' })]).toEqual([]);
  });
});
