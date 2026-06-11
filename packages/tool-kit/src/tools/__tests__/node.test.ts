/**
 * Tool-kit schema/handler regression tests.
 *
 * These tests pin the MCP surface of node tools — specifically that
 * `autoProgress` round-trips through both create_node and update_node
 * (#57 follow-up so Jenna can flip an epic into rollup mode through her
 * normal MCP tools instead of a direct REST call).
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createNodeTool, updateNodeTool, restoreNodeTool, listRecentlyDeletedTool, searchNodesTool } from '../node.js';
import type { ToolBackend } from '../../backend.js';
import type { MapDetail, NodeWithComputed } from '../../types.js';

/**
 * Minimal ToolBackend that records the last call to createNode / updateNode
 * so tests can assert the field reached the backend. Everything not under
 * test throws — keeps surprise dependencies obvious.
 */
function makeRecordingBackend(): {
  backend: ToolBackend;
  lastCreate: { mapId: string; parentId: string; text: string; fields?: Record<string, unknown> } | null;
  lastUpdate: { mapId: string; nodeId: string; fields: Record<string, unknown> } | null;
} {
  const state = {
    lastCreate: null as ReturnType<typeof makeRecordingBackend>['lastCreate'],
    lastUpdate: null as ReturnType<typeof makeRecordingBackend>['lastUpdate'],
  };
  const stubNode: NodeWithComputed = {
    id: 'node-stub',
    mapId: 'map-stub',
    parentId: null,
    childrenOrder: [],
    text: 'stub',
    description: null,
    collapsed: false,
    x: null,
    y: null,
    effortEstimate: null,
    actualEffort: null,
    percentComplete: null,
    status: null,
    blockedReason: null,
    assigneeIds: [],
    priority: null,
    dueDate: null,
    startDate: null,
    tags: [],
    customFields: {},
    dependencies: [],
    externalLinks: [],
    versionId: null,
    cycleId: null,
    autoProgress: 'off',
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: 'test',
    computedProgress: 0,
    computedEffort: 0,
    healthSignal: 'on_track',
  } as unknown as NodeWithComputed;
  const backend: ToolBackend = {
    listMaps: async () => { throw new Error('not implemented'); },
    getMap: async () => { throw new Error('not implemented'); },
    createMap: async () => { throw new Error('not implemented'); },
    updateMap: async () => { throw new Error('not implemented'); },
    deleteMap: async () => { throw new Error('not implemented'); },
    createNode: async (mapId, parentId, text, fields) => {
      state.lastCreate = { mapId, parentId, text, fields };
      return stubNode;
    },
    updateNode: async (mapId, nodeId, fields) => {
      state.lastUpdate = { mapId, nodeId, fields };
      return stubNode;
    },
    deleteNode: async () => { throw new Error('not implemented'); },
    moveNode: async () => { throw new Error('not implemented'); },
    restoreNode: async () => { throw new Error('not implemented'); },
    listDeleted: async () => { throw new Error('not implemented'); },
    listTriageDecisions: async () => { throw new Error('not implemented'); },
    overrideTriage: async () => { throw new Error('not implemented'); },
    reclassifyTriage: async () => { throw new Error('not implemented'); },
    confirmTriage: async () => { throw new Error('not implemented'); },
    listNotInMindBlown: async () => { throw new Error('not implemented'); },
    // Orchestration substrate (#111)
    readyNodes: async () => { throw new Error('not implemented'); },
    claimNode: async () => { throw new Error('not implemented'); },
    releaseNode: async () => { throw new Error('not implemented'); },
    conflictScan: async () => { throw new Error('not implemented'); },
  };
  return {
    backend,
    get lastCreate() { return state.lastCreate; },
    get lastUpdate() { return state.lastUpdate; },
  };
}

