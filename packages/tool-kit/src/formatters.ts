/**
 * Pure formatting helpers — turn MapDetail into human-readable text.
 * Live here so tool handlers in this package can use them without
 * depending on packages/mcp.
 */

import type { MapDetail, NodeWithComputed } from './types.js';

function healthIcon(signal: string): string {
  switch (signal) {
    case 'on_track': return '[OK]';
    case 'at_risk': return '[AT RISK]';
    case 'behind': return '[BEHIND]';
    default: return `[${signal}]`;
  }
}

function progressBar(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round(clamped / 10);
  const empty = 10 - filled;
  return `[${'#'.repeat(filled)}${'.'.repeat(empty)}] ${Math.round(clamped)}%`;
}

/**
 * Render the orchestration claim state as a compact, parseable token.
 * Always emitted (even when null) so Kira's slot accounting can parse a
 * stable field rather than infer absence — see #153.
 */
export function formatClaim(session: string | null, at: string | null): string {
  if (session === null) return 'claim: -';
  return at ? `claim: ${session}@${at}` : `claim: ${session}`;
}

function buildNodeLookup(nodes: NodeWithComputed[]): Map<string, NodeWithComputed> {
  const map = new Map<string, NodeWithComputed>();
  for (const n of nodes) map.set(n.id, n);
  return map;
}

function renderTreeNode(
  nodeId: string,
  lookup: Map<string, NodeWithComputed>,
  indent: number,
): string[] {
  const node = lookup.get(nodeId);
  if (!node) return [];

  const prefix = '  '.repeat(indent);
  const isLeaf = node.childrenIds.length === 0;
  const bullet = isLeaf ? '-' : '+';

  let line = `${prefix}${bullet} ${node.text}`;

  const parts: string[] = [];
  parts.push(healthIcon(node.healthSignal));
  parts.push(progressBar(node.computedProgress));

  if (node.computedEffort > 0) parts.push(`effort: ${node.computedEffort}`);
  if (node.status) parts.push(`status: ${node.status}`);
  if (node.priority) parts.push(node.priority);
  if (node.dueDate) parts.push(`due: ${node.dueDate}`);
  if (node.externalLinks?.length > 0) {
    parts.push(node.externalLinks.map((l) => `[${l.externalId}]`).join(' '));
  }
  parts.push(formatClaim(node.claimedBySession, node.claimedAt));
  if (node.dependencies.length > 0) {
    const depLabels = node.dependencies.map((d) => {
      const target = lookup.get(d.targetNodeId);
      return `→ ${target?.text ?? d.targetNodeId} (${d.type})`;
    });
    parts.push(`deps: ${depLabels.join(', ')}`);
  }

  line += `  ${parts.join(' | ')}`;
  line += `  (id: ${node.id})`;

  const lines = [line];
  for (const childId of node.childrenIds) {
    lines.push(...renderTreeNode(childId, lookup, indent + 1));
  }
  return lines;
}

export interface MapFilters {
  status?: string;
  priority?: string;
  healthSignal?: string;
  tag?: string;
}

export function filterMapData(data: MapDetail, filters: MapFilters): MapDetail {
  const lookup = buildNodeLookup(data.nodes);

  const matchingIds = new Set<string>();
  for (const node of data.nodes) {
    let matches = true;
    if (filters.status !== undefined && node.status !== filters.status) matches = false;
    if (filters.priority !== undefined && node.priority !== filters.priority) matches = false;
    if (filters.healthSignal !== undefined && node.healthSignal !== filters.healthSignal) matches = false;
    if (filters.tag !== undefined && !node.tags.includes(filters.tag)) matches = false;
    if (matches) matchingIds.add(node.id);
  }

  const includedIds = new Set<string>(matchingIds);
  for (const nodeId of matchingIds) {
    let current = lookup.get(nodeId);
    while (current?.parentId) {
      includedIds.add(current.parentId);
      current = lookup.get(current.parentId);
    }
  }

  const filteredNodes = data.nodes
    .filter((n) => includedIds.has(n.id))
    .map((n) => ({
      ...n,
      childrenIds: n.childrenIds.filter((cid) => includedIds.has(cid)),
    }));

  return { map: data.map, nodes: filteredNodes };
}

export function formatMapTree(data: MapDetail): string {
  const lookup = buildNodeLookup(data.nodes);
  const rootNode = lookup.get(data.map.rootNodeId);

  const lines: string[] = [];
  lines.push(`# ${data.map.name}`);
  if (data.map.description) lines.push(`${data.map.description}`);
  lines.push(`Effort unit: ${data.map.effortUnit ?? 'hours'}`);
  lines.push('');

  if (rootNode) {
    lines.push(...renderTreeNode(data.map.rootNodeId, lookup, 0));
  } else {
    lines.push('(empty map)');
  }

  return lines.join('\n');
}
