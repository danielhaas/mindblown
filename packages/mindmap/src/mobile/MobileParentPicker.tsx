import { useEffect, useState } from 'react';
import * as api from '../api.js';
import type { NodeWithComputed } from '../api.js';

interface Props {
  mapId: string;
  rootLabel: string;
  onClose: () => void;
  onPick: (nodeId: string, label: string) => void;
}

interface FlatRow {
  id: string;
  depth: number;
  text: string;
}

function flattenTree(nodes: NodeWithComputed[], rootId: string): FlatRow[] {
  const byId = new Map<string, NodeWithComputed>(nodes.map((n) => [n.id, n]));
  const rows: FlatRow[] = [];
  const walk = (id: string, depth: number) => {
    const n = byId.get(id);
    if (!n) return;
    rows.push({ id: n.id, depth, text: n.text });
    for (const cid of n.childrenIds) walk(cid, depth + 1);
  };
  walk(rootId, 0);
  return rows;
}

export function MobileParentPicker({ mapId, rootLabel, onClose, onPick }: Props) {
  const [rows, setRows] = useState<FlatRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchMap(mapId)
      .then((detail) => {
        if (cancelled) return;
        setRows(flattenTree(detail.nodes, detail.map.rootNodeId));
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message ?? 'Failed to load map');
      });
    return () => {
      cancelled = true;
    };
  }, [mapId]);

  return (
    <>
      <div className="mb-sheet-backdrop" onClick={onClose} />
      <div className="mb-sheet" role="dialog" aria-modal="true">
        <div className="mb-sheet-header">
          <span>Pick a parent</span>
          <button className="mb-link" onClick={onClose}>
            Cancel
          </button>
        </div>
        <div className="mb-sheet-body">
          {error && <div className="mb-error" style={{ margin: 12 }}>{error}</div>}
          {rows === null && !error && (
            <div style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>
              Loading…
            </div>
          )}
          {rows?.map((row, i) => (
            <button
              key={row.id}
              className="mb-sheet-row"
              style={{ paddingLeft: 16 + row.depth * 14 }}
              onClick={() => {
                const label = i === 0 ? rootLabel : row.text;
                onPick(row.id, label);
              }}
            >
              {row.depth > 0 && (
                <span style={{ color: '#cbd5e1', marginRight: 6 }}>↳</span>
              )}
              {i === 0 ? rootLabel : row.text}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
