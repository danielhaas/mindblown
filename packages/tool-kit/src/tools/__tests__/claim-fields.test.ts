/**
 * #153 — claimedBySession + claimedAt exposure in get_map / search_nodes
 *
 * Kira's autonomous dispatcher counts in-flight claims by session ID. The
 * MCP text output is her parsing target, so both tools must emit a stable
 * `claim: …` token on every node (including unclaimed ones, rendered as
 * `claim: -`) — see the issue body for why omission isn't acceptable.
 */

import { describe, it, expect } from 'vitest';
import { getMapTool } from '../map.js';
import { searchNodesTool } from '../node.js';
import { formatClaim } from '../../formatters.js';
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
    collapsed: false,
    createdAt: '2026-06-08T10:00:00Z',
    updatedAt: '2026-06-08T10:00:00Z',
    claimedBySession: null,
    claimedAt: null,
    computedEffort: 0,
    computedProgress: 0,
    healthSignal: 'on_track',
    ...overrides,
  } as NodeWithComputed;
}

function backendFor(detail: MapDetail): ToolBackend {
  // Only getMap is exercised by these two tools' read paths; everything
  // else throws so unexpected calls fail loud.
  const unimplemented = () => { throw new Error('not implemented'); };
  return {
    listMaps: unimplemented,
    getMap: async () => detail,
    createMap: unimplemented,
    updateMap: unimplemented,
    deleteMap: unimplemented,
    createNode: unimplemented,
    updateNode: unimplemented,
    deleteNode: unimplemented,
    moveNode: unimplemented,
    restoreNode: unimplemented,
    listDeleted: unimplemented,
    listTriageDecisions: unimplemented,
    overrideTriage: unimplemented,
    reclassifyTriage: unimplemented,
    confirmTriage: unimplemented,
    listNotInMindBlown: unimplemented,
    readyNodes: unimplemented,
    claimNode: unimplemented,
    releaseNode: unimplemented,
    conflictScan: unimplemented,
  } as unknown as ToolBackend;
}

const root = stubNode({ id: 'root', text: 'Root', childrenIds: ['claimed', 'free'] });
const claimedLeaf = stubNode({
  id: 'claimed',
  text: 'Working on it',
  parentId: 'root',
  status: 'in_progress',
  claimedBySession: 'kira-abc123',
  claimedAt: '2026-06-08T09:30:00Z',
});
const freeLeaf = stubNode({
  id: 'free',
  text: 'Open work',
  parentId: 'root',
  status: 'todo',
});

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
    createdAt: '2026-06-08T10:00:00Z',
    updatedAt: '2026-06-08T10:00:00Z',
    statusWorkflow: [],
    baselines: [],
    wipLimit: null,
  },
  nodes: [root, claimedLeaf, freeLeaf],
};

describe('formatClaim', () => {
  it('emits `claim: -` for unclaimed nodes (never omits)', () => {
    expect(formatClaim(null, null)).toBe('claim: -');
  });

  it('emits session@timestamp for claimed nodes', () => {
    expect(formatClaim('kira-abc', '2026-06-08T09:30:00Z')).toBe(
      'claim: kira-abc@2026-06-08T09:30:00Z',
    );
  });

  it('tolerates missing timestamp (defensive — shouldnt happen in practice)', () => {
    expect(formatClaim('kira-abc', null)).toBe('claim: kira-abc');
  });
});

describe('get_map renders claim state on every node', () => {
  it('emits claim: <session>@<iso> for claimed nodes and claim: - for free nodes', async () => {
    const out = await getMapTool.handler(backendFor(detail), { mapId: 'm1' } as never);
    // Both null and non-null cases reach the output.
    expect(out).toContain('claim: kira-abc123@2026-06-08T09:30:00Z');
    expect(out).toContain('claim: -');
    // Claimed line is the one labelled "Working on it".
    const claimedLine = out.split('\n').find((l) => l.includes('Working on it'))!;
    expect(claimedLine).toContain('claim: kira-abc123@2026-06-08T09:30:00Z');
    const freeLine = out.split('\n').find((l) => l.includes('Open work'))!;
    expect(freeLine).toContain('claim: -');
  });
});

describe('search_nodes renders claim state on every result line', () => {
  it('includes claim token for both claimed and unclaimed matches', async () => {
    const out = await searchNodesTool.handler(backendFor(detail), {
      mapId: 'm1',
      query: '*',
    } as never);
    expect(out).toContain('claim: kira-abc123@2026-06-08T09:30:00Z');
    expect(out).toContain('claim: -');
    const claimedLine = out.split('\n').find((l) => l.includes('Working on it'))!;
    expect(claimedLine).toMatch(/claim: kira-abc123@2026-06-08T09:30:00Z/);
    const freeLine = out.split('\n').find((l) => l.includes('Open work'))!;
    expect(freeLine).toMatch(/claim: -/);
  });

  it('filters narrow results but the surviving lines still carry claim tokens', async () => {
    const out = await searchNodesTool.handler(backendFor(detail), {
      mapId: 'm1',
      query: '*',
      status: 'in_progress',
    } as never);
    expect(out).toContain('Working on it');
    expect(out).toContain('claim: kira-abc123@2026-06-08T09:30:00Z');
    expect(out).not.toContain('Open work');
  });
});
