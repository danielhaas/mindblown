import { useEffect, useRef, useState } from 'react';
import type { MindMap, StatusDef } from '@mindblown/core';
import * as api from '../api.js';
import type { NodeWithComputed } from '../api.js';

interface Props {
  node: NodeWithComputed;
  map: MindMap;
  byId: Map<string, NodeWithComputed>;
  onClose: () => void;
  /** Called after any successful edit so the owner can re-fetch rollups. */
  onChanged: () => void;
}

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;

function statusOf(node: NodeWithComputed, workflow: StatusDef[]): StatusDef | null {
  if (!node.status) return null;
  return workflow.find((s) => s.id === node.status) ?? null;
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

export function MobileNodeDetailSheet({ node, map, byId, onClose, onChanged }: Props) {
  const s = statusOf(node, map.statusWorkflow);
  const isLeaf = node.childrenIds.length === 0;
  const ancestors = pathTo(node, byId).slice(1); // skip the root node

  const deps = node.dependencies ?? [];
  const blockedBy = deps.filter((d) => d.type === 'FS' || d.type === 'SS');

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Slider state is local while dragging; committed on release.
  const [draftPct, setDraftPct] = useState<number | null>(null);
  const pct = draftPct ?? Math.round(isLeaf ? node.percentComplete ?? 0 : node.computedProgress ?? 0);

  const [blockerDraft, setBlockerDraft] = useState<string | null>(null);
  const blockerInputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (blockerDraft !== null) blockerInputRef.current?.focus();
  }, [blockerDraft !== null]);

  const save = async (fields: Record<string, unknown>) => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateNode(map.id, node.id, fields);
      onChanged();
    } catch (e) {
      setSaveError((e as Error).message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const workflow = [...map.statusWorkflow].sort((a, b) => a.position - b.position);

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

          {saveError && <div className="mb-error">{saveError}</div>}

          <div className="mb-detail-section">
            <div className="mb-detail-label">Status</div>
            <div className="mb-edit-pill-row">
              {workflow.map((w) => {
                const active = node.status === w.id;
                return (
                  <button
                    key={w.id}
                    className="mb-status-pill mb-status-pill-tappable"
                    aria-pressed={active}
                    disabled={saving}
                    style={
                      active
                        ? { background: w.color, color: '#fff', borderColor: w.color }
                        : { background: `${w.color}18`, color: w.color, borderColor: `${w.color}55` }
                    }
                    onClick={() => void save({ status: active ? null : w.id })}
                  >
                    {w.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mb-detail-section">
            <div className="mb-detail-label">
              Progress · {pct}%{!isLeaf && ' (auto from children)'}
            </div>
            {isLeaf ? (
              <input
                type="range"
                className="mb-progress-slider"
                min={0}
                max={100}
                step={5}
                value={pct}
                disabled={saving}
                onChange={(e) => setDraftPct(Number(e.target.value))}
                onPointerUp={() => {
                  if (draftPct !== null && draftPct !== (node.percentComplete ?? 0)) {
                    void save({ percentComplete: draftPct }).then(() => setDraftPct(null));
                  } else {
                    setDraftPct(null);
                  }
                }}
              />
            ) : (
              <div className="mb-progress-track">
                <div className="mb-progress-fill" style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>

          <div className="mb-detail-section">
            <div className="mb-detail-label">Priority</div>
            <div className="mb-edit-pill-row">
              {PRIORITIES.map((p) => {
                const active = node.priority === p;
                return (
                  <button
                    key={p}
                    className="mb-status-pill mb-status-pill-tappable"
                    aria-pressed={active}
                    disabled={saving}
                    onClick={() => void save({ priority: active ? null : p })}
                  >
                    {p}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mb-detail-section">
            <div className="mb-detail-label">Blocked</div>
            {node.blockedReason ? (
              <div className="mb-blocker-box">
                <div style={{ color: '#b91c1c', flex: 1 }}>{node.blockedReason}</div>
                <button
                  className="mb-link"
                  disabled={saving}
                  onClick={() => void save({ blockedReason: null })}
                >
                  Clear
                </button>
              </div>
            ) : blockerDraft !== null ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <textarea
                  ref={blockerInputRef}
                  className="mb-textarea"
                  rows={2}
                  placeholder="What is blocking this?"
                  value={blockerDraft}
                  onChange={(e) => setBlockerDraft(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="mb-link" onClick={() => setBlockerDraft(null)}>
                    Cancel
                  </button>
                  <button
                    className="mb-btn-primary"
                    disabled={saving || !blockerDraft.trim()}
                    onClick={() =>
                      void save({ blockedReason: blockerDraft.trim() }).then(() => setBlockerDraft(null))
                    }
                  >
                    Flag blocker
                  </button>
                </div>
              </div>
            ) : (
              <button className="mb-btn-soft" onClick={() => setBlockerDraft('')}>
                Flag a blocker
              </button>
            )}
          </div>

          <div className="mb-detail-grid">
            <div className="mb-detail-cell">
              <div className="mb-detail-label">Health</div>
              <div>{(node.healthSignal ?? 'unknown').replace('_', ' ')}</div>
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
              <div className="mb-detail-label">Children</div>
              <div>
                {isLeaf
                  ? 'Leaf node'
                  : `${node.childrenIds.length} child${node.childrenIds.length === 1 ? '' : 'ren'}`}
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
        </div>
      </div>
    </>
  );
}
