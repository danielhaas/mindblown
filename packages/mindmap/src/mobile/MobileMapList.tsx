import { useEffect, useState } from 'react';
import * as api from '../api.js';
import type { MapSummary } from '../api.js';

interface Props {
  onPick: (m: MapSummary) => void;
}

function healthClass(h: string | null | undefined): string {
  switch (h) {
    case 'on_track':
      return 'mb-health-on_track';
    case 'at_risk':
      return 'mb-health-at_risk';
    case 'behind':
      return 'mb-health-behind';
    default:
      return 'mb-health-unknown';
  }
}

export function MobileMapList({ onPick }: Props) {
  const [maps, setMaps] = useState<MapSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchMaps()
      .then((m) => {
        if (!cancelled) setMaps(m);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message ?? 'Failed to load maps');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="mb-body">
        <div className="mb-error">{error}</div>
      </div>
    );
  }

  if (maps === null) {
    return (
      <div className="mb-body">
        <div style={{ color: '#64748b', textAlign: 'center', padding: 24 }}>
          Loading maps…
        </div>
      </div>
    );
  }

  if (maps.length === 0) {
    return (
      <div className="mb-body">
        <div style={{ color: '#64748b', textAlign: 'center', padding: 24 }}>
          No maps yet. Create one from the desktop app to view it here.
        </div>
      </div>
    );
  }

  return (
    <div className="mb-body">
      <div style={{ fontSize: 12, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.04 }}>
        Pick a map to view
      </div>
      {maps.map((m) => {
        const pct = Math.round(m.computedProgress ?? 0);
        return (
          <button key={m.id} className="mb-card" onClick={() => onPick(m)}>
            <div className="mb-card-title">
              <span className={`mb-health-dot ${healthClass(m.healthSignal)}`} />
              {m.name}
            </div>
            <div className="mb-card-meta">
              {pct}% complete · {m.healthSignal?.replace('_', ' ') ?? 'unknown'}
            </div>
          </button>
        );
      })}
    </div>
  );
}
