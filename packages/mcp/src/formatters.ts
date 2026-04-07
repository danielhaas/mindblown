/**
 * Formatting helpers that turn API data into human-readable markdown
 * that AI agents can easily parse.
 */

import type { MapDetail, NodeWithComputed, ScheduleResult } from './api.js';
import * as api from './api.js';

// ── Status icons ────────────────────────────────────────────────

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

// ── Tree rendering ──────────────────────────────────────────────

function buildNodeLookup(nodes: NodeWithComputed[]): Map<string, NodeWithComputed> {
  const map = new Map<string, NodeWithComputed>();
  for (const n of nodes) {
    map.set(n.id, n);
  }
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

  // Add key info inline
  const parts: string[] = [];
  parts.push(healthIcon(node.healthSignal));
  parts.push(progressBar(node.computedProgress));

  if (node.computedEffort > 0) {
    parts.push(`effort: ${node.computedEffort}`);
  }
  if (node.status) {
    parts.push(`status: ${node.status}`);
  }
  if (node.priority) {
    parts.push(node.priority);
  }
  if (node.dueDate) {
    parts.push(`due: ${node.dueDate}`);
  }

  line += `  ${parts.join(' | ')}`;
  line += `  (id: ${node.id})`;

  const lines = [line];

  // Recurse into children
  for (const childId of node.childrenIds) {
    lines.push(...renderTreeNode(childId, lookup, indent + 1));
  }

  return lines;
}

// ── Public formatters ───────────────────────────────────────────

export function formatMapTree(data: MapDetail): string {
  const lookup = buildNodeLookup(data.nodes);
  const rootNode = lookup.get(data.map.rootNodeId);

  const lines: string[] = [];
  lines.push(`# ${data.map.name}`);
  if (data.map.description) {
    lines.push(`${data.map.description}`);
  }
  lines.push(`Effort unit: ${data.map.effortUnit ?? 'hours'}`);
  lines.push('');

  if (rootNode) {
    lines.push(...renderTreeNode(data.map.rootNodeId, lookup, 0));
  } else {
    lines.push('(empty map)');
  }

  return lines.join('\n');
}

export function formatHealthReport(data: MapDetail): string {
  const lines: string[] = [];
  lines.push(`# Health Report: ${data.map.name}\n`);

  const atRisk = data.nodes.filter((n) => n.healthSignal === 'at_risk');
  const behind = data.nodes.filter((n) => n.healthSignal === 'behind');
  const onTrack = data.nodes.filter((n) => n.healthSignal === 'on_track');

  lines.push(`**Summary:** ${onTrack.length} on track, ${atRisk.length} at risk, ${behind.length} behind\n`);

  if (behind.length > 0) {
    lines.push('## Behind');
    for (const n of behind) {
      lines.push(`- **${n.text}** (id: ${n.id})`);
      lines.push(`  Progress: ${Math.round(n.computedProgress)}% | Effort: ${n.computedEffort}`);
      const reasons: string[] = [];
      if (n.dueDate) {
        const now = new Date().toISOString().split('T')[0];
        if (n.dueDate < now) reasons.push(`overdue (was due ${n.dueDate})`);
      }
      if (n.dependencies.length > 0) {
        reasons.push(`depends on ${n.dependencies.length} node(s)`);
      }
      if (n.effortEstimate === null && n.childrenIds.length === 0) {
        reasons.push('unestimated leaf');
      }
      if (reasons.length > 0) {
        lines.push(`  Reasons: ${reasons.join(', ')}`);
      }
    }
    lines.push('');
  }

  if (atRisk.length > 0) {
    lines.push('## At Risk');
    for (const n of atRisk) {
      lines.push(`- **${n.text}** (id: ${n.id})`);
      lines.push(`  Progress: ${Math.round(n.computedProgress)}% | Effort: ${n.computedEffort}`);
      if (n.dueDate) {
        lines.push(`  Due: ${n.dueDate}`);
      }
    }
    lines.push('');
  }

  if (behind.length === 0 && atRisk.length === 0) {
    lines.push('All nodes are on track.');
  }

  return lines.join('\n');
}

export function formatScheduleReport(mapData: MapDetail, scheduleData: ScheduleResult): string {
  const lookup = buildNodeLookup(mapData.nodes);
  const lines: string[] = [];

  lines.push(`# Schedule: ${mapData.map.name}\n`);
  lines.push(`**Total project duration:** ${scheduleData.criticalPath.totalDuration} ${mapData.map.effortUnit ?? 'hours'}\n`);

  // Critical path
  lines.push('## Critical Path');
  if (scheduleData.criticalPath.path.length === 0) {
    lines.push('No critical path computed (no dependencies or tasks).');
  } else {
    for (const nodeId of scheduleData.criticalPath.path) {
      const node = lookup.get(nodeId);
      const name = node?.text ?? nodeId;
      const progress = node ? Math.round(node.computedProgress) : 0;
      lines.push(`  -> ${name} (${progress}% complete)`);
    }
  }
  lines.push('');

  // Scheduled nodes
  lines.push('## Scheduled Nodes');
  const sorted = [...scheduleData.schedule].sort((a, b) => a.computedStart - b.computedStart);
  for (const s of sorted) {
    const node = lookup.get(s.nodeId);
    const name = node?.text ?? s.nodeId;
    const floatVal = scheduleData.criticalPath.float[s.nodeId] ?? 0;
    const isCritical = floatVal === 0;
    lines.push(`- ${name}: day ${s.computedStart} - ${s.computedEnd} (${s.duration} duration)${isCritical ? ' **CRITICAL**' : ` float: ${floatVal}`}`);
  }

  return lines.join('\n');
}

