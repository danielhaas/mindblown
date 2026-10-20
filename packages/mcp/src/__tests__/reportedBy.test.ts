/**
 * #490 — the node-detail resource and the map-tree resource show who
 * asked for a node.
 */

import { describe, it, expect } from 'vitest';
import { formatMapTree, formatNodeDetail } from '../formatters.js';
import type { MapDetail, NodeWithComputed } from '../api.js';

function node(id: string, overrides: Partial<NodeWithComputed> = {}): NodeWithComputed {
  return {
    id,
    mapId: 'm1',
    parentId: null,
    childrenIds: [],
    text: id,
    description: null,
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
    dependencies: [],
    versionId: null,
    cycleId: null,
    externalLinks: [],
    attachments: [],
    collapsed: false,
    claimedBySession: null,
    claimedAt: null,
    computedEffort: 0,
    computedProgress: 0,
    healthSignal: 'on_track',
    ...overrides,
  } as NodeWithComputed;
}

const issueNode = node('from-issue', {
  parentId: 'root',
  reportedBy: { kind: 'forge', provider: 'github', login: 'octocat' },
});
const oldNode = node('from-before', { parentId: 'root' });
const data = {
  map: { id: 'm1', name: 'Map', rootNodeId: 'root', phases: [] },
  nodes: [node('root', { childrenIds: ['from-issue', 'from-before'] }), issueNode, oldNode],
} as unknown as MapDetail;

describe('reportedBy on MCP resources (#490)', () => {
  it('node detail names the reporter, or says unknown', () => {
    expect(formatNodeDetail(issueNode, data)).toContain('- **Reported by:** github:octocat');
    expect(formatNodeDetail(oldNode, data)).toContain('- **Reported by:** unknown');
  });

  it('map tree line carries the reporter token', () => {
    const lines = formatMapTree(data).split('\n');
    expect(lines.find((l) => l.includes('from-issue  '))).toContain('reported: github:octocat');
    expect(lines.find((l) => l.includes('from-before  '))).not.toContain('reported:');
  });
});
