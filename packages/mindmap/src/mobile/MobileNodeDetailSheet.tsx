import { useEffect, useRef, useState } from 'react';
import type { MindMap, Node, StatusDef } from '@mindblown/core';
import * as api from '../api.js';
import type { NodeWithComputed } from '../api.js';
import { useMindmapStore } from '../store.js';
import { useTicketPhasesFor } from '../useTicketPhases.js';
import { promptStop } from '../StopTicketButton.js';
import { NeedsYouSection } from '../NeedsYouSection.js';

interface Props {
  node: NodeWithComputed;
  map: MindMap;
  byId: Map<string, NodeWithComputed>;
  onClose: () => void;
  /** Called with the server's updated node after any successful edit. */
  onChanged: (updated: Node) => void;
  /** Open another node's sheet (the parent that holds this one). */
  onOpenNode?: (id: string) => void;
  /** Go to the Fleet tab, where the rest of a hold is resolved. */
  onOpenFleet?: () => void;
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

export function MobileNodeDetailSheet({ node, map, byId, onClose, onChanged, onOpenNode, onOpenFleet }: Props) {
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
  // What the blocker is (flag_blocker's kind); '' = not sure — sorted after an hour.
  const [blockerKind, setBlockerKind] = useState<'' | 'question' | 'person-step' | 'external'>('');
  // A fleet agent working this ticket can be stopped from here (#549): Stop is a blocker.
  const agentRunning = useTicketPhasesFor(map.id, map.fleetId ?? null).get(node.id)?.agentRunning ?? false;
  const user = useMindmapStore((s) => s.user);
  const blockerInputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (blockerDraft !== null) blockerInputRef.current?.focus();
  }, [blockerDraft !== null]);

  // The map payload arrives without description/externalLinks (see
  // OMIT_FIELDS in MobileViewer) — fetch the full node once on open.
  const [full, setFull] = useState<Node | null>(null);
  // Widened view: the slim map payload physically lacks these keys even
  // though the Node type declares them.
  const slim = node as Partial<Node>;
  const needsFull = slim.description === undefined || slim.externalLinks === undefined;
  useEffect(() => {
    let cancelled = false;
    setFull(null);
    if (needsFull) {
      api
        .fetchNode(map.id, node.id)
        .then((n) => {
          if (!cancelled) setFull(n);
        })
        .catch(() => {
          // Sheet still works without the tail fields.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [map.id, node.id]);
  const description = node.description ?? full?.description ?? null;
  const externalLinks = node.externalLinks ?? full?.externalLinks ?? [];

  const save = async (fields: Record<string, unknown>) => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.updateNode(map.id, node.id, fields);
      onChanged(updated);
    } catch (e) {
      setSaveError((e as Error).message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // A blocker with a kind goes where it is answered (Questions card, Your steps, a re-check date).
  const flag = async (reason: string) => {
    if (!blockerKind) return save({ blockedReason: reason });
    setSaving(true);
    setSaveError(null);
    try {
      await api.flagBlocker(map.id, node.id, { kind: blockerKind, reason });
      onChanged(await api.fetchNode(map.id, node.id));
    } catch (e) {
      setSaveError((e as Error).message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const workflow = [...map.statusWorkflow].sort((a, b) => a.position - b.position);

  // The "Needs you" section reads the brief from the full node (#610).
  const detailNode: Node = full ? { ...node, description: full.description, externalLinks: full.externalLinks } : node;
  // Approve / reject / answer write on the server; this sheet has no socket, so re-read the node.
  const refresh = () => {
    api.fetchNode(map.id, node.id).then(onChanged, () => {});
  };
  const unblock = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const { node: updated } = await api.unblockNode(map.id, node.id);
      onChanged(updated);
      return true;
    } catch (e) {
      setSaveError((e as Error).message ?? 'Unblock failed');
      return false;
    } finally {
      setSaving(false);
    }
  };
  const saveBrief = async (text: string) => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.updateNode(map.id, node.id, { description: text });
      setFull(updated);
      onChanged(updated);
      return true;
    } catch (e) {
      setSaveError((e as Error).message ?? 'Save failed');
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="mb-sheet-backdrop" onClick={onClose} />
      <div className="mb-sheet mb-sheet-tall" role="dialog" aria-modal="true">
        <div className="mb-sheet-header">
          <span style={{ flex: 1, minWidth: 0, paddingRight: 12, overflowWrap: 'anywhere' }}>
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

          <NeedsYouSection
            mapId={map.id}
            node={detailNode}
            nodes={byId}
            workflow={map.statusWorkflow}
            mobile
            onUnblock={unblock}
            onSaveBrief={saveBrief}
            onRefresh={refresh}
            onOpenNode={onOpenNode}
            onOpenFleet={onOpenFleet}
          />

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
                <div style={{ color: '#b91c1c', flex: 1 }}>
                  {node.blockedReason}
                  {agentRunning && (
                    <div data-testid="mobile-stop-pending" style={{ fontSize: 12, fontWeight: 600, marginTop: 4 }}>
                      Stopping the fleet agent…
                    </div>
                  )}
                </div>
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
                <select
                  className="mb-select"
                  data-testid="mobile-blocker-kind"
                  value={blockerKind}
                  onChange={(e) => setBlockerKind(e.target.value as typeof blockerKind)}
                >
                  <option value="">What is it? (sorted in an hour if unsure)</option>
                  <option value="question">A question — asked on the Questions card</option>
                  <option value="person-step">A person's step — goes to Your steps</option>
                  <option value="external">Waiting on someone outside — asked again in 7 days</option>
                </select>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="mb-link" onClick={() => setBlockerDraft(null)}>
                    Cancel
                  </button>
                  <button
                    className="mb-btn-primary"
                    disabled={saving || !blockerDraft.trim()}
                    onClick={() =>
                      void flag(blockerDraft.trim()).then(() => setBlockerDraft(null))
                    }
                  >
                    Flag blocker
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {agentRunning && (
                  <button
                    className="mb-btn-soft"
                    data-testid="mobile-stop-ticket"
                    disabled={saving}
                    style={{ color: '#b91c1c' }}
                    onClick={() => {
                      const blocker = promptStop(user);
                      if (blocker !== null) void save({ blockedReason: blocker });
                    }}
                  >
                    Stop the fleet agent
                  </button>
                )}
                <button className="mb-btn-soft" onClick={() => setBlockerDraft('')}>
                  Flag a blocker
                </button>
              </div>
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

          {externalLinks.length > 0 && (
            <div className="mb-detail-section">
              <div className="mb-detail-label">Links</div>
              {externalLinks.map((l, i) => (
                <div key={i} className="mb-detail-row-soft">
                  <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ color: '#4f46e5' }}>
                    {l.provider}: {l.externalId}
                  </a>
                </div>
              ))}
            </div>
          )}

          {description && (
            <div className="mb-detail-section">
              <div className="mb-detail-label">Description</div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.5 }}>
                {description}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
