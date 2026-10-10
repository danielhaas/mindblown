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

  it('only finish-to-start links count; downstream keeps finished dependents', () => {
    const ss = { id: 'b', text: 'b', percentComplete: 0, dependencies: [{ targetNodeId: 'a', type: 'SS', lag: 0 }] } as unknown as Node;
    const nodes = Object.fromEntries([n('a'), ss, n('c', ['a'], 100)].map((m) => [m.id, m]));
    const up = dependencyNeighbourhood(nodes, new Map(), 'b');
    expect(up.upstream).toEqual([]); // SS predecessor does not block
    const down = dependencyNeighbourhood(nodes, new Map(), 'a');
    expect(down.downstream.map((m) => m.id)).toEqual(['c']); // done dependent kept, SS dependent not
  });

  it('survives cycles', () => {
    const nodes = Object.fromEntries([n('a', ['b']), n('b', ['a'])].map((m) => [m.id, m]));
    const r = dependencyNeighbourhood(nodes, new Map(), 'a');
    expect(r.upstream.map((m) => m.id)).toEqual(['b']);
    expect(r.downstream.map((m) => m.id)).toEqual(['b']);
  });
});
