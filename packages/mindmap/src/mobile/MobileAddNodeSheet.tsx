import { useEffect, useMemo, useRef, useState } from 'react';
import type { MindMap } from '@mindblown/core';
import * as api from '../api.js';
import type { NodeWithComputed } from '../api.js';

interface Props {
  nodes: NodeWithComputed[];
  map: MindMap;
  onClose: () => void;
  /** Called after each successful create so the owner can re-fetch. */
  onCreated: () => void;
}

interface ParentOption {
  id: string;
  label: string;
}

/** Depth-first walk producing an indented picker list of all nodes. */
function parentOptions(nodes: NodeWithComputed[], rootId: string, rootText: string): ParentOption[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: ParentOption[] = [{ id: rootId, label: rootText }];
  const walk = (id: string, depth: number) => {
    const n = byId.get(id);
    if (!n) return;
    if (id !== rootId) {
      out.push({ id, label: `${'  '.repeat(depth)}${n.text}` });
    }
    for (const cid of n.childrenIds) walk(cid, depth + 1);
  };
  const root = byId.get(rootId);
  for (const cid of root?.childrenIds ?? []) walk(cid, 1);
  return out;
}

export function MobileAddNodeSheet({ nodes, map, onClose, onCreated }: Props) {
  const root = nodes.find((n) => n.id === map.rootNodeId);
  const options = useMemo(
    () => parentOptions(nodes, map.rootNodeId, root?.text ?? map.name),
    [nodes, map.rootNodeId, root?.text, map.name],
  );

  const [parentId, setParentId] = useState(map.rootNodeId);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedCount, setAddedCount] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const add = async () => {
    const t = text.trim();
    if (!t || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.createNode(map.id, parentId, t);
      onCreated();
      setText('');
      setAddedCount((c) => c + 1);
      inputRef.current?.focus();
    } catch (e) {
      setError((e as Error).message ?? 'Failed to add node');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="mb-sheet-backdrop" onClick={onClose} />
      <div className="mb-sheet" role="dialog" aria-modal="true">
        <div className="mb-sheet-header">
          <span style={{ flex: 1 }}>Add node</span>
          <button className="mb-link" onClick={onClose}>
            Done
          </button>
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {error && <div className="mb-error">{error}</div>}

          <div>
            <div className="mb-detail-label">Under</div>
            <select
              className="mb-select"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
            >
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <input
            ref={inputRef}
            type="text"
            className="mb-input"
            placeholder="What needs doing?"
            value={text}
            enterKeyHint="done"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add();
            }}
          />

          <button
            className="mb-btn-primary"
            disabled={saving || !text.trim()}
            onClick={() => void add()}
          >
            {saving ? 'Adding…' : 'Add'}
          </button>

          {addedCount > 0 && (
            <div style={{ color: '#059669', fontSize: 13, textAlign: 'center' }}>
              {addedCount} node{addedCount === 1 ? '' : 's'} added
            </div>
          )}
        </div>
      </div>
    </>
  );
}