describe('update_node tool', () => {
  it('accepts autoProgress: "children" in the schema', () => {
    const schema = z.object(updateNodeTool.schema);
    const parsed = schema.parse({
      mapId: 'm1',
      nodeId: 'n1',
      autoProgress: 'children',
    });
    expect(parsed.autoProgress).toBe('children');
  });

  it('accepts autoProgress: "off" in the schema', () => {
    const schema = z.object(updateNodeTool.schema);
    const parsed = schema.parse({
      mapId: 'm1',
      nodeId: 'n1',
      autoProgress: 'off',
    });
    expect(parsed.autoProgress).toBe('off');
  });

  it('rejects unknown autoProgress values', () => {
    const schema = z.object(updateNodeTool.schema);
    expect(() => schema.parse({ mapId: 'm1', nodeId: 'n1', autoProgress: 'auto' })).toThrow();
  });

  it('forwards autoProgress to the backend', async () => {
    const recorder = makeRecordingBackend();
    const result = await updateNodeTool.handler(recorder.backend, {
      mapId: 'm1',
      nodeId: 'n1',
      autoProgress: 'children',
    } as never);
    expect(recorder.lastUpdate).not.toBeNull();
    expect(recorder.lastUpdate?.fields).toMatchObject({ autoProgress: 'children' });
    // Confirm undefined fields were stripped (handler's clean-fields contract).
    expect('text' in (recorder.lastUpdate?.fields ?? {})).toBe(false);
    expect(result).toContain('autoProgress');
  });

  it('omits autoProgress from the backend call when not provided', async () => {
    const recorder = makeRecordingBackend();
    await updateNodeTool.handler(recorder.backend, {
      mapId: 'm1',
      nodeId: 'n1',
      text: 'rename me',
    } as never);
    expect(recorder.lastUpdate?.fields).toMatchObject({ text: 'rename me' });
    expect('autoProgress' in (recorder.lastUpdate?.fields ?? {})).toBe(false);
  });

  // Jenna housekeeping digest 2026-06-11 — `bulk_update_nodes` with a flat
  // `tags` array silently clobbered all other tags on a node, blocking any
  // reliable multi-sweep tagging strategy. The merge variants let the caller
  // add or remove specific tags without round-tripping a read first.
  it('forwards tagsAppend through to the backend', async () => {
    const recorder = makeRecordingBackend();
    await updateNodeTool.handler(recorder.backend, {
      mapId: 'm1',
      nodeId: 'n1',
      tagsAppend: ['SCOPE-REVIEW'],
    } as never);
    expect(recorder.lastUpdate?.fields).toMatchObject({ tagsAppend: ['SCOPE-REVIEW'] });
    expect('tags' in (recorder.lastUpdate?.fields ?? {})).toBe(false);
  });

  it('forwards tagsRemove through to the backend', async () => {
    const recorder = makeRecordingBackend();
    await updateNodeTool.handler(recorder.backend, {
      mapId: 'm1',
      nodeId: 'n1',
      tagsRemove: ['NEEDS-PRIORITY'],
    } as never);
    expect(recorder.lastUpdate?.fields).toMatchObject({ tagsRemove: ['NEEDS-PRIORITY'] });
  });

  it('allows append + remove together for swap-style updates', async () => {
    const recorder = makeRecordingBackend();
    await updateNodeTool.handler(recorder.backend, {
      mapId: 'm1',
      nodeId: 'n1',
      tagsAppend: ['NEEDS-VERSION'],
      tagsRemove: ['STATUS-UNSET'],
    } as never);
    expect(recorder.lastUpdate?.fields).toMatchObject({
      tagsAppend: ['NEEDS-VERSION'],
      tagsRemove: ['STATUS-UNSET'],
    });
  });
});

describe('create_node tool', () => {
  it('accepts autoProgress in the schema (symmetry with update_node)', () => {
    const schema = z.object(createNodeTool.schema);
    const parsed = schema.parse({
      mapId: 'm1',
      parentId: 'p1',
      text: 'epic node',
      autoProgress: 'children',
    });
    expect(parsed.autoProgress).toBe('children');
  });

  it('forwards autoProgress to the backend on create', async () => {
    const recorder = makeRecordingBackend();
    await createNodeTool.handler(recorder.backend, {
      mapId: 'm1',
      parentId: 'p1',
      text: 'epic node',
      autoProgress: 'children',
    } as never);
    expect(recorder.lastCreate?.fields).toMatchObject({ autoProgress: 'children' });
  });

  // Bug 2bee313d — created nodes without an estimate were silently
  // shipped as unestimated leaves, breaking forecasts and ready-node
  // picks. The handler must flag missing estimates back to the caller.
  it('flags missing estimate when none is provided', async () => {
    const recorder = makeRecordingBackend();
    const out = await createNodeTool.handler(recorder.backend, {
      mapId: 'm1',
      parentId: 'p1',
      text: 'unsized task',
    } as never);
    expect(out).toMatch(/no effort estimate set/i);
    expect(out).toMatch(/set_estimate/);
  });

  it('does not flag when an estimate is provided', async () => {
    const recorder = makeRecordingBackend();
    const out = await createNodeTool.handler(recorder.backend, {
      mapId: 'm1',
      parentId: 'p1',
      text: 'sized task',
      effortEstimate: 4,
    } as never);
    expect(out).not.toMatch(/no effort estimate set/i);
  });
});

