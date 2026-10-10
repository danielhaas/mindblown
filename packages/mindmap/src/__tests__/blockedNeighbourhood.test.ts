/**
 * Blocked panel "Around selected" (#322): what a node waits on (unfinished
 * predecessors, transitively) and what waits on it (dependents, transitively).
 */
import { describe, it, expect } from 'vitest';
import type { Node, ComputedNodeValues } from '@mindblown/core';
import { dependencyNeighbourhood } from '../blockedNeighbourhood.js';

const n = (id: string, deps: string[] = [], pct = 0) =>
  ({ id, text: id, percentComplete: pct, dependencies: deps.map((t) => ({ targetNodeId: t, type: 'FS', lag: 0 })) }) as unknown as Node;

describe('dependencyNeighbourhood', () => {
  it('upstream follows unfinished predecessors; downstream follows every dependent', () => {
    // a ← b ← c ← d ; b also depends on done x
    const nodes = Object.fromEntries(
      [n('a'), n('x', [], 100), n('b', ['a', 'x']), n('c', ['b']), n('d', ['c'])].map((m) => [m.id, m]),
    );
    const computed = new Map<string, ComputedNodeValues>();
    const r = dependencyNeighbourhood(nodes, computed, 'c');
    expect(r.upstream.map((m) => m.id)).toEqual(['b', 'a']); // done x left out
    expect(r.downstream.map((m) => m.id)).toEqual(['d']);
  });

  it('survives cycles', () => {
    const nodes = Object.fromEntries([n('a', ['b']), n('b', ['a'])].map((m) => [m.id, m]));
    const r = dependencyNeighbourhood(nodes, new Map(), 'a');
    expect(r.upstream.map((m) => m.id)).toEqual(['b']);
    expect(r.downstream.map((m) => m.id)).toEqual(['b']);
  });
});
