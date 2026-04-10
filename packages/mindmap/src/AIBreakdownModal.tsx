import { useState, useCallback } from 'react';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { BreakdownSuggestion } from './api.js';

interface Props {
  mapId: string;
  nodeId: string;
  nodeText: string;
  onClose: () => void;
}

export function AIBreakdownModal({ mapId, nodeId, nodeText, onClose }: Props) {
  const [suggestions, setSuggestions] = useState<BreakdownSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState('');
  const [count, setCount] = useState(5);
  const [generated, setGenerated] = useState(false);

  const loadMap = useMindmapStore((s) => s.loadMap);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.aiBreakdown(mapId, nodeId, count, hint || undefined);
      setSuggestions(res.suggestions);
      setGenerated(true);
    } catch (err: any) {
      setError(err.message || 'Failed to generate suggestions');
    } finally {
      setLoading(false);
    }
  }, [mapId, nodeId, count, hint]);

  const accept = useCallback(async () => {
    const selected = suggestions.filter((_, i) => !removed.has(i));
    if (selected.length === 0) return;

    setAccepting(true);
    setError(null);
    try {
      await api.aiBreakdownAccept(mapId, nodeId, selected);
      // Reload the map to pick up new nodes from the server
      await loadMap(mapId);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to create nodes');
      setAccepting(false);
    }
  }, [suggestions, mapId, nodeId, loadMap, onClose]);

  // Track which suggestions have been removed from the preview
  const [removed, setRemoved] = useState<Set<number>>(new Set());

  const toggleRemove = (idx: number) => {
    setRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const updateSuggestion = (idx: number, field: 'text' | 'estimate', value: string) => {
    setSuggestions((prev) =>
      prev.map((s, i) =>
        i === idx
          ? {
              ...s,
              [field]: field === 'estimate' ? (value === '' ? null : parseFloat(value)) : value,
            }
          : s,
      ),
    );
  };

  const activeCount = suggestions.length - removed.size;

  return (
    <>
      {/* Backdrop */}
      <div style={backdropStyle} onClick={onClose} />

      {/* Modal */}
      <div style={modalStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, color: '#0f172a' }}>
              AI Breakdown
            </div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
              {nodeText}
            </div>
          </div>
          <button onClick={onClose} style={closeBtnStyle}>&times;</button>
        </div>

        {/* Body */}
        <div style={bodyStyle}>
          {!generated ? (
            <>
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>Number of subtasks</label>
                <input
                  type="number"
                  min={2}
                  max={15}
                  value={count}
                  onChange={(e) => setCount(parseInt(e.target.value) || 5)}
                  style={inputStyle}
                />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>Additional context (optional)</label>
                <input
                  type="text"
                  value={hint}
                  onChange={(e) => setHint(e.target.value)}
                  placeholder="e.g. Focus on backend tasks, use TypeScript..."
                  style={{ ...inputStyle, width: '100%' }}
                />
              </div>
            </>
          ) : (
            <div>
              {suggestions.map((s, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 0',
                    opacity: removed.has(i) ? 0.4 : 1,
                    borderBottom: '1px solid #f1f5f9',
                  }}
                >
                  <button
                    onClick={() => toggleRemove(i)}
                    style={{
                      ...smallBtnStyle,
                      color: removed.has(i) ? '#16a34a' : '#dc2626',
                      fontSize: 16,
                      width: 24,
                      flexShrink: 0,
                    }}
                    title={removed.has(i) ? 'Restore' : 'Remove'}
                  >
                    {removed.has(i) ? '+' : '\u00d7'}
                  </button>
                  <input
                    type="text"
                    value={s.text}
                    onChange={(e) => updateSuggestion(i, 'text', e.target.value)}
                    disabled={removed.has(i)}
                    style={{ ...inputStyle, flex: 1, fontSize: 13 }}
                  />
                  <input
                    type="number"
                    value={s.estimate ?? ''}
                    onChange={(e) => updateSuggestion(i, 'estimate', e.target.value)}
                    disabled={removed.has(i)}
                    placeholder="est"
                    style={{ ...inputStyle, width: 56, textAlign: 'right', fontSize: 13 }}
                    min={0}
                    step={0.5}
                  />
                </div>
              ))}
            </div>
          )}

          {error && (
            <div style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>{error}</div>
          )}
        </div>

        {/* Footer */}
        <div style={footerStyle}>
          {generated && (
            <button onClick={() => { setGenerated(false); setSuggestions([]); setRemoved(new Set()); }} style={secondaryBtnStyle}>
              Regenerate
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={secondaryBtnStyle}>Cancel</button>
          {!generated ? (
            <button onClick={generate} disabled={loading} style={primaryBtnStyle}>
              {loading ? 'Generating...' : 'Generate'}
            </button>
          ) : (
            <button
              onClick={accept}
              disabled={accepting || activeCount === 0}
              style={primaryBtnStyle}
            >
              {accepting ? 'Creating...' : `Accept ${activeCount} task${activeCount !== 1 ? 's' : ''}`}
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
  width: 520,
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

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 500,
  color: '#475569',
  marginBottom: 4,
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

const smallBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  lineHeight: 1,
};
