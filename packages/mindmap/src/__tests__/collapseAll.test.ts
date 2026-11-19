import { describe, it, expect, beforeEach } from 'vitest';
import type { Node } from '@mindblown/core';

// The store module reads localStorage at import time (auth-token bootstrap);
// shim it for the node test environment BEFORE the dynamic import below.
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    get length() {
      return mem.size;
    },
  } as Storage;
}

const { useMindmapStore } = await import('../store.js');

function makeNode(id: string, parentId: string | null, childrenIds: string[] = []): Node {
  return { id, mapId: 'm1', parentId, childrenIds, text: id, collapsed: false } as unknown as Node;
}

/**
 *   root
 *   ├─ a
 *   │   ├─ a1
 *   │   │   └─ a1x
 *   │   └─ a2
 *   └─ b
 *       └─ b1
 *           └─ b1x
 */
function fixture(): Record<string, Node> {
  return {
    root: makeNode('root', null, ['a', 'b']),
    a: makeNode('a', 'root', ['a1', 'a2']),
    a1: makeNode('a1', 'a', ['a1x']),
    a1x: makeNode('a1x', 'a1'),
    a2: makeNode('a2', 'a'),
    b: makeNode('b', 'root', ['b1']),
    b1: makeNode('b1', 'b', ['b1x']),
    b1x: makeNode('b1x', 'b1'),
  };
}

const visibleIds = () =>
  useMindmapStore
    .getState()
    .getVisibleNodes()
    .filter((v) => !v.isDimmed)
    .map((v) => v.node.id)
    .sort();

beforeEach(() => {
  useMindmapStore.setState({
    nodes: fixture(),
    rootNodeId: 'root',
    focusNodeId: null,
    maxDepth: 0,
    activeVersionFilter: null,
    activeCycleFilter: null,
    activePhaseFilter: null,
  });
});

describe('collapseAll / expandAll', () => {
  it('collapse all leaves only the first level visible', () => {
    useMindmapStore.getState().collapseAll();
    expect(visibleIds()).toEqual(['a', 'b', 'root']);
    expect(useMindmapStore.getState().nodes.root.collapsed).toBe(false);
  });

  it('collapse all reopens a collapsed root so the first level still shows', () => {
    const { nodes } = useMindmapStore.getState();
    useMindmapStore.setState({ nodes: { ...nodes, root: { ...nodes.root, collapsed: true } } });
    useMindmapStore.getState().collapseAll();
    expect(visibleIds()).toEqual(['a', 'b', 'root']);
  });

  it('expand all makes every node visible', () => {
    useMindmapStore.getState().collapseAll();
    useMindmapStore.getState().expandAll();
    expect(visibleIds()).toEqual(Object.keys(fixture()).sort());
  });

  it('drilled in, both act on the visible subtree only', () => {
    useMindmapStore.setState({ focusNodeId: 'a' });
    useMindmapStore.getState().collapseAll();
    let { nodes } = useMindmapStore.getState();
    expect(nodes.a.collapsed).toBe(false);
    expect(nodes.a1.collapsed).toBe(true);
    expect(nodes.b.collapsed).toBe(false);
    expect(nodes.b1.collapsed).toBe(false);

    // Fold b's branch outside the focus, then expand all inside a.
    useMindmapStore.setState({ nodes: { ...nodes, b1: { ...nodes.b1, collapsed: true } } });
    useMindmapStore.getState().expandAll();
    ({ nodes } = useMindmapStore.getState());
    expect(nodes.a1.collapsed).toBe(false);
    expect(nodes.b1.collapsed).toBe(true);
  });

  it('a 500-node map changes in one store update', () => {
    const nodes: Record<string, Node> = { root: makeNode('root', null) };
    // 50 branches × 9 children, every third child with one grandchild → 500 nodes.
    let count = 1;
    for (let i = 0; count < 500; i++) {
      const bid = `b${i}`;
      nodes[bid] = makeNode(bid, 'root');
      nodes.root.childrenIds.push(bid);
      count++;
      for (let j = 0; j < 9 && count < 500; j++) {
        const cid = `${bid}-${j}`;
        nodes[cid] = makeNode(cid, bid);
        nodes[bid].childrenIds.push(cid);
        count++;
        if (j % 3 === 0 && count < 500) {
          const gid = `${cid}-g`;
          nodes[gid] = makeNode(gid, cid);
          nodes[cid].childrenIds.push(gid);
          count++;
        }
      }
    }
    expect(Object.keys(nodes)).toHaveLength(500);
    useMindmapStore.setState({ nodes });

    let updates = 0;
    const unsub = useMindmapStore.subscribe(() => { updates++; });
    useMindmapStore.getState().collapseAll();
    expect(updates).toBe(1);
    expect(visibleIds()).toHaveLength(1 + nodes.root.childrenIds.length);
    useMindmapStore.getState().expandAll();
    expect(updates).toBe(2);
    expect(visibleIds()).toHaveLength(500);
    unsub();
  });

  it('nothing to change, no store update', () => {
    let updates = 0;
    const unsub = useMindmapStore.subscribe(() => { updates++; });
    useMindmapStore.getState().expandAll();
    expect(updates).toBe(0);
    unsub();
  });
});
