import { useMemo, useState } from 'react';
import {
  requirementStage,
  stageCounts,
  BUILT_THRESHOLD,
  STAGE_LABEL,
  STAGE_COLOR,
} from '@mindblown/core';
import type { MindMap, Version, RequirementStage } from '@mindblown/core';
import type { AcceptanceRow, NodeWithComputed } from '../api.js';

// The stage is never stored — derived from the progress rollup folded
// with the sign-off verdicts, mirroring the desktop RequirementsView.
// "Built" ≠ "Accepted" here too: same words, same colours, one source
// in @mindblown/core.

// 'todo' is the "hide built" button — everything not yet built in one
// tap, which is what you want on a phone more often than any single stage.
type Filter = 'all' | 'todo' | RequirementStage;

const PRIORITY_LABEL: Record<string, string> = {
  must: 'Must',
  should: 'Should',
  could: 'Could',
};

interface Props {
  nodes: NodeWithComputed[];
  map: MindMap;
  versions: Version[];
  acceptances: AcceptanceRow[];
  onSelect: (nodeId: string) => void;
}

interface ReqRow {
  node: NodeWithComputed;
  stage: RequirementStage;
  /** Progress alone — drives the "todo" filter and the % suffix. */
  built: boolean;
  chapterText: string;
  /** Release label; null when neither the requirement nor its subtree is scheduled. */
  releaseLabel: string | null;
  /** True when the label comes from the work below, not the requirement itself. */
  releaseInherited: boolean;
}

export function MobileRequirementsView({
  nodes,
  map,
  versions,
  acceptances,
  onSelect,
}: Props) {
  const [filter, setFilter] = useState<Filter>('all');

  const rows = useMemo<ReqRow[]>(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const versionName = new Map(versions.map((v) => [v.id, v.name]));
    const accByNode = new Map<string, AcceptanceRow[]>();
    for (const a of acceptances) {
      const list = accByNode.get(a.nodeId) ?? [];
      list.push(a);
      accByNode.set(a.nodeId, list);
    }

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
        const progress = n.computedProgress ?? 0;
        return {
          node: n,
          stage: requirementStage(progress, accByNode.get(n.id) ?? []),
          built: progress >= BUILT_THRESHOLD,
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
  }, [nodes, map.rootNodeId, versions, acceptances]);

  const counts = useMemo(
    () => ({
      ...stageCounts(rows.map((r) => r.stage)),
      all: rows.length,
      todo: rows.filter((r) => !r.built).length,
      built: rows.filter((r) => r.built).length,
    }),
    [rows],
  );

  const filtered =
    filter === 'all'
      ? rows
      : filter === 'todo'
        ? rows.filter((r) => !r.built)
        : rows.filter((r) => r.stage === filter);

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
      {/* Lead with the accepted count — the whole point of the stage split
          is that "gebaut" must not read as the finish line. */}
      <div style={{ padding: '0 12px 8px', fontSize: 12, color: '#64748b' }}>
        <b style={{ fontSize: 17, color: '#047857' }}>{counts.accepted}</b> of {rows.length}{' '}
        accepted · {counts.built} built
      </div>
      <div className="mb-filter-row">
        {(['all', 'todo', 'accepted', 'it_verified', 'built', 'in_progress', 'open', 'rejected'] as const)
          // Rejected is a chip only when there is something to show.
          .filter((f) => f !== 'rejected' || counts.rejected > 0)
          .map((f) => (
            <button
              key={f}
              className="mb-filter-chip"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All' : f === 'todo' ? 'Open work' : STAGE_LABEL[f]}
              <span className="mb-filter-count">{counts[f]}</span>
            </button>
          ))}
      </div>

      {filtered.length === 0 && (
        <div style={{ color: '#64748b', textAlign: 'center', padding: 24 }}>
          Nothing matches this filter.
        </div>
      )}

      {filtered.map(({ node, stage, chapterText, releaseLabel, releaseInherited }) => {
        const sc = STAGE_COLOR[stage];
        const pct = Math.round(node.computedProgress ?? 0);
        return (
          <button key={node.id} className="mb-req-card" onClick={() => onSelect(node.id)}>
            <div className="mb-req-card-top">
              <span className="mb-req-id">{node.requirementId}</span>
              <span
                className="mb-status-pill"
                style={{ background: sc.bg, color: sc.fg, borderColor: sc.bg }}
              >
                {STAGE_LABEL[stage]}
                {stage === 'in_progress' ? ` · ${pct}%` : ''}
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
            {/* Node title first, business phrasing under it — same order as
                the desktop register. Showing only the phrasing hid the name
                the node carries everywhere else. */}
            <div className="mb-req-text">{node.text}</div>
            {node.requirementText != null && node.requirementText !== node.text && (
              <div className="mb-req-statement">{node.requirementText}</div>
            )}
            {chapterText && <div className="mb-req-chapter">{chapterText}</div>}
          </button>
        );
      })}
    </div>
  );
}
