import { useState, useCallback } from 'react';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { BraindumpNode } from './api.js';

interface Props {
  mapId: string;
  parentId: string;
  parentText: string;
  onClose: () => void;
}

type FlatRow = {
  path: number[]; // indices from the root of `tree` down to this node
  depth: number;
  node: BraindumpNode;
};

function flatten(tree: BraindumpNode[], parentPath: number[] = []): FlatRow[] {
  const rows: FlatRow[] = [];
  tree.forEach((node, i) => {
    const path = [...parentPath, i];
    rows.push({ path, depth: parentPath.length, node });
    if (node.children.length > 0) rows.push(...flatten(node.children, path));
  });
  return rows;
}

/** Immutably update a node at `path` within `tree` using `updater`. */
function updateAt(
  tree: BraindumpNode[],
  path: number[],
  updater: (n: BraindumpNode) => BraindumpNode,
): BraindumpNode[] {
  return tree.map((n, i) => {
    if (i !== path[0]) return n;
    if (path.length === 1) return updater(n);
    return { ...n, children: updateAt(n.children, path.slice(1), updater) };
  });
}

/** Remove the node at `path` from `tree`. */
function removeAt(tree: BraindumpNode[], path: number[]): BraindumpNode[] {
  if (path.length === 1) return tree.filter((_, i) => i !== path[0]);
  return tree.map((n, i) =>
    i === path[0] ? { ...n, children: removeAt(n.children, path.slice(1)) } : n,
  );
}

function countNodes(tree: BraindumpNode[]): number {
  return tree.reduce((acc, n) => acc + 1 + countNodes(n.children), 0);
}

export function AIBraindumpModal({ mapId, parentId, parentText, onClose }: Props) {
  const [prose, setProse] = useState('');
  const [tree, setTree] = useState<BraindumpNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState(false);

  const loadMap = useMindmapStore((s) => s.loadMap);

  const generate = useCallback(async () => {
    if (!prose.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.aiBraindump(mapId, parentId, prose);
      setTree(res.tree);
      setGenerated(true);
    } catch (err: any) {
      setError(err.message || 'Failed to generate tree');
    } finally {
      setLoading(false);
    }
  }, [mapId, parentId, prose]);

  const accept = useCallback(async () => {
    if (tree.length === 0) return;
    setAccepting(true);
    setError(null);
    try {
      await api.aiBraindumpAccept(mapId, parentId, tree);
      await loadMap(mapId);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to create nodes');
      setAccepting(false);
    }
  }, [tree, mapId, parentId, loadMap, onClose]);

  const updateText = (path: number[], text: string) => {
    setTree((prev) => updateAt(prev, path, (n) => ({ ...n, text })));
  };
  const updateEstimate = (path: number[], raw: string) => {
    setTree((prev) =>
      updateAt(prev, path, (n) => ({
        ...n,
        estimate: raw === '' ? null : parseFloat(raw),
      })),
    );
  };
  const remove = (path: number[]) => {
    setTree((prev) => removeAt(prev, path));
  };

  const rows = flatten(tree);
  const total = countNodes(tree);

  return (
    <>
      <div style={backdropStyle} onClick={onClose} />
      <div style={modalStyle}>
        <div style={headerStyle}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, color: '#0f172a' }}>
              Brain Dump → Tree
            </div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
              Under: {parentText}
            </div>
          </div>
          <button onClick={onClose} style={closeBtnStyle}>&times;</button>
        </div>

        <div style={bodyStyle}>
          {!generated ? (
            <>
              <div style={{ marginBottom: 8, fontSize: 12, color: '#475569' }}>
                Paste raw thoughts, a spec, a Slack thread — anything. The model
                will convert it into a structured tree of tasks.
              </div>
              <textarea
                value={prose}
                onChange={(e) => setProse(e.target.value)}
                placeholder="e.g. need to add SSO, probably Google first then GitHub. Also the onboarding is broken for new workspaces, users can't invite teammates until they set up billing..."
                style={textareaStyle}
                autoFocus
              />
            </>
          ) : (
            <div>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
                {total} node{total === 1 ? '' : 's'} — review, edit, and accept.
              </div>
              {rows.map((row) => (
                <div
                  key={row.path.join('.')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 0',
                    borderBottom: '1px solid #f1f5f9',
                  }}
                >
                  <div style={{ width: row.depth * 16, flexShrink: 0 }} />
                  <button
                    onClick={() => remove(row.path)}
                    style={{ ...smallBtnStyle, color: '#dc2626', fontSize: 16, width: 24, flexShrink: 0 }}
                    title="Remove"
                  >
                    &times;
                  </button>
                  <input
                    type="text"
                    value={row.node.text}
                    onChange={(e) => updateText(row.path, e.target.value)}
                    style={{ ...inputStyle, flex: 1, fontSize: 13 }}
                  />
                  <input
                    type="number"
                    value={row.node.estimate ?? ''}
                    onChange={(e) => updateEstimate(row.path, e.target.value)}
                    placeholder="est"
                    style={{ ...inputStyle, width: 56, textAlign: 'right', fontSize: 13 }}
                    min={0}
                    step={0.5}
                    disabled={row.node.children.length > 0}
                    title={row.node.children.length > 0 ? 'Parents auto-compute from children' : ''}
                  />
                </div>
              ))}
            </div>
          )}

          {error && <div style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>{error}</div>}
        </div>

        <div style={footerStyle}>
          {generated && (
            <button
              onClick={() => {
                setGenerated(false);
                setTree([]);
              }}
              style={secondaryBtnStyle}
            >
              Regenerate
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={secondaryBtnStyle}>Cancel</button>
          {!generated ? (
            <button
              onClick={generate}
              disabled={loading || !prose.trim()}
              style={primaryBtnStyle}
            >
              {loading ? 'Generating…' : 'Generate'}
            </button>
          ) : (
            <button
              onClick={accept}
              disabled={accepting || total === 0}
              style={primaryBtnStyle}
            >
              {accepting ? 'Creating…' : `Create ${total} node${total === 1 ? '' : 's'}`}
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
  width: 640,
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

const textareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 220,
  padding: '8px 10px',
  border: '1px solid #cbd5e1',
  borderRadius: 6,
  fontSize: 13,
  fontFamily: 'inherit',
  resize: 'vertical',
  outline: 'none',
  background: '#fff',
  boxSizing: 'border-box',
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