// ── Soft-delete / restore (#107) ────────────────────────────────

describe('restore_node tool', () => {
  it('forwards recursive: true through to the backend', async () => {
    const calls: Array<{ mapId: string; nodeId: string; opts?: { recursive?: boolean } }> = [];
    const recorder = makeRecordingBackend();
    recorder.backend.restoreNode = async (mapId, nodeId, opts) => {
      calls.push({ mapId, nodeId, opts });
      return { restoredIds: [nodeId, 'child1', 'child2'], node: null };
    };
    const out = await restoreNodeTool.handler(recorder.backend, {
      mapId: 'm1',
      nodeId: 'n1',
      recursive: true,
    } as never);
    expect(calls).toEqual([{ mapId: 'm1', nodeId: 'n1', opts: { recursive: true } }]);
    expect(out).toContain('Restored 3');
  });

  it('defaults recursive to false when omitted', async () => {
    const seen: Array<{ recursive?: boolean }> = [];
    const recorder = makeRecordingBackend();
    recorder.backend.restoreNode = async (_m, _n, opts) => {
      seen.push(opts ?? {});
      return { restoredIds: ['n1'], node: null };
    };
    await restoreNodeTool.handler(recorder.backend, {
      mapId: 'm1',
      nodeId: 'n1',
    } as never);
    expect(seen[0]).toEqual({ recursive: false });
  });
});

describe('list_recently_deleted tool', () => {
  it('returns "No nodes" when the Trash is empty', async () => {
    const recorder = makeRecordingBackend();
    recorder.backend.listDeleted = async () => [];
    const out = await listRecentlyDeletedTool.handler(recorder.backend, {
      mapId: 'm1',
    } as never);
    expect(out).toContain('No nodes in the Trash');
  });

  it('formats one line per trashed root', async () => {
    const recorder = makeRecordingBackend();
    recorder.backend.listDeleted = async () => [
      {
        id: 'n1',
        mapId: 'm1',
        parentId: 'root',
        text: 'Backlog',
        deletedAt: '2026-06-04T13:04:22Z',
        effortEstimate: null,
        percentComplete: 0,
      },
      {
        id: 'n2',
        mapId: 'm1',
        parentId: 'root',
        text: 'GitHub Inbox',
        deletedAt: '2026-06-04T13:04:18Z',
        effortEstimate: null,
        percentComplete: null,
      },
    ];
    const out = await listRecentlyDeletedTool.handler(recorder.backend, {
      mapId: 'm1',
    } as never);
    expect(out).toMatch(/^2 node\(s\) in Trash:/);
    expect(out).toContain('Backlog');
    expect(out).toContain('GitHub Inbox');
    expect(out).toContain('id: n1');
    expect(out).toContain('id: n2');
  });

  it('forwards sinceDays + limit to the backend', async () => {
    const seen: Array<{ mapId: string; opts?: { sinceDays?: number; limit?: number } }> = [];
    const recorder = makeRecordingBackend();
    recorder.backend.listDeleted = async (mapId, opts) => {
      seen.push({ mapId, opts });
      return [];
    };
    await listRecentlyDeletedTool.handler(recorder.backend, {
      mapId: 'm1',
      sinceDays: 7,
      limit: 100,
    } as never);
    expect(seen[0]).toEqual({ mapId: 'm1', opts: { sinceDays: 7, limit: 100 } });
  });
});

