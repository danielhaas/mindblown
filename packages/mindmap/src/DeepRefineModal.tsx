import { useState, useEffect, useCallback, useRef } from 'react';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { GroupProposal } from './api.js';
import type { Node } from '@mindblown/core';

interface Props {
  mapId: string;
  rootId: string;
  rootText: string;
  onClose: () => void;
}

// Same threshold as the wide-fanout warning badge — a node is "wide" when
// it has ≥ this many direct children. Refining below this isn't worth a
// round trip.
const WIDE_FANOUT_THRESHOLD = 8;
// Cap concurrent /refine_structure calls so we don't overwhelm the LLM
// (Ollama serializes per-model anyway, but more in flight = more queue
// time per request and a less responsive UI).
const CONCURRENCY = 3;

type SubtreeState =
  | { status: 'pending'; parentId: string; parentText: string }
  | { status: 'loading'; parentId: string; parentText: string }
  | {
      status: 'done';
      parentId: string;
      parentText: string;
      summary: string;
      proposals: GroupProposal[];
    }
  | { status: 'error'; parentId: string; parentText: string; error: string };

/** Walk down from rootId, collecting every node with ≥ threshold children.
 * Doesn't recurse into collapsed branches (matches what the user sees). */
function collectWideSubtrees(
  rootId: string,
  nodes: Record<string, Node>,
  threshold: number,
): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  const stack: string[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const n = nodes[id];
    if (!n) continue;
    if (n.collapsed) continue;
    if (n.childrenIds.length >= threshold) {
      out.push({ id, text: n.text });
    }
    for (const c of n.childrenIds) stack.push(c);
  }
  return out;
}

