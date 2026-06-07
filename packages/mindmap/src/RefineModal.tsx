import { useState, useEffect, useCallback } from 'react';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { GroupProposal } from './api.js';

interface Props {
  mapId: string;
  parentId: string;
  parentText: string;
  onClose: () => void;
}

export function RefineModal({ mapId, parentId, parentText, onClose }: Props) {
  const [proposals, setProposals] = useState<GroupProposal[]>([]);
  const [summary, setSummary] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const [labelOverrides, setLabelOverrides] = useState<Record<number, string>>({});
  // After a successful apply we stash the totals so we can show what
  // landed before kicking off the next round.
  const [appliedToast, setAppliedToast] = useState<{ groups: number; moved: number } | null>(null);

  const nodes = useMindmapStore((s) => s.nodes);
  const loadMap = useMindmapStore((s) => s.loadMap);

  // Fetch (or re-fetch) proposals. Same body used on first open and after
  // each apply so multi-round refinement just re-runs against the new
  // state of the parent's children.
  const fetchProposals = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .aiRefineStructure(mapId, parentId)
      .then((res) => {
        if (cancelled) return;
        setProposals(res.proposals);
        setSummary(res.summary);
        setLabelOverrides({});
        setAccepted(new Set(res.proposals.map((_, i) => i)));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || 'Failed to load suggestions');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mapId, parentId]);

  useEffect(() => {
    return fetchProposals();
  }, [fetchProposals]);

  const toggle = (idx: number) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const setLabel = (idx: number, value: string) => {
    setLabelOverrides((prev) => ({ ...prev, [idx]: value }));
  };

  const apply = useCallback(async () => {
    const selected = proposals
      .map((p, i) => ({ p, i }))
      .filter(({ i }) => accepted.has(i))
      .map(({ p, i }) => ({
        kind: 'group' as const,
        memberIds: p.memberIds,
        suggestedLabel: (labelOverrides[i] ?? p.suggestedLabel).trim() || p.suggestedLabel,
      }));

    if (selected.length === 0) return;

    setApplying(true);
    setError(null);
    try {
      const result = await api.aiRefineStructureApply(mapId, parentId, selected);
      // Surface what landed *before* the next round so the user sees the
      // delta. The toast clears the next time fetchProposals resolves.
      setAppliedToast({ groups: result.createdCount, moved: result.movedCount });
      // Refresh the local map so wideFanoutCount on the parent updates,
      // then kick off another round of refinement against the new state.
      await loadMap(mapId);
      fetchProposals();
    } catch (err: any) {
      setError(err.message || 'Failed to apply changes');
    } finally {
      setApplying(false);
    }
  }, [proposals, accepted, labelOverrides, mapId, parentId, loadMap, fetchProposals]);

  const memberText = (id: string): string => {
    const n = nodes[id];
    return n?.text ?? `(unknown ${id.slice(0, 6)})`;
  };

  return (
    <>
      <div style={backdropStyle} onClick={onClose} />
      <div style={modalStyle}>
        <div style={headerStyle}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, color: '#0f172a' }}>
              Refine structure
            </div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
              Under: {parentText}
            </div>
          </div>
          <button onClick={onClose} style={closeBtnStyle}>&times;</button>
        </div>

        <div style={bodyStyle}>
          {appliedToast && (
            <div style={toastStyle}>
              ✓ Applied {appliedToast.groups} group{appliedToast.groups !== 1 ? 's' : ''} ({appliedToast.moved} moved). {loading ? 'Looking for more…' : ''}
            </div>
          )}

          {loading && !appliedToast && (
            <div style={{ color: '#64748b', fontSize: 13, padding: '12px 0' }}>
              Analyzing children…
            </div>
          )}

          {!loading && summary && proposals.length > 0 && (
            <div style={summaryStyle}>{summary}</div>
          )}

          {!loading && proposals.length === 0 && !error && (
            <div style={{ color: '#475569', fontSize: 13, padding: '8px 0' }}>
              {appliedToast
                ? 'No further suggestions — structure looks balanced now.'
                : 'No grouping suggestions — the current structure looks fine.'}
            </div>
          )}

          {!loading &&
            proposals.map((p, i) => {
              const isAccepted = accepted.has(i);
              const label = labelOverrides[i] ?? p.suggestedLabel;
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
                      onChange={() => toggle(i)}
                      style={{ cursor: 'pointer' }}
                    />
                    <span style={{ fontSize: 11, color: '#6366f1', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      Group {i + 1}
                    </span>
                    <input
                      type="text"
                      value={label}
                      onChange={(e) => setLabel(i, e.target.value)}
                      disabled={!isAccepted}
                      style={{ ...inputStyle, flex: 1, fontSize: 13, fontWeight: 600 }}
                    />
                  </div>
                  {p.reason && (
                    <div style={reasonStyle}>{p.reason}</div>
                  )}
                  <div style={{ marginTop: 6, paddingLeft: 28 }}>
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

          {error && (
            <div style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>{error}</div>
          )}
        </div>

        <div style={footerStyle}>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={secondaryBtnStyle}>
            {proposals.length === 0 && !loading ? 'Done' : 'Close'}
          </button>
          {proposals.length > 0 && (
            <button
              onClick={apply}
              disabled={applying || accepted.size === 0}
              style={primaryBtnStyle}
            >
              {applying
                ? 'Applying...'
                : `Apply ${accepted.size} change${accepted.size !== 1 ? 's' : ''}`}
            </button>
          )}
        </div>
      </div>
    </>
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
  width: 580,
  maxHeight: '80vh',
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
  padding: '16px 20px',
  overflowY: 'auto',
  flex: 1,
};

const footerStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  padding: '12px 20px',
  borderTop: '1px solid #e2e8f0',
};

const summaryStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#475569',
  background: '#f1f5f9',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  padding: '8px 10px',
  marginBottom: 12,
};

const toastStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#065f46',
  background: '#d1fae5',
  border: '1px solid #6ee7b7',
  borderRadius: 6,
  padding: '8px 10px',
  marginBottom: 12,
  fontWeight: 500,
};

const proposalStyle: React.CSSProperties = {
  border: '1px solid',
  borderRadius: 8,
  padding: '10px 12px',
  marginBottom: 10,
};

const reasonStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#64748b',
  fontStyle: 'italic',
  marginTop: 4,
  paddingLeft: 28,
};

const memberLineStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#334155',
  padding: '2px 0',
};

const inputStyle: React.CSSProperties = {
  padding: '6px 8px',
  border: '1px solid #cbd5e1',
  borderRadius: 6,
  fontSize: 13,
  outline: 'none',
  background: '#fff',
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
