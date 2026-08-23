/**
 * Tests for the map-context summarizer (#92, #93).
 *
 * DB is mocked with a predicate-aware select chain that mirrors the
 * `eq()` filtering the production code uses. We exercise:
 *   - Epic ordering follows the root node's childrenOrder.
 *   - Description ProseMirror JSON is flattened to plain text.
 *   - Empty + missing descriptions render as empty string (not "null").
 *   - 5-minute cache reuses the same context until expiry.
 *   - invalidateMapContext clears the targeted entry only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── DB mock (predicate-aware) ─────────────────────────────────────

interface MockMap {
  id: string;
  name: string;
  description: string | null;
  rootNodeId: string | null;
}
interface MockNode {
  id: string;
  text: string;
  description: unknown;
  parentId: string | null;
  childrenOrder?: string[];
}

interface MockVersion {
  id: string;
  mapId: string;
  name: string;
  status: string;
  sortOrder: number;
}

const dbState = {
  maps: new Map<string, MockMap>(),
  nodes: new Map<string, MockNode>(),
  versions: new Map<string, MockVersion>(),
};

type Predicate = { __pred: true; check: (row: Record<string, unknown>) => boolean };
function applyPred(rows: Record<string, unknown>[], pred: unknown): Record<string, unknown>[] {
  if (!pred || typeof pred !== 'object') return rows;
  const p = pred as { __pred?: true; check?: (row: Record<string, unknown>) => boolean };
  if (!p.__pred || typeof p.check !== 'function') return rows;
  return rows.filter((r) => p.check!(r));
}

function buildChain() {
  const step: { table?: string; pred?: unknown } = {};
  const resolve = async (): Promise<Record<string, unknown>[]> => {
    let rows: Record<string, unknown>[] = [];
    if (step.table === 'maps') {
      rows = [...dbState.maps.values()].map((m) => ({ ...m }));
    } else if (step.table === 'nodes') {
      rows = [...dbState.nodes.values()].map((n) => ({ ...n }));
    } else if (step.table === 'versions') {
      rows = [...dbState.versions.values()].map((v) => ({ ...v }));
    }
    return applyPred(rows, step.pred);
  };
  const thenable = {
    then: (onFulfilled: (v: Record<string, unknown>[]) => unknown, onRejected?: (err: unknown) => unknown) =>
      resolve().then(onFulfilled, onRejected),
    catch: (onRejected: (err: unknown) => unknown) => resolve().catch(onRejected),
    where: (pred: unknown) => {
      step.pred = pred;
      return thenable;
    },
  };
  return {
    from(table: { __name?: string }) {
      step.table = table.__name;
      return thenable;
    },
  };
}

vi.mock('../../db/connection.js', () => ({
  db: { select: (_cols?: unknown) => buildChain() },
}));

vi.mock('../../db/schema.js', () => {
  const col = (name: string) => ({ __col: name });
  return {
    maps: {
      __name: 'maps',
      id: col('id'),
      name: col('name'),
      description: col('description'),
      rootNodeId: col('rootNodeId'),
    },
    nodes: {
      __name: 'nodes',
      id: col('id'),
      text: col('text'),
      description: col('description'),
      parentId: col('parentId'),
      childrenOrder: col('childrenOrder'),
    },
    versions: {
      __name: 'versions',
      id: col('id'),
      mapId: col('mapId'),
      name: col('name'),
      status: col('status'),
      sortOrder: col('sortOrder'),
    },
  };
});

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('drizzle-orm');
  return {
    ...actual,
    eq: (column: { __col?: string }, value: unknown): Predicate => ({
      __pred: true,
      check: (row) => row[column.__col ?? ''] === value,
    }),
    ne: (column: { __col?: string }, value: unknown): Predicate => ({
      __pred: true,
      check: (row) => row[column.__col ?? ''] !== value,
    }),
    and: (...preds: unknown[]): Predicate => ({
      __pred: true,
      // Non-mock members (e.g. the real `notDeleted` SQL fragment) pass
      // through as always-true — same behavior the tests had when `and`
      // itself was the real drizzle implementation.
      check: (row) =>
        preds.every((p) => {
          const m = p as { __pred?: true; check?: (r: Record<string, unknown>) => boolean };
          return m?.__pred && typeof m.check === 'function' ? m.check(row) : true;
        }),
    }),
  };
});

import {
  buildMapContext,
  invalidateMapContext,
  proseMirrorToPlainText,
  _clearMapContextCacheForTests,
} from '../mapContext.js';

beforeEach(() => {
  dbState.maps.clear();
  dbState.nodes.clear();
  dbState.versions.clear();
  _clearMapContextCacheForTests();
});

// ── proseMirrorToPlainText ────────────────────────────────────────

describe('proseMirrorToPlainText', () => {
  it('returns empty string for null / undefined', () => {
    expect(proseMirrorToPlainText(null)).toBe('');
    expect(proseMirrorToPlainText(undefined)).toBe('');
  });

  it('passes plain strings through (legacy nodes)', () => {
    expect(proseMirrorToPlainText('hello')).toBe('hello');
  });

  it('flattens a doc with paragraphs into plain text', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First line' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second line' }] },
      ],
    };
    expect(proseMirrorToPlainText(doc)).toBe('First line\nSecond line');
  });

  it('flattens bullet lists by concatenating leaves', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'item one' }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(proseMirrorToPlainText(doc)).toContain('item one');
  });
});

// ── buildMapContext ───────────────────────────────────────────────

describe('buildMapContext', () => {
  it('returns the map name + epics in childrenOrder order', async () => {
    dbState.maps.set('m1', {
      id: 'm1',
      name: 'My Project',
      description: 'A test project',
      rootNodeId: 'root-1',
    });
    dbState.nodes.set('root-1', {
      id: 'root-1',
      text: 'My Project',
      description: null,
      parentId: null,
      childrenOrder: ['c2', 'c1', 'c3'],
    });
    dbState.nodes.set('c1', {
      id: 'c1',
      text: 'Frontend',
      description: 'UI',
      parentId: 'root-1',
    });
    dbState.nodes.set('c2', {
      id: 'c2',
      text: 'Backend',
      description: null,
      parentId: 'root-1',
    });
    dbState.nodes.set('c3', {
      id: 'c3',
      text: 'Infra',
      description: 'Servers',
      parentId: 'root-1',
    });

    const ctx = await buildMapContext('m1');
    expect(ctx.mapName).toBe('My Project');
    expect(ctx.mapDescription).toBe('A test project');
    expect(ctx.epics.map((e) => e.title)).toEqual([
      'Backend', // first in childrenOrder
      'Frontend',
      'Infra',
    ]);
  });

  it('lists the map\'s non-released versions in sortOrder, other maps excluded', async () => {
    dbState.maps.set('m1', {
      id: 'm1',
      name: 'My Project',
      description: null,
      rootNodeId: 'root-1',
    });
    dbState.nodes.set('root-1', {
      id: 'root-1',
      text: 'My Project',
      description: null,
      parentId: null,
      childrenOrder: [],
    });
    dbState.versions.set('v2', { id: 'v2', mapId: 'm1', name: 'V2', status: 'planning', sortOrder: 20 });
    dbState.versions.set('v1', { id: 'v1', mapId: 'm1', name: 'V1', status: 'active', sortOrder: 10 });
    dbState.versions.set('v0', { id: 'v0', mapId: 'm1', name: 'V0', status: 'released', sortOrder: 0 });
    dbState.versions.set('vx', { id: 'vx', mapId: 'OTHER', name: 'VX', status: 'active', sortOrder: 5 });

    const ctx = await buildMapContext('m1');
    expect(ctx.versions).toEqual([
      { versionId: 'v1', name: 'V1', status: 'active' },
      { versionId: 'v2', name: 'V2', status: 'planning' },
    ]);
  });

  it('renders empty-string description for nodes with null description', async () => {
    dbState.maps.set('m1', {
      id: 'm1',
      name: 'X',
      description: null,
      rootNodeId: 'root-1',
    });
    dbState.nodes.set('root-1', {
      id: 'root-1',
      text: 'X',
      description: null,
      parentId: null,
      childrenOrder: ['c1'],
    });
    dbState.nodes.set('c1', {
      id: 'c1',
      text: 'Solo',
      description: null,
      parentId: 'root-1',
    });
    const ctx = await buildMapContext('m1');
    expect(ctx.mapDescription).toBe('');
    expect(ctx.epics[0].description).toBe('');
  });

  it('throws when the map does not exist', async () => {
    await expect(buildMapContext('does-not-exist')).rejects.toThrow(/not found/);
  });

  it('throws when the map has no root node', async () => {
    dbState.maps.set('m1', {
      id: 'm1',
      name: 'X',
      description: null,
      rootNodeId: null,
    });
    await expect(buildMapContext('m1')).rejects.toThrow(/no root node/);
  });

  it('returns empty epics array when the root has no children', async () => {
    dbState.maps.set('m1', {
      id: 'm1',
      name: 'Empty',
      description: null,
      rootNodeId: 'root-1',
    });
    dbState.nodes.set('root-1', {
      id: 'root-1',
      text: 'Empty',
      description: null,
      parentId: null,
      childrenOrder: [],
    });
    const ctx = await buildMapContext('m1');
    expect(ctx.epics).toEqual([]);
  });

  it('flattens ProseMirror descriptions on epics to plain text', async () => {
    dbState.maps.set('m1', {
      id: 'm1',
      name: 'Rich',
      description: null,
      rootNodeId: 'root-1',
    });
    dbState.nodes.set('root-1', {
      id: 'root-1',
      text: 'Rich',
      description: null,
      parentId: null,
      childrenOrder: ['c1'],
    });
    dbState.nodes.set('c1', {
      id: 'c1',
      text: 'Frontend',
      description: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'UI work' }],
          },
        ],
      },
      parentId: 'root-1',
    });
    const ctx = await buildMapContext('m1');
    expect(ctx.epics[0].description).toBe('UI work');
  });
});

// ── Cache behavior ────────────────────────────────────────────────

describe('buildMapContext — cache', () => {
  it('returns the cached entry within the 5-min TTL', async () => {
    vi.useFakeTimers();
    try {
      dbState.maps.set('m1', {
        id: 'm1',
        name: 'A',
        description: null,
        rootNodeId: 'root-1',
      });
      dbState.nodes.set('root-1', {
        id: 'root-1',
        text: 'A',
        description: null,
        parentId: null,
        childrenOrder: [],
      });

      const first = await buildMapContext('m1');
      // Mutate the underlying DB so a cache MISS would observe a
      // different name. The cache HIT must return the original.
      dbState.maps.set('m1', {
        id: 'm1',
        name: 'B (changed)',
        description: null,
        rootNodeId: 'root-1',
      });
      vi.advanceTimersByTime(4 * 60 * 1000);
      const second = await buildMapContext('m1');
      expect(second.mapName).toBe(first.mapName);
      expect(second.mapName).toBe('A');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rebuilds after the 5-min TTL expires', async () => {
    vi.useFakeTimers();
    try {
      dbState.maps.set('m1', {
        id: 'm1',
        name: 'A',
        description: null,
        rootNodeId: 'root-1',
      });
      dbState.nodes.set('root-1', {
        id: 'root-1',
        text: 'A',
        description: null,
        parentId: null,
        childrenOrder: [],
      });

      const first = await buildMapContext('m1');
      expect(first.mapName).toBe('A');

      dbState.maps.set('m1', {
        id: 'm1',
        name: 'A2',
        description: null,
        rootNodeId: 'root-1',
      });
      vi.advanceTimersByTime(6 * 60 * 1000);
      const second = await buildMapContext('m1');
      expect(second.mapName).toBe('A2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidateMapContext clears the targeted map only', async () => {
    dbState.maps.set('m1', {
      id: 'm1',
      name: 'one',
      description: null,
      rootNodeId: 'r1',
    });
    dbState.maps.set('m2', {
      id: 'm2',
      name: 'two',
      description: null,
      rootNodeId: 'r2',
    });
    dbState.nodes.set('r1', { id: 'r1', text: 'one', description: null, parentId: null, childrenOrder: [] });
    dbState.nodes.set('r2', { id: 'r2', text: 'two', description: null, parentId: null, childrenOrder: [] });

    await buildMapContext('m1');
    await buildMapContext('m2');

    // Mutate both, then invalidate ONLY m1. m2 must keep returning the
    // cached value.
    dbState.maps.set('m1', { id: 'm1', name: 'one-new', description: null, rootNodeId: 'r1' });
    dbState.maps.set('m2', { id: 'm2', name: 'two-new', description: null, rootNodeId: 'r2' });

    invalidateMapContext('m1');

    const m1 = await buildMapContext('m1');
    const m2 = await buildMapContext('m2');
    expect(m1.mapName).toBe('one-new'); // re-read from DB
    expect(m2.mapName).toBe('two'); // still cached
  });
});