export function DeepRefineModal({ mapId, rootId, rootText, onClose }: Props) {
  // Display-only subscription — used to render member names. Re-renders
  // from this don't trigger refine calls (those are gated by the once-
  // computed wideSubtrees below).
  const allNodes = useMindmapStore((s) => s.nodes);
  const loadMap = useMindmapStore((s) => s.loadMap);

  // CRITICAL: capture the wide-subtree list ONCE on mount. If we recompute
  // on every store change, every WS broadcast during apply (each move
  // mutates the nodes record) re-fires the effect below and queues
  // duplicate refine_structure calls. That cascade swamps Ollama and
  // blocks the apply endpoint behind a 100+-deep queue.
  const [wideSubtrees] = useState(() =>
    collectWideSubtrees(
      rootId,
      useMindmapStore.getState().nodes,
      WIDE_FANOUT_THRESHOLD,
    ),
  );

  const [subtrees, setSubtrees] = useState<SubtreeState[]>(() =>
    wideSubtrees.map((s) => ({
      status: 'pending',
      parentId: s.id,
      parentText: s.text,
    })),
  );
  /** accepted[parentId] = Set of proposal indices the user has ticked. */
  const [accepted, setAccepted] = useState<Record<string, Set<number>>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyProgress, setApplyProgress] = useState<{ done: number; total: number } | null>(null);

  // Fire off the per-subtree refine calls with a concurrency cap. Each
  // result lands as soon as it's ready so the user sees progress.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    const queue = [...wideSubtrees];
    let inFlight = 0;

    const drain = () => {
      while (inFlight < CONCURRENCY && queue.length > 0) {
        const next = queue.shift()!;
        inFlight++;
        setSubtrees((prev) =>
          prev.map((s) =>
            s.parentId === next.id ? { ...s, status: 'loading' } : s,
          ),
        );
        api
          .aiRefineStructure(mapId, next.id)
          .then((res) => {
            if (cancelledRef.current) return;
            setSubtrees((prev) =>
              prev.map((s) =>
                s.parentId === next.id
                  ? {
                      status: 'done',
                      parentId: next.id,
                      parentText: next.text,
                      summary: res.summary,
                      proposals: res.proposals,
                    }
                  : s,
              ),
            );
            // Accept-all by default so the user uchecks rather than ticks
            // each one individually — same default as RefineModal.
            setAccepted((prev) => ({
              ...prev,
              [next.id]: new Set(res.proposals.map((_, i) => i)),
            }));
          })
          .catch((err) => {
            if (cancelledRef.current) return;
            setSubtrees((prev) =>
              prev.map((s) =>
                s.parentId === next.id
                  ? {
                      status: 'error',
                      parentId: next.id,
                      parentText: next.text,
                      error: err.message ?? 'Failed to load',
                    }
                  : s,
              ),
            );
          })
          .finally(() => {
            inFlight--;
            drain();
          });
      }
    };
    drain();
    return () => {
      cancelledRef.current = true;
    };
    // wideSubtrees is intentionally stable (captured once on mount) — see
    // the comment where it's declared. Including it in deps would be
    // harmless given the stability but masks the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapId]);

  const toggleAccepted = (parentId: string, idx: number) => {
    setAccepted((prev) => {
      const cur = new Set(prev[parentId] ?? []);
      if (cur.has(idx)) cur.delete(idx);
      else cur.add(idx);
      return { ...prev, [parentId]: cur };
    });
  };

  const toggleSection = (parentId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  };

  const totalAccepted = Object.values(accepted).reduce((n, s) => n + s.size, 0);
  const loadingCount = subtrees.filter(
    (s) => s.status === 'pending' || s.status === 'loading',
  ).length;
  const errorCount = subtrees.filter((s) => s.status === 'error').length;

  const apply = useCallback(async () => {
    // Build the list of (parentId, proposals[]) pairs that have selections.
    const batch: Array<{
      parentId: string;
      proposals: Array<Pick<GroupProposal, 'kind' | 'memberIds' | 'suggestedLabel'>>;
    }> = [];
    for (const s of subtrees) {
      if (s.status !== 'done') continue;
      const sel = accepted[s.parentId];
      if (!sel || sel.size === 0) continue;
      const selected = s.proposals
        .map((p, i) => ({ p, i }))
        .filter(({ i }) => sel.has(i))
        .map(({ p }) => ({
          kind: 'group' as const,
          memberIds: p.memberIds,
          suggestedLabel: p.suggestedLabel,
        }));
      if (selected.length > 0) {
        batch.push({ parentId: s.parentId, proposals: selected });
      }
    }
    if (batch.length === 0) return;

    setApplying(true);
    setError(null);
    setApplyProgress({ done: 0, total: batch.length });

    try {
      // Sequential apply so the WS broadcasts arrive in a sensible order
      // and we can show progress. Each call is fast (just DB writes).
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        await api.aiRefineStructureApply(mapId, item.parentId, item.proposals);
        setApplyProgress({ done: i + 1, total: batch.length });
      }
      await loadMap(mapId);
      onClose();
    } catch (err: any) {
      setError(err.message ?? 'Apply failed');
      setApplying(false);
    }
  }, [subtrees, accepted, mapId, loadMap, onClose]);

  return (
    <>
      <div style={backdropStyle} onClick={onClose} />
      <div style={modalStyle}>
        <div style={headerStyle}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, color: '#0f172a' }}>
              Deep refine
            </div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
              From: {rootText} — {wideSubtrees.length} wide subtree
              {wideSubtrees.length !== 1 ? 's' : ''} found
            </div>
          </div>
          <button onClick={onClose} style={closeBtnStyle}>&times;</button>
        </div>

        <div style={bodyStyle}>
          {wideSubtrees.length === 0 && (
            <div style={{ color: '#475569', fontSize: 13, padding: '12px 0' }}>
              No subtrees are wide enough to refine (threshold is ≥{WIDE_FANOUT_THRESHOLD} children).
            </div>
          )}

          {loadingCount > 0 && (
            <div style={progressStyle}>
              Analyzing {loadingCount} subtree{loadingCount !== 1 ? 's' : ''}…
            </div>
          )}

          {applyProgress && (
            <div style={progressStyle}>
              Applying changes ({applyProgress.done}/{applyProgress.total})…
            </div>
          )}

          {subtrees.map((s) => (
            <SubtreeSection
              key={s.parentId}
              subtree={s}
              accepted={accepted[s.parentId] ?? new Set<number>()}
              collapsed={collapsed.has(s.parentId)}
              onToggleCollapse={() => toggleSection(s.parentId)}
              onToggleProposal={(idx) => toggleAccepted(s.parentId, idx)}
              memberText={(id) => allNodes[id]?.text ?? `(${id.slice(0, 6)})`}
            />
          ))}

          {error && (
            <div style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>{error}</div>
          )}
        </div>

        <div style={footerStyle}>
          <div style={{ flex: 1, fontSize: 11, color: '#64748b' }}>
            {errorCount > 0 && `${errorCount} failed · `}
            {totalAccepted} change{totalAccepted !== 1 ? 's' : ''} selected
          </div>
          <button onClick={onClose} style={secondaryBtnStyle}>Close</button>
          <button
            onClick={apply}
            disabled={applying || totalAccepted === 0 || loadingCount > 0}
            style={primaryBtnStyle}
            title={loadingCount > 0 ? 'Waiting for analysis to finish…' : undefined}
          >
            {applying
              ? 'Applying...'
              : `Apply ${totalAccepted} change${totalAccepted !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </>
  );
}

// ── Subtree section ────────────────────────────────────────────

interface SubtreeSectionProps {
  subtree: SubtreeState;
  accepted: Set<number>;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onToggleProposal: (idx: number) => void;
  memberText: (id: string) => string;
}

function SubtreeSection({
  subtree,
  accepted,
  collapsed,
  onToggleCollapse,
  onToggleProposal,
  memberText,
}: SubtreeSectionProps) {
  const proposalCount =
    subtree.status === 'done' ? subtree.proposals.length : 0;
  const statusBadge =
    subtree.status === 'pending'
      ? <span style={badgeStyle('#94a3b8', '#f1f5f9')}>queued</span>
      : subtree.status === 'loading'
        ? <span style={badgeStyle('#0891b2', '#cffafe')}>loading</span>
        : subtree.status === 'error'
          ? <span style={badgeStyle('#dc2626', '#fee2e2')}>error</span>
          : proposalCount === 0
            ? <span style={badgeStyle('#16a34a', '#dcfce7')}>balanced</span>
            : <span style={badgeStyle('#6366f1', '#eef2ff')}>{proposalCount} group{proposalCount !== 1 ? 's' : ''}</span>;

  return (
    <div style={sectionStyle}>
      <div
        style={sectionHeaderStyle}
        onClick={onToggleCollapse}
      >
        <span style={{ fontSize: 12, color: '#94a3b8', marginRight: 4 }}>
          {collapsed ? '▶' : '▼'}
        </span>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>
          {subtree.parentText}
        </span>
        {statusBadge}
      </div>

      {!collapsed && subtree.status === 'done' && proposalCount > 0 && (
        <div style={{ padding: '8px 12px 0' }}>
          {subtree.summary && (
            <div style={summaryStyle}>{subtree.summary}</div>
          )}
          {subtree.proposals.map((p, i) => {
            const isAccepted = accepted.has(i);
            return (
              <div
                key={i}
                style={{
                  ...proposalStyle,
                  opacity: isAccepted ? 1 : 0.5,
                  borderColor: isAccepted ? '#c7d2fe' : '#e2e8f0',
                  background: isAccepted ? '#eef2ff' : '#f8fafc',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={isAccepted}
                    onChange={() => onToggleProposal(i)}
                    style={{ cursor: 'pointer' }}
                  />
                  <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>
                    {p.suggestedLabel}
                  </span>
                </div>
                {p.reason && (
                  <div style={reasonStyle}>{p.reason}</div>
                )}
                <div style={{ marginTop: 4, paddingLeft: 24 }}>
                  {p.memberIds.map((id) => (
                    <div key={id} style={memberLineStyle}>
                      <span style={{ color: '#94a3b8', marginRight: 4 }}>↳</span>
                      {memberText(id)}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!collapsed && subtree.status === 'error' && (
        <div style={{ padding: '8px 12px', fontSize: 12, color: '#dc2626' }}>
          {subtree.error}
        </div>
      )}
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.3)',
  zIndex: 2000,
};

const modalStyle: React.CSSProperties = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: 2001,
  background: '#fff',
  borderRadius: 12,
  boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
  width: 620,
  maxHeight: '85vh',
  display: 'flex',
  flexDirection: 'column',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  padding: '16px 20px 12px',
  borderBottom: '1px solid #e2e8f0',
};

const bodyStyle: React.CSSProperties = {
  padding: '12px 16px',
  overflowY: 'auto',
  flex: 1,
};

const footerStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  padding: '12px 20px',
  borderTop: '1px solid #e2e8f0',
};

const progressStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#475569',
  background: '#f1f5f9',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  padding: '6px 10px',
  marginBottom: 10,
};

const sectionStyle: React.CSSProperties = {
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  marginBottom: 8,
  background: '#fff',
  overflow: 'hidden',
};

const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '10px 12px',
  cursor: 'pointer',
  background: '#f8fafc',
  borderBottom: '1px solid #f1f5f9',
};

const summaryStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#475569',
  fontStyle: 'italic',
  marginBottom: 8,
};

const proposalStyle: React.CSSProperties = {
  border: '1px solid',
  borderRadius: 6,
  padding: '8px 10px',
  marginBottom: 6,
};

const reasonStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#64748b',
  fontStyle: 'italic',
  marginTop: 4,
  paddingLeft: 24,
};

const memberLineStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#334155',
  padding: '1px 0',
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '7px 16px',
  background: '#3b82f6',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '7px 16px',
  background: '#f1f5f9',
  color: '#475569',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  fontSize: 13,
  cursor: 'pointer',
};

const closeBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  fontSize: 20,
  color: '#94a3b8',
  cursor: 'pointer',
  padding: '0 4px',
  lineHeight: 1,
};

function badgeStyle(fg: string, bg: string): React.CSSProperties {
  return {
    fontSize: 10,
    fontWeight: 600,
    color: fg,
    background: bg,
    padding: '2px 6px',
    borderRadius: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  };
}
