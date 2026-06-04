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
import { createNodeTool, updateNodeTool, restoreNodeTool, listRecentlyDeletedTool } from '../node.js';
import type { ToolBackend } from '../../backend.js';
import type { NodeWithComputed } from '../../types.js';

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
