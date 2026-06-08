import { useMemo, useState } from 'react';
import { useMindmapStore } from '../store.js';
import type { MindMap, StatusDef } from '@mindblown/core';
import type { NodeWithComputed } from '../api.js';

type Filter = 'all' | 'in_progress' | 'behind' | 'mine';

interface Props {
  nodes: NodeWithComputed[];
  map: MindMap;
  onSelect: (nodeId: string) => void;
}

interface Row {
  node: NodeWithComputed;
  depth: number;
}

function flattenTree(nodes: NodeWithComputed[], rootId: string): Row[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: Row[] = [];
  const walk = (id: string, depth: number) => {
    const n = byId.get(id);
    if (!n) return;
    if (depth > 0) out.push({ node: n, depth: depth - 1 });
    for (const cid of n.childrenIds) walk(cid, depth + 1);
  };
  walk(rootId, 0);
  return out;
}

function statusOf(node: NodeWithComputed, workflow: StatusDef[]): StatusDef | null {
  if (!node.status) return null;
  return workflow.find((s) => s.id === node.status) ?? null;
}

function priorityColor(p: string | null): string {
  switch (p) {
    case 'P0':
      return '#dc2626';
    case 'P1':
      return '#f97316';
    case 'P2':
      return '#0ea5e9';
    case 'P3':
      return '#94a3b8';
    default:
      return 'transparent';
  }
}

export function MobileListView({ nodes, map, onSelect }: Props) {
  const userId = useMindmapStore((s) => s.user?.id ?? null);
  const [filter, setFilter] = useState<Filter>('all');

  const rows = useMemo(() => flattenTree(nodes, map.rootNodeId), [nodes, map.rootNodeId]);

  const filtered = useMemo(() => {
    return rows.filter(({ node }) => {
      if (filter === 'all') return true;
      if (filter === 'behind') return node.healthSignal === 'behind';
      if (filter === 'mine') return userId !== null && node.assigneeIds.includes(userId);
      if (filter === 'in_progress') {
        const s = statusOf(node, map.statusWorkflow);
        if (s?.category === 'in_progress') return true;
        const pct = node.computedProgress ?? 0;
        return pct > 0 && pct < 1;
      }
      return true;
    });
  }, [rows, filter, map.statusWorkflow, userId]);

  const counts = useMemo(() => {
    return {
      all: rows.length,
      in_progress: rows.filter(({ node }) => {
        const s = statusOf(node, map.statusWorkflow);
        if (s?.category === 'in_progress') return true;
        const pct = node.computedProgress ?? 0;
        return pct > 0 && pct < 1;
      }).length,
      behind: rows.filter(({ node }) => node.healthSignal === 'behind').length,
      mine: userId === null ? 0 : rows.filter(({ node }) => node.assigneeIds.includes(userId)).length,
    };
  }, [rows, map.statusWorkflow, userId]);

  return (
    <div className="mb-body" style={{ paddingTop: 8 }}>
      <div className="mb-filter-row">
        {(['all', 'in_progress', 'behind', 'mine'] as const).map((f) => (
          <button
            key={f}
            className="mb-filter-chip"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f === 'in_progress' ? 'In progress' : f.charAt(0).toUpperCase() + f.slice(1)}
            <span className="mb-filter-count">{counts[f]}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        <div style={{ color: '#64748b', textAlign: 'center', padding: 24 }}>
          Nothing matches this filter.
        </div>
      )}

      {filtered.map(({ node, depth }) => {
        const s = statusOf(node, map.statusWorkflow);
        const pct = Math.round(node.computedProgress ?? 0);
        const healthCls =
          node.healthSignal === 'behind'
            ? 'mb-health-behind'
            : node.healthSignal === 'at_risk'
              ? 'mb-health-at_risk'
              : node.healthSignal === 'on_track'
                ? 'mb-health-on_track'
                : 'mb-health-unknown';
        return (
          <button
            key={node.id}
            className="mb-list-row"
            onClick={() => onSelect(node.id)}
            style={{ paddingLeft: 12 + depth * 14 }}
          >
            <span
              className="mb-list-priority"
              style={{ background: priorityColor(node.priority) }}
            />
            <div className="mb-list-main">
              <div className="mb-list-text">
                <span className={`mb-health-dot ${healthCls}`} />
                {node.text}
              </div>
              <div className="mb-list-meta">
                {s ? (
                  <span
                    className="mb-status-pill"
                    style={{
                      background: `${s.color}22`,
                      color: s.color,
                      borderColor: `${s.color}66`,
                    }}
                  >
                    {s.name}
                  </span>
                ) : (
                  <span className="mb-status-pill mb-status-pill-empty">No status</span>
                )}
                <span style={{ color: '#64748b' }}>{pct}%</span>
                {node.assigneeIds.length > 0 && (
                  <span style={{ color: '#64748b' }}>· {node.assigneeIds.length} assignee{node.assigneeIds.length === 1 ? '' : 's'}</span>
                )}
                {node.blockedReason && (
                  <span style={{ color: '#dc2626' }}>· blocked</span>
                )}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
