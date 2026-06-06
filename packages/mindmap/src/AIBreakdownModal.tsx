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

type Path = string; // dot-separated index path, e.g. "0", "1.0", "1.2"

function pathOf(parent: Path, idx: number): Path {
  return parent === '' ? String(idx) : `${parent}.${idx}`;
}

/** Walk a tree by index path and apply a transform; returns a new tree. */
function updateAtPath(
  tree: BreakdownSuggestion[],
  target: Path,
  fn: (node: BreakdownSuggestion) => BreakdownSuggestion,
  cursor: Path = '',
): BreakdownSuggestion[] {
  return tree.map((node, i) => {
    const here = pathOf(cursor, i);
    if (here === target) return fn(node);
    if (target.startsWith(here + '.')) {
      return { ...node, children: updateAtPath(node.children ?? [], target, fn, here) };
    }
    return node;
  });
}

/** Total leaf count after applying the `removed` mask. */
function countLeaves(
  tree: BreakdownSuggestion[],
  removed: Set<Path>,
  cursor: Path = '',
): number {
  let n = 0;
  for (let i = 0; i < tree.length; i++) {
    const here = pathOf(cursor, i);
    if (removed.has(here)) continue;
    const node = tree[i];
    if (node.children && node.children.length > 0) {
      n += countLeaves(node.children, removed, here);
    } else {
      n += 1;
    }
  }
  return n;
}

/** Strip removed nodes and drop empty categories before sending to the server. */
function pruneRemoved(
  tree: BreakdownSuggestion[],
  removed: Set<Path>,
  cursor: Path = '',
): BreakdownSuggestion[] {
  const out: BreakdownSuggestion[] = [];
  for (let i = 0; i < tree.length; i++) {
    const here = pathOf(cursor, i);
    if (removed.has(here)) continue;
    const node = tree[i];
    if (node.children && node.children.length > 0) {
      const kept = pruneRemoved(node.children, removed, here);
      if (kept.length === 0) continue; // drop empty category
      out.push({ ...node, children: kept });
    } else {
      out.push(node);
    }
  }
  return out;
}

export function AIBreakdownModal({ mapId, nodeId, nodeText, onClose }: Props) {
  const [suggestions, setSuggestions] = useState<BreakdownSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState('');
  const [count, setCount] = useState(5);
  const [generated, setGenerated] = useState(false);
  const [removed, setRemoved] = useState<Set<Path>>(new Set());

  const loadMap = useMindmapStore((s) => s.loadMap);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRemoved(new Set());
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
    const selected = pruneRemoved(suggestions, removed);
    if (selected.length === 0) return;

    setAccepting(true);
    setError(null);
    try {
      await api.aiBreakdownAccept(mapId, nodeId, selected);
      await loadMap(mapId);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to create nodes');
      setAccepting(false);
    }
  }, [suggestions, removed, mapId, nodeId, loadMap, onClose]);

  const toggleRemove = (path: Path) => {
    setRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const updateField = (
    path: Path,
    field: 'text' | 'estimate',
    value: string,
  ) => {
    setSuggestions((prev) =>
      updateAtPath(prev, path, (node) => ({
        ...node,
        [field]: field === 'estimate' ? (value === '' ? null : parseFloat(value)) : value,
      })),
    );
  };

  const activeCount = countLeaves(suggestions, removed);

  // Recursively render. Categories (children.length > 0) get a slightly
  // different row: bolder text, no estimate input, and a small badge.
  const renderRow = (node: BreakdownSuggestion, path: Path, depth: number) => {
    const isRemoved = removed.has(path);
    const isCategory = !!node.children && node.children.length > 0;
    return (
      <div key={path}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 0',
            paddingLeft: depth * 20,
            opacity: isRemoved ? 0.4 : 1,
            borderBottom: '1px solid #f1f5f9',
          }}
        >
          <button
            onClick={() => toggleRemove(path)}
            style={{
              ...smallBtnStyle,
              color: isRemoved ? '#16a34a' : '#dc2626',
              fontSize: 16,
              width: 24,
              flexShrink: 0,
            }}
            title={isRemoved ? 'Restore' : 'Remove'}
          >
            {isRemoved ? '+' : '×'}
          </button>
          <input
            type="text"
            value={node.text}
            onChange={(e) => updateField(path, 'text', e.target.value)}
            disabled={isRemoved}
            style={{
              ...inputStyle,
              flex: 1,
              fontSize: 13,
              fontWeight: isCategory ? 600 : 400,
              color: isCategory ? '#0f172a' : '#334155',
            }}
          />
          {isCategory ? (
            <span style={badgeStyle}>group</span>
          ) : (
            <input
              type="number"
              value={node.estimate ?? ''}
              onChange={(e) => updateField(path, 'estimate', e.target.value)}
              disabled={isRemoved}
              placeholder="est"
              style={{ ...inputStyle, width: 56, textAlign: 'right', fontSize: 13 }}
              min={0}
              step={0.5}
            />
          )}
        </div>
        {isCategory &&
          !isRemoved &&
          node.children!.map((c, i) => renderRow(c, pathOf(path, i), depth + 1))}
      </div>
    );
  };

  return (
    <>
      <div style={backdropStyle} onClick={onClose} />
      <div style={modalStyle}>
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

        <div style={bodyStyle}>
          {!generated ? (
            <>
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>Number of subtasks (max)</label>
                <input
                  type="number"
                  min={2}
                  max={15}
                  value={count}
                  onChange={(e) => setCount(parseInt(e.target.value) || 5)}
                  style={inputStyle}
                />
                <div style={hintStyle}>
                  More than 6 → the AI will group them under category nodes.
                </div>
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
              {suggestions.map((s, i) => renderRow(s, String(i), 0))}
            </div>
          )}

          {error && (
            <div style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>{error}</div>
          )}
        </div>

        <div style={footerStyle}>
          {generated && (
            <button
              onClick={() => {
                setGenerated(false);
                setSuggestions([]);
                setRemoved(new Set());
              }}
              style={secondaryBtnStyle}
            >
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
  width: 560,
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

const hintStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#94a3b8',
  marginTop: 4,
};

const inputStyle: React.CSSProperties = {
  padding: '6px 8px',
  border: '1px solid #cbd5e1',
  borderRadius: 6,
  fontSize: 13,
  outline: 'none',
  background: '#fff',
};

const badgeStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: '#6366f1',
  background: '#eef2ff',
  border: '1px solid #c7d2fe',
  padding: '2px 6px',
  borderRadius: 4,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  width: 56,
  textAlign: 'center',
  boxSizing: 'border-box',
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