describe('search_nodes tool — parentId filter', () => {
  function buildBucketMap(): MapDetail {
    const node = (id: string, parentId: string | null, childrenIds: string[]): NodeWithComputed =>
      ({
        id,
        mapId: 'm1',
        parentId,
        childrenIds,
        text: id,
        description: null,
        effortEstimate: null,
        actualEffort: null,
        percentComplete: null,
        status: null,
        assigneeIds: [],
        priority: null,
        dueDate: null,
        startDate: null,
        tags: [],
        dependencies: [],
        versionId: null,
        cycleId: null,
        externalLinks: [],
        collapsed: false,
        createdAt: '2026-06-10T00:00:00Z',
        updatedAt: '2026-06-10T00:00:00Z',
        claimedBySession: null,
        claimedAt: null,
        computedEffort: 0,
        computedProgress: 0,
        healthSignal: 'on_track',
      }) as unknown as NodeWithComputed;
    return {
      map: { id: 'm1', rootNodeId: 'root' } as unknown as MapDetail['map'],
      nodes: [
        node('root', null, ['bucket-a', 'bucket-b']),
        node('bucket-a', 'root', ['a-leaf-1', 'a-leaf-2']),
        node('a-leaf-1', 'bucket-a', []),
        node('a-leaf-2', 'bucket-a', []),
        node('bucket-b', 'root', ['b-leaf']),
        node('b-leaf', 'bucket-b', []),
      ],
    };
  }

  it('returns only the direct children of the given parent', async () => {
    const recorder = makeRecordingBackend();
    recorder.backend.getMap = async () => buildBucketMap();
    const out = await searchNodesTool.handler(recorder.backend, {
      mapId: 'm1',
      query: '*',
      parentId: 'bucket-a',
    } as never);
    expect(out).toContain('Found 2 node(s)');
    expect(out).toContain('id: a-leaf-1');
    expect(out).toContain('id: a-leaf-2');
    expect(out).not.toContain('id: b-leaf');
    expect(out).not.toContain('id: bucket-b');
    expect(out).not.toContain('id: bucket-a');
  });

  it('composes with leavesOnly (children of a parent that are themselves leaves)', async () => {
    const recorder = makeRecordingBackend();
    recorder.backend.getMap = async () => buildBucketMap();
    const out = await searchNodesTool.handler(recorder.backend, {
      mapId: 'm1',
      query: '*',
      parentId: 'root',
      leavesOnly: true,
    } as never);
    expect(out).toContain('No nodes');
    expect(out).toContain('parentId=root');
    expect(out).toContain('leavesOnly=true');
  });

  it('reports child count on non-leaf result lines', async () => {
    const recorder = makeRecordingBackend();
    recorder.backend.getMap = async () => buildBucketMap();
    const out = await searchNodesTool.handler(recorder.backend, {
      mapId: 'm1',
      query: '*',
      parentId: 'root',
    } as never);
    expect(out).toMatch(/bucket-a[^\n]*\(2 children\)/);
    expect(out).toMatch(/bucket-b[^\n]*\(1 child\)/);
  });
});

