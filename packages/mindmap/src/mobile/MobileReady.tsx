import { useEffect, useState } from 'react';
import * as api from '../api.js';
import type { MapSummary, ReadyNode } from '../api.js';

interface Props {
  map: MapSummary;
}

function priorityColor(p: string | null): string {
  switch (p) {
    case 'critical':
      return '#dc2626';
    case 'high':
      return '#f97316';
    case 'medium':
      return '#0ea5e9';
    case 'low':
      return '#94a3b8';
    default:
      return '#94a3b8';
  }
}

export function MobileReady({ map }: Props) {
  const [nodes, setNodes] = useState<ReadyNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setNodes(null);
    setError(null);
    api
      .fetchReadyNodes(map.id, { limit: 20 })
      .then((res) => {
        if (!cancelled) setNodes(res.ready);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message ?? 'Failed to load ready nodes');
      });
    return () => {
      cancelled = true;
    };
  }, [map.id]);

  return (
    <div className="mb-body">
      <div style={{ fontSize: 12, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.04 }}>
        What's unblocked and ready
      </div>
      {error && <div className="mb-error">{error}</div>}
      {!error && nodes === null && (
        <div style={{ color: '#64748b', textAlign: 'center', padding: 24 }}>Loading…</div>
      )}
      {nodes?.length === 0 && (
        <div style={{ color: '#64748b', textAlign: 'center', padding: 24 }}>
          Nothing ready right now. Everything is either done, blocked, or claimed.
        </div>
      )}
      {nodes?.map((n) => (
        <div key={n.id} className="mb-card">
          <div className="mb-card-title">
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: 4,
                background: priorityColor(n.priority),
                marginRight: 8,
              }}
            />
            {n.text}
          </div>
          {(n.scopes.length > 0 || n.priority) && (
            <div className="mb-card-meta">
              {n.priority && <span style={{ marginRight: 8 }}>{n.priority}</span>}
              {n.scopes.map((s) => (
                <span
                  key={s}
                  style={{
                    background: '#f1f5f9',
                    color: '#475569',
                    padding: '2px 6px',
                    borderRadius: 4,
                    marginRight: 4,
                    fontSize: 11,
                  }}
                >
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
