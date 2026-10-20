/**
 * #490 — reportedBy on the MCP surface.
 *
 * Read-only: get_map and search_nodes show who asked for a node
 * (`reported: github:octocat` / `reported: user:<id>`), and neither
 * create_node nor update_node accepts it — the server sets it from the
 * authenticated caller or the forge issue author.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { getMapTool } from '../map.js';
import { createNodeTool, updateNodeTool, searchNodesTool } from '../node.js';
import type { ToolBackend } from '../../backend.js';
import type { MapDetail, NodeWithComputed } from '../../types.js';

function stubNode(overrides: Partial<NodeWithComputed> = {}): NodeWithComputed {
  return {
    id: 'n1',
    mapId: 'm1',
    parentId: null,
    childrenIds: [],
    text: 'stub',
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
    attachments: [],
    collapsed: false,
    createdAt: '2026-10-20T10:00:00Z',
    updatedAt: '2026-10-20T10:00:00Z',
    claimedBySession: null,
    claimedAt: null,
    computedEffort: 0,
    computedProgress: 0,
    healthSignal: 'on_track',
    ...overrides,
  } as NodeWithComputed;
}

const detail: MapDetail = {
  map: {
    id: 'm1',
    workspaceId: 'ws1',
    name: 'Test Map',
    description: null,
    rootNodeId: 'root',
    effortUnit: 'hours',
    healthThreshold: 0.2,
    computedProgress: 0,
    healthSignal: 'on_track',
    createdAt: '2026-10-20T10:00:00Z',
    updatedAt: '2026-10-20T10:00:00Z',
    statusWorkflow: [],
    baselines: [],
    wipLimit: null,
  },
  nodes: [
    stubNode({ id: 'root', text: 'Root', childrenIds: ['forge', 'user', 'unknown'] }),
    stubNode({ id: 'forge', parentId: 'root', text: 'From an issue', reportedBy: { kind: 'forge', provider: 'github', login: 'octocat' } }),
    stubNode({ id: 'user', parentId: 'root', text: 'From a person', reportedBy: { kind: 'user', userId: 'u-42' } }),
    stubNode({ id: 'unknown', parentId: 'root', text: 'From before' }),
  ],
} as unknown as MapDetail;

const backend = { getMap: async () => detail } as unknown as ToolBackend;
const lineOf = (out: string, text: string) => out.split('\n').find((l) => l.includes(text))!;

describe('reportedBy read-out (#490)', () => {
  it('get_map shows the reporter on the tree line, nothing when unknown', async () => {
    const out = await getMapTool.handler(backend, { mapId: 'm1' } as never);
    expect(lineOf(out, 'From an issue')).toContain('reported: github:octocat');
    expect(lineOf(out, 'From a person')).toContain('reported: user:u-42');
    expect(lineOf(out, 'From before')).not.toContain('reported:');
  });

  it('search_nodes shows the reporter', async () => {
    const out = await searchNodesTool.handler(backend, { mapId: 'm1', query: 'From' } as never);
    expect(lineOf(out, 'From an issue')).toContain('reported: github:octocat');
    expect(lineOf(out, 'From a person')).toContain('reported: user:u-42');
  });
});

describe('reportedBy is not writable over MCP (#490)', () => {
  const spoof = { kind: 'forge', provider: 'github', login: 'someone-else' };

  it('create_node drops it', () => {
    const parsed = z.object(createNodeTool.schema).parse({ mapId: 'm1', parentId: 'p1', text: 't', reportedBy: spoof });
    expect(parsed).not.toHaveProperty('reportedBy');
  });

  it('update_node drops it', () => {
    const parsed = z.object(updateNodeTool.schema).parse({ mapId: 'm1', nodeId: 'n1', reportedBy: spoof });
    expect(parsed).not.toHaveProperty('reportedBy');
  });
});
