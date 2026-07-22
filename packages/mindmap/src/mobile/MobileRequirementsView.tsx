import { useMemo, useState } from 'react';
import type { MindMap, Version } from '@mindblown/core';
import type { NodeWithComputed } from '../api.js';

// Requirement status is never stored — always derived from the progress
// rollup, mirroring the desktop RequirementsView.

type ReqStatus = 'open' | 'partial' | 'done';
// 'todo' is the "hide done" button — open + partial in one tap, which is
// what you want on a phone far more often than any single status.
type Filter = 'all' | 'todo' | ReqStatus;

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
  versions: Version[];
  onSelect: (nodeId: string) => void;
}

interface ReqRow {
  node: NodeWithComputed;
  status: ReqStatus;
  chapterText: string;
  /** Release label; null when neither the requirement nor its subtree is scheduled. */
  releaseLabel: string | null;
  /** True when the label comes from the work below, not the requirement itself. */
  releaseInherited: boolean;
}

function statusOf(progress: number): ReqStatus {
  return progress >= 100 ? 'done' : progress > 0 ? 'partial' : 'open';
}

export function MobileRequirementsView({ nodes, map, versions, onSelect }: Props) {
  const [filter, setFilter] = useState<Filter>('all');

  const rows = useMemo<ReqRow[]>(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const versionName = new Map(versions.map((v) => [v.id, v.name]));

    // Requirements are usually tagged only on the work below them, so an
    // untagged one falls back to what its subtree carries (desktop parity).
    const descendantVersions = (id: string): string[] => {
      const found = new Set<string>();
      const stack = [...(byId.get(id)?.childrenIds ?? [])];
      while (stack.length) {
        const n = byId.get(stack.pop()!);
        if (!n) continue;
        if (n.versionId) found.add(n.versionId);
        stack.push(...n.childrenIds);
      }
      return [...found];
    };

    return nodes
      .filter((n) => n.requirementId != null)
      .map((n) => {
        const parent = n.parentId ? byId.get(n.parentId) : undefined;
        const below = n.versionId ? [] : descendantVersions(n.id);
        return {
          node: n,
          status: statusOf(n.computedProgress ?? 0),
          chapterText: parent && parent.id !== map.rootNodeId ? parent.text : '',
          releaseLabel: n.versionId
            ? (versionName.get(n.versionId) ?? '?')
            : below.length === 0
              ? null
              : below.length === 1
                ? (versionName.get(below[0]) ?? '?')
                : `${below.length} releases`,
          releaseInherited: !n.versionId,
        };
      })
      .sort((a, b) =>
        (a.node.requirementId ?? '').localeCompare(b.node.requirementId ?? '', undefined, {
          numeric: true,
        }),
      );
  }, [nodes, map.rootNodeId, versions]);

  const counts = useMemo(() => {
    const c = { all: rows.length, todo: 0, open: 0, partial: 0, done: 0 };
    for (const r of rows) {
      c[r.status] += 1;
      if (r.status !== 'done') c.todo += 1;
    }
    return c;
  }, [rows]);

  const filtered =
    filter === 'all'
      ? rows
      : filter === 'todo'
        ? rows.filter((r) => r.status !== 'done')
        : rows.filter((r) => r.status === filter);

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
        {(['all', 'todo', 'open', 'partial', 'done'] as const).map((f) => (
          <button
            key={f}
            className="mb-filter-chip"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All' : f === 'todo' ? 'Hide done' : STATUS_LABEL[f]}
            <span className="mb-filter-count">{counts[f]}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        <div style={{ color: '#64748b', textAlign: 'center', padding: 24 }}>
          Nothing matches this filter.
        </div>
      )}

      {filtered.map(({ node, status, chapterText, releaseLabel, releaseInherited }) => {
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
              {releaseLabel && (
                <span
                  className="mb-req-release"
                  title={
                    releaseInherited
                      ? 'Inherited from the work below this requirement'
                      : 'Release tagged on this requirement'
                  }
                  style={releaseInherited ? { fontStyle: 'italic', opacity: 0.75 } : undefined}
                >
                  {releaseInherited ? `↳ ${releaseLabel}` : releaseLabel}
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