// Jenna housekeeping digest 2026-06-11 tick 20:38 (§8.1 beta-feedback
// #9) — `bulk_assign_to_version` was wrongly reported as a no-op for
// 26 leaves that survived 6 re-runs in one day. Root cause was on the
// READ side: a leaf with an explicit versionId=V2 sat under an epic
// parent still carrying versionId=Unversioned, and the ancestor walk
// kept climbing past the explicit assignment. The fix lets the first
// non-null versionId on the path decide membership.
describe('search_nodes tool — versionId ancestor-walk', () => {
  function buildMixedVersionMap(): MapDetail {
    const node = (
      id: string,
      parentId: string | null,
      childrenIds: string[],
      versionId: string | null,
    ): NodeWithComputed =>
      ({
        id,
        mapId: 'm1',
        parentId,
        childrenIds,
        text: id,
        description: null,
        effortEstimate: null,
        actualEffort: null,
        percentComplete: null,
        status: null,
        assigneeIds: [],
        priority: null,
        dueDate: null,
        startDate: null,
        tags: [],
        dependencies: [],
        versionId,
        cycleId: null,
        externalLinks: [],
        collapsed: false,
        createdAt: '2026-06-11T00:00:00Z',
        updatedAt: '2026-06-11T00:00:00Z',
        claimedBySession: null,
        claimedAt: null,
        computedEffort: 0,
        computedProgress: 0,
        healthSignal: 'on_track',
      }) as unknown as NodeWithComputed;
    return {
      map: { id: 'm1', rootNodeId: 'root' } as unknown as MapDetail['map'],
      nodes: [
        node('root', null, ['epic'], null),
        // The Jenna-2026-06-11 shape: epic explicitly Unversioned, leaf
        // explicitly V2. The leaf must NOT be reported as in-Unversioned.
        node('epic', 'root', ['leaf-v2', 'leaf-inherits', 'leaf-other'], 'unversioned-uuid'),
        node('leaf-v2', 'epic', [], 'v2-uuid'),
        node('leaf-inherits', 'epic', [], null),
        node('leaf-other', 'epic', [], 'v1-uuid'),
      ],
    };
  }

  it("doesn't report a child with explicit versionId as belonging to the parent's version", async () => {
    const recorder = makeRecordingBackend();
    recorder.backend.getMap = async () => buildMixedVersionMap();
    const out = await searchNodesTool.handler(recorder.backend, {
      mapId: 'm1',
      query: '*',
      versionId: 'unversioned-uuid',
    } as never);
    // Explicit-versionId children of the Unversioned epic are NOT
    // pulled in; only the epic itself and its null-versionId child
    // (which inherits the epic's assignment) match.
    expect(out).not.toContain('id: leaf-v2');
    expect(out).not.toContain('id: leaf-other');
    expect(out).toContain('id: epic');
    expect(out).toContain('id: leaf-inherits');
  });

  it('still inherits ancestor version when the child has no explicit assignment', async () => {
    const recorder = makeRecordingBackend();
    recorder.backend.getMap = async () => buildMixedVersionMap();
    const out = await searchNodesTool.handler(recorder.backend, {
      mapId: 'm1',
      query: '*',
      versionId: 'v2-uuid',
    } as never);
    // Only the explicitly-V2 leaf shows up — the V1-leaf doesn't,
    // the Unversioned-epic doesn't, and the inheriting leaf
    // (which would inherit Unversioned from its epic) doesn't.
    expect(out).toContain('id: leaf-v2');
    expect(out).not.toContain('id: leaf-other');
    expect(out).not.toContain('id: epic');
    expect(out).not.toContain('id: leaf-inherits');
  });
});

// Jenna housekeeping digest 2026-06-11 (§8.6) — `unestimated:true`
// without a status-exclusion filter returns thousands of done leaves
// whose effortEstimate is null, drowning out the actionable subset.
// `notStatus:"done"` collapses the post-filter back to one call.
describe('search_nodes tool — notStatus filter', () => {
  function buildStatusMap(): MapDetail {
    const node = (id: string, status: string | null): NodeWithComputed =>
      ({
        id,
        mapId: 'm1',
        parentId: 'root',
        childrenIds: [],
        text: id,
        description: null,
        effortEstimate: null,
        actualEffort: null,
        percentComplete: null,
        status,
        assigneeIds: [],
        priority: null,
        dueDate: null,
        startDate: null,
        tags: [],
        dependencies: [],
        versionId: null,
        cycleId: null,
        externalLinks: [],
        collapsed: false,
        createdAt: '2026-06-10T00:00:00Z',
        updatedAt: '2026-06-10T00:00:00Z',
        claimedBySession: null,
        claimedAt: null,
        computedEffort: 0,
        computedProgress: 0,
        healthSignal: 'on_track',
      }) as unknown as NodeWithComputed;
    return {
      map: { id: 'm1', rootNodeId: 'root' } as unknown as MapDetail['map'],
      nodes: [
        { ...node('root', null), parentId: null } as NodeWithComputed,
        node('todo-1', 'todo'),
        node('inprogress-1', 'in_progress'),
        node('done-1', 'done'),
        node('done-2', 'done'),
      ],
    };
  }

  it('excludes nodes matching the given status', async () => {
    const recorder = makeRecordingBackend();
    recorder.backend.getMap = async () => buildStatusMap();
    const out = await searchNodesTool.handler(recorder.backend, {
      mapId: 'm1',
      query: '*',
      notStatus: 'done',
    } as never);
    expect(out).toContain('id: todo-1');
    expect(out).toContain('id: inprogress-1');
    expect(out).not.toContain('id: done-1');
    expect(out).not.toContain('id: done-2');
  });

  it('reports notStatus in the empty-result filter line', async () => {
    const recorder = makeRecordingBackend();
    recorder.backend.getMap = async () => buildStatusMap();
    const out = await searchNodesTool.handler(recorder.backend, {
      mapId: 'm1',
      query: 'nope',
      notStatus: 'done',
    } as never);
    expect(out).toContain('No nodes matching');
    expect(out).toContain('notStatus=done');
  });
});
