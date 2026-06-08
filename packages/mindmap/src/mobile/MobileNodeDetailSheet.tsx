import type { MindMap, StatusDef } from '@mindblown/core';
import type { NodeWithComputed } from '../api.js';

interface Props {
  node: NodeWithComputed;
  map: MindMap;
  byId: Map<string, NodeWithComputed>;
  onClose: () => void;
}

function statusOf(node: NodeWithComputed, workflow: StatusDef[]): StatusDef | null {
  if (!node.status) return null;
  return workflow.find((s) => s.id === node.status) ?? null;
}

function priorityLabel(p: string | null): string {
  return p ?? '—';
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function pathTo(node: NodeWithComputed, byId: Map<string, NodeWithComputed>): NodeWithComputed[] {
  const out: NodeWithComputed[] = [];
  let cur: NodeWithComputed | undefined = node;
  while (cur && cur.parentId) {
    const parent = byId.get(cur.parentId);
    if (!parent) break;
    out.unshift(parent);
    cur = parent;
  }
  return out;
}

export function MobileNodeDetailSheet({ node, map, byId, onClose }: Props) {
  const s = statusOf(node, map.statusWorkflow);
  const pct = Math.round(node.computedProgress ?? 0);
  const ancestors = pathTo(node, byId).slice(1); // skip the root node

  const deps = node.dependencies ?? [];
  const blockedBy = deps.filter((d) => d.type === 'FS' || d.type === 'SS');

  return (
    <>
      <div className="mb-sheet-backdrop" onClick={onClose} />
      <div className="mb-sheet mb-sheet-tall" role="dialog" aria-modal="true">
        <div className="mb-sheet-header">
          <span style={{ flex: 1, paddingRight: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {node.text}
          </span>
          <button className="mb-link" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="mb-sheet-body" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {ancestors.length > 0 && (
            <div className="mb-detail-breadcrumb">
              {ancestors.map((a, i) => (
                <span key={a.id}>
                  {a.text}
                  {i < ancestors.length - 1 ? ' / ' : ''}
                </span>
              ))}
            </div>
          )}

          <div className="mb-detail-grid">
            <div className="mb-detail-cell">
              <div className="mb-detail-label">Status</div>
              <div>
                {s ? (
                  <span
                    className="mb-status-pill"
                    style={{ background: `${s.color}22`, color: s.color, borderColor: `${s.color}66` }}
                  >
                    {s.name}
                  </span>
                ) : (
                  <span className="mb-status-pill mb-status-pill-empty">No status</span>
                )}
              </div>
            </div>
            <div className="mb-detail-cell">
              <div className="mb-detail-label">Progress</div>
              <div>{pct}%</div>
            </div>
            <div className="mb-detail-cell">
              <div className="mb-detail-label">Health</div>
              <div>{(node.healthSignal ?? 'unknown').replace('_', ' ')}</div>
            </div>
            <div className="mb-detail-cell">
              <div className="mb-detail-label">Priority</div>
              <div>{priorityLabel(node.priority)}</div>
            </div>
            <div className="mb-detail-cell">
              <div className="mb-detail-label">Estimate</div>
              <div>
                {node.computedEffort > 0
                  ? `${node.computedEffort} ${map.effortUnit}`
                  : node.effortEstimate !== null
                    ? `${node.effortEstimate} ${map.effortUnit}`
                    : '—'}
              </div>
            </div>
            <div className="mb-detail-cell">
              <div className="mb-detail-label">Actual</div>
              <div>
                {node.actualEffort !== null ? `${node.actualEffort} ${map.effortUnit}` : '—'}
              </div>
            </div>
            <div className="mb-detail-cell">
              <div className="mb-detail-label">Start</div>
              <div>{formatDate(node.startDate)}</div>
            </div>
            <div className="mb-detail-cell">
              <div className="mb-detail-label">Due</div>
              <div>{formatDate(node.dueDate)}</div>
            </div>
          </div>

          {node.blockedReason && (
            <div className="mb-detail-section">
              <div className="mb-detail-label">Blocked</div>
              <div style={{ color: '#b91c1c' }}>{node.blockedReason}</div>
            </div>
          )}

          {blockedBy.length > 0 && (
            <div className="mb-detail-section">
              <div className="mb-detail-label">Depends on</div>
              {blockedBy.map((d) => {
                const dep = byId.get(d.targetNodeId);
                return (
                  <div key={d.targetNodeId} className="mb-detail-row-soft">
                    {d.type} · {dep?.text ?? d.targetNodeId}
                  </div>
                );
              })}
            </div>
          )}

          {node.scopes.length > 0 && (
            <div className="mb-detail-section">
              <div className="mb-detail-label">Scopes</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {node.scopes.map((scope) => (
                  <span key={scope} className="mb-detail-chip">
                    {scope}
                  </span>
                ))}
              </div>
            </div>
          )}

          {node.tags.length > 0 && (
            <div className="mb-detail-section">
              <div className="mb-detail-label">Tags</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {node.tags.map((tag) => (
                  <span key={tag} className="mb-detail-chip">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {node.externalLinks.length > 0 && (
            <div className="mb-detail-section">
              <div className="mb-detail-label">Links</div>
              {node.externalLinks.map((l, i) => (
                <div key={i} className="mb-detail-row-soft">
                  <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ color: '#4f46e5' }}>
                    {l.provider}: {l.externalId}
                  </a>
                </div>
              ))}
            </div>
          )}

          {node.description && (
            <div className="mb-detail-section">
              <div className="mb-detail-label">Description</div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.5 }}>
                {node.description}
              </div>
            </div>
          )}

          <div className="mb-detail-section">
            <div className="mb-detail-label">Children</div>
            <div style={{ color: '#475569', fontSize: 13 }}>
              {node.childrenIds.length === 0
                ? 'Leaf node'
                : `${node.childrenIds.length} child${node.childrenIds.length === 1 ? '' : 'ren'}`}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
