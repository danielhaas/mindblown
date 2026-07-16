import { useMemo, useState } from 'react';
import type { MindMap } from '@mindblown/core';
import type { NodeWithComputed } from '../api.js';

// Requirement status is never stored — always derived from the progress
// rollup, mirroring the desktop RequirementsView.

type ReqStatus = 'open' | 'partial' | 'done';
type Filter = 'all' | ReqStatus;

const STATUS_LABEL: Record<ReqStatus, string> = {
  done: 'Done',
  partial: 'Partial',
  open: 'Open',
};

const STATUS_COLOR: Record<ReqStatus, { bg: string; fg: string }> = {
  done: { bg: '#d1fae5', fg: '#065f46' },
  partial: { bg: '#fef3c7', fg: '#92400e' },
  open: { bg: '#f1f5f9', fg: '#475569' },
};

const PRIORITY_LABEL: Record<string, string> = {
  must: 'Must',
  should: 'Should',
  could: 'Could',
};

interface Props {
  nodes: NodeWithComputed[];
  map: MindMap;
  onSelect: (nodeId: string) => void;
}

interface ReqRow {
  node: NodeWithComputed;
  status: ReqStatus;
  chapterText: string;
}

function statusOf(progress: number): ReqStatus {
  return progress >= 100 ? 'done' : progress > 0 ? 'partial' : 'open';
}

export function MobileRequirementsView({ nodes, map, onSelect }: Props) {
  const [filter, setFilter] = useState<Filter>('all');

  const rows = useMemo<ReqRow[]>(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return nodes
      .filter((n) => n.requirementId != null)
      .map((n) => {
        const parent = n.parentId ? byId.get(n.parentId) : undefined;
        return {
          node: n,
          status: statusOf(n.computedProgress ?? 0),
          chapterText: parent && parent.id !== map.rootNodeId ? parent.text : '',
        };
      })
      .sort((a, b) =>
        (a.node.requirementId ?? '').localeCompare(b.node.requirementId ?? '', undefined, {
          numeric: true,
        }),
      );
  }, [nodes, map.rootNodeId]);

  const counts = useMemo(() => {
    const c = { all: rows.length, open: 0, partial: 0, done: 0 };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);

  const filtered = filter === 'all' ? rows : rows.filter((r) => r.status === filter);

  if (rows.length === 0) {
    return (
      <div className="mb-body">
        <div style={{ color: '#64748b', textAlign: 'center', padding: 24 }}>
          No requirements in this map yet. Tag nodes with a requirement ID from the
          desktop Requirements view.
        </div>
      </div>
    );
  }

  return (
    <div className="mb-body" style={{ paddingTop: 8 }}>
      <div className="mb-filter-row">
        {(['all', 'open', 'partial', 'done'] as const).map((f) => (
          <button
            key={f}
            className="mb-filter-chip"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All' : STATUS_LABEL[f]}
            <span className="mb-filter-count">{counts[f]}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        <div style={{ color: '#64748b', textAlign: 'center', padding: 24 }}>
          Nothing matches this filter.
        </div>
      )}

      {filtered.map(({ node, status, chapterText }) => {
        const sc = STATUS_COLOR[status];
        const pct = Math.round(node.computedProgress ?? 0);
        return (
          <button key={node.id} className="mb-req-card" onClick={() => onSelect(node.id)}>
            <div className="mb-req-card-top">
              <span className="mb-req-id">{node.requirementId}</span>
              <span
                className="mb-status-pill"
                style={{ background: sc.bg, color: sc.fg, borderColor: sc.bg }}
              >
                {STATUS_LABEL[status]}
                {status === 'partial' ? ` · ${pct}%` : ''}
              </span>
              {node.requirementPriority && (
                <span className="mb-req-priority">
                  {PRIORITY_LABEL[node.requirementPriority] ?? node.requirementPriority}
                </span>
              )}
            </div>
            <div className="mb-req-text">{node.requirementText ?? node.text}</div>
            {chapterText && <div className="mb-req-chapter">{chapterText}</div>}
          </button>
        );
      })}
    </div>
  );
}
