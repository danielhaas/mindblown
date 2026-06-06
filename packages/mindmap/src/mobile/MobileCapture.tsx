import { useCallback, useEffect, useState } from 'react';
import * as api from '../api.js';
import type { BraindumpNode, MapSummary } from '../api.js';
import { flatten, updateAt, removeAt, countNodes } from './braindumpTree.js';
import { MobileParentPicker } from './MobileParentPicker.js';

interface Props {
  map: MapSummary;
  initialProse?: string;
  onConsumePrefill?: () => string;
}

interface Parent {
  id: string;
  label: string;
}

export function MobileCapture({ map, initialProse, onConsumePrefill }: Props) {
  const [prose, setProse] = useState('');
  const [tree, setTree] = useState<BraindumpNode[]>([]);
  const [generated, setGenerated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parent, setParent] = useState<Parent>({
    id: map.rootNodeId,
    label: `${map.name} (root)`,
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [lastCreated, setLastCreated] = useState<number | null>(null);

  useEffect(() => {
    if (initialProse && !prose && onConsumePrefill) {
      setProse(onConsumePrefill());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProse]);

  // Reset parent when map switches (defensive — MobileApp remounts on map change
  // today, but cheap to guard against future refactors).
  useEffect(() => {
    setParent({ id: map.rootNodeId, label: `${map.name} (root)` });
    setTree([]);
    setGenerated(false);
    setError(null);
  }, [map.id, map.name, map.rootNodeId]);

  const generate = useCallback(async () => {
    if (!prose.trim()) return;
    setLoading(true);
    setError(null);
    setLastCreated(null);
    try {
      const res = await api.aiBraindump(map.id, parent.id, prose);
      setTree(res.tree);
      setGenerated(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to generate tree';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [map.id, parent.id, prose]);

  const accept = useCallback(async () => {
    if (tree.length === 0) return;
    setAccepting(true);
    setError(null);
    try {
      const res = await api.aiBraindumpAccept(map.id, parent.id, tree);
      setLastCreated(res.createdCount);
      setProse('');
      setTree([]);
      setGenerated(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to create nodes';
      setError(msg);
    } finally {
      setAccepting(false);
    }
  }, [tree, map.id, parent.id]);

  const total = countNodes(tree);
  const rows = flatten(tree);

  return (
    <div className="mb-body">
      <div style={{ fontSize: 13, color: '#475569' }}>
        Under: <strong style={{ color: '#0f172a' }}>{parent.label}</strong>{' '}
        <button className="mb-link" onClick={() => setPickerOpen(true)}>
          change
        </button>
      </div>

      {lastCreated !== null && (
        <div
          style={{
            background: '#ecfdf5',
            border: '1px solid #a7f3d0',
            color: '#065f46',
            borderRadius: 8,
            padding: '10px 12px',
            fontSize: 13,
          }}
        >
          Created {lastCreated} node{lastCreated === 1 ? '' : 's'}.
        </div>
      )}

      {!generated ? (
        <>
          <textarea
            className="mb-textarea"
            value={prose}
            onChange={(e) => setProse(e.target.value)}
            placeholder="Paste raw thoughts, a spec, a Slack thread — anything. The AI will break it into a structured tree."
          />
          {error && <div className="mb-error">{error}</div>}
          <button
            className="mb-btn-primary"
            disabled={loading || !prose.trim()}
            onClick={generate}
          >
            {loading ? 'Generating…' : 'Break it down with AI'}
          </button>
        </>
      ) : (
        <>
          <div style={{ fontSize: 13, color: '#64748b' }}>
            {total} node{total === 1 ? '' : 's'} — tap to edit, × to remove.
          </div>
          {rows.map((row) => (
            <div
              key={row.path.join('.')}
              className="mb-preview-row"
              style={{ paddingLeft: row.depth * 14 }}
            >
              <button
                className="mb-remove"
                onClick={() => setTree((prev) => removeAt(prev, row.path))}
                aria-label="Remove"
              >
                ×
              </button>
              <input
                type="text"
                value={row.node.text}
                onChange={(e) =>
                  setTree((prev) =>
                    updateAt(prev, row.path, (n) => ({ ...n, text: e.target.value })),
                  )
                }
              />
              <input
                type="number"
                value={row.node.estimate ?? ''}
                placeholder="est"
                min={0}
                step={0.5}
                disabled={row.node.children.length > 0}
                onChange={(e) => {
                  const raw = e.target.value;
                  setTree((prev) =>
                    updateAt(prev, row.path, (n) => ({
                      ...n,
                      estimate: raw === '' ? null : parseFloat(raw),
                    })),
                  );
                }}
              />
            </div>
          ))}
          {error && <div className="mb-error">{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="mb-btn-secondary"
              style={{ flex: 1 }}
              onClick={() => {
                setTree([]);
                setGenerated(false);
              }}
            >
              Regenerate
            </button>
            <button
              className="mb-btn-primary"
              style={{ flex: 1 }}
              disabled={accepting || total === 0}
              onClick={accept}
            >
              {accepting ? 'Saving…' : `Save ${total}`}
            </button>
          </div>
        </>
      )}

      {pickerOpen && (
        <MobileParentPicker
          mapId={map.id}
          rootLabel={`${map.name} (root)`}
          onClose={() => setPickerOpen(false)}
          onPick={(id, label) => {
            setParent({ id, label });
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}
