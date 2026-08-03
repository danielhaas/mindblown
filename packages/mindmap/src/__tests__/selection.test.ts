import { describe, it, expect, beforeEach } from 'vitest';

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

/**
 * `selectedNodeId` is the anchor of a multi-selection: the Property panel
 * renders it, and the keyboard navigation moves from it. It must therefore
 * follow the node the user touched last, not the one they touched first —
 * shift-clicking three nodes used to leave the panel on node one.
 */
describe('selection anchor', () => {
  beforeEach(() => {
    useMindmapStore.setState({ selectedNodeIds: [], selectedNodeId: null } as never);
  });

  const state = () => {
    const s = useMindmapStore.getState();
    return { ids: s.selectedNodeIds, anchor: s.selectedNodeId };
  };

  it('anchors on the node just added to the selection', () => {
    const { toggleSelectNode } = useMindmapStore.getState();
    toggleSelectNode('a');
    expect(state()).toEqual({ ids: ['a'], anchor: 'a' });

    toggleSelectNode('b');
    expect(state()).toEqual({ ids: ['a', 'b'], anchor: 'b' });

    toggleSelectNode('c');
    expect(state()).toEqual({ ids: ['a', 'b', 'c'], anchor: 'c' });
  });

  it('falls back to the last remaining node when one is deselected', () => {
    const { toggleSelectNode } = useMindmapStore.getState();
    toggleSelectNode('a');
    toggleSelectNode('b');
    toggleSelectNode('c');

    // Removing the anchor hands it to what is still selected...
    toggleSelectNode('c');
    expect(state()).toEqual({ ids: ['a', 'b'], anchor: 'b' });

    // ...and removing a non-anchor leaves the anchor alone.
    toggleSelectNode('a');
    expect(state()).toEqual({ ids: ['b'], anchor: 'b' });
  });

  it('clears the anchor when the last node is deselected', () => {
    const { toggleSelectNode } = useMindmapStore.getState();
    toggleSelectNode('a');
    toggleSelectNode('a');
    expect(state()).toEqual({ ids: [], anchor: null });
  });

  it('selectNode replaces the whole selection', () => {
    const { toggleSelectNode, selectNode } = useMindmapStore.getState();
    toggleSelectNode('a');
    toggleSelectNode('b');

    selectNode('z');
    expect(state()).toEqual({ ids: ['z'], anchor: 'z' });

    selectNode(null);
    expect(state()).toEqual({ ids: [], anchor: null });
  });
});