export async function formatSprintOverview(mapData: MapDetail): Promise<string> {
  const lines: string[] = [];
  lines.push(`# Sprint Overview: ${mapData.map.name}\n`);

  // Group nodes by cycleId
  const cycleNodes = new Map<string, NodeWithComputed[]>();
  const unassigned: NodeWithComputed[] = [];

  for (const n of mapData.nodes) {
    if (n.cycleId) {
      const list = cycleNodes.get(n.cycleId) ?? [];
      list.push(n);
      cycleNodes.set(n.cycleId, list);
    } else if (n.childrenIds.length === 0) {
      unassigned.push(n);
    }
  }

  if (cycleNodes.size === 0) {
    lines.push('No nodes assigned to sprints.');
  } else {
    // Try to fetch cycle details for each
    for (const [cycleId, nodes] of cycleNodes.entries()) {
      let cycleName = cycleId;
      try {
        const cycleData = await api.getCycle(cycleId);
        cycleName = cycleData.cycle.name;
        lines.push(`## ${cycleName} [${cycleData.cycle.status}]`);
        lines.push(`Period: ${cycleData.cycle.startDate} to ${cycleData.cycle.endDate}`);
        lines.push(`Progress: ${Math.round(cycleData.progress * 100)}% | ${cycleData.completedNodes}/${cycleData.totalNodes} completed`);
      } catch {
        lines.push(`## Sprint ${cycleId}`);
      }

      for (const n of nodes) {
        const pct = Math.round(n.computedProgress);
        lines.push(`  - ${n.text} — ${pct}%${n.status ? ` [${n.status}]` : ''}`);
      }
      lines.push('');
    }
  }

  if (unassigned.length > 0) {
    lines.push(`## Unassigned Leaf Tasks (${unassigned.length})`);
    for (const n of unassigned.slice(0, 20)) {
      lines.push(`  - ${n.text} (id: ${n.id})`);
    }
    if (unassigned.length > 20) {
      lines.push(`  ... and ${unassigned.length - 20} more`);
    }
  }

  return lines.join('\n');
}

export function formatNodeDetail(node: NodeWithComputed, mapData: MapDetail): string {
  const lines: string[] = [];
  lines.push(`# Node: ${node.text}\n`);

  lines.push('## Properties');
  lines.push(`- **ID:** ${node.id}`);
  lines.push(`- **Map:** ${mapData.map.name} (${node.mapId})`);

  const parent = mapData.nodes.find((n) => n.id === node.parentId);
  lines.push(`- **Parent:** ${parent ? parent.text : 'none (root)'} (${node.parentId ?? 'root'})`);
  lines.push(`- **Children:** ${node.childrenIds.length}`);

  lines.push('');
  lines.push('## Task Properties');
  lines.push(`- **Status:** ${node.status ?? 'unset'}`);
  lines.push(`- **Priority:** ${node.priority ?? 'unset'}`);
  lines.push(`- **Effort estimate:** ${node.effortEstimate ?? 'unestimated'}`);
  lines.push(`- **Percent complete:** ${node.percentComplete ?? 'unset'}`);
  lines.push(`- **Start date:** ${node.startDate ?? 'unset'}`);
  lines.push(`- **Due date:** ${node.dueDate ?? 'unset'}`);
  lines.push(`- **Milestone:** ${node.isMilestone ? 'yes' : 'no'}`);
  lines.push(`- **Tags:** ${node.tags.length > 0 ? node.tags.join(', ') : 'none'}`);
  lines.push(`- **Assignees:** ${node.assigneeIds.length > 0 ? node.assigneeIds.join(', ') : 'none'}`);
  lines.push(`- **Sprint:** ${node.cycleId ?? 'unassigned'}`);

  lines.push('');
  lines.push('## Computed Values');
  lines.push(`- **Computed effort:** ${node.computedEffort}`);
  lines.push(`- **Computed progress:** ${Math.round(node.computedProgress)}%`);
  lines.push(`- **Health:** ${node.healthSignal}`);

  if (node.dependencies.length > 0) {
    lines.push('');
    lines.push('## Dependencies');
    for (const dep of node.dependencies) {
      const target = mapData.nodes.find((n) => n.id === dep.targetNodeId);
      lines.push(`- Depends on: ${target?.text ?? dep.targetNodeId} (${dep.type}, lag: ${dep.lag})`);
    }
  }

  // Show who depends on this node
  const dependents = mapData.nodes.filter((n) =>
    n.dependencies.some((d) => d.targetNodeId === node.id),
  );
  if (dependents.length > 0) {
    lines.push('');
    lines.push('## Dependents (blocked by this node)');
    for (const d of dependents) {
      lines.push(`- ${d.text} (${d.id})`);
    }
  }

  if (node.description) {
    lines.push('');
    lines.push('## Description');
    lines.push(node.description);
  }

  lines.push('');
  lines.push('## Metadata');
  lines.push(`- **Created:** ${node.createdAt}`);
  lines.push(`- **Updated:** ${node.updatedAt}`);

  return lines.join('\n');
}
