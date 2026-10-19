/**
 * The map's fleet on the phone (#480): which fleet works this map, its cap
 * against the claims held across all its maps, each map's share, and the
 * workers serving this map — agent badge, state, claim with its project
 * when it is another one. Read-only; the full view is the fleet page.
 *
 * Reads the map route (the fleet narrowed to this map), so a host that
 * also works for other projects shows here with those claims labelled —
 * or, on a project the reader can't view, as "busy elsewhere".
 */
import { useEffect, useState } from 'react';
import type { FleetWithMaps } from '@mindblown/core';
import { effectiveWorkerState, estimateServerNow } from '@mindblown/core';
import * as api from '../api.js';
import type { FleetResponse } from '../api.js';
import { projectLabel } from '../fleetScope.js';
import type { FleetScope } from '../fleetScope.js';

export function MobileFleetSection({ mapId, fleetId }: { mapId: string; fleetId: string }) {
  const [fleet, setFleet] = useState<FleetWithMaps | null>(null);
  const [telemetry, setTelemetry] = useState<{ data: FleetResponse; fetchedAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.fetchFleetEntity(fleetId), api.fetchFleet({ mapId })])
      .then(([f, t]) => {
        if (cancelled) return;
        setFleet(f);
        setTelemetry({ data: t, fetchedAt: Date.now() });
        setError(null);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : 'unavailable'));
    return () => {
      cancelled = true;
    };
  }, [mapId, fleetId]);

  if (error) return <div className="mb-card" style={{ fontSize: 12, color: '#b45309' }}>Fleet unavailable ({error}).</div>;
  if (!fleet || !telemetry) return <div className="mb-card" style={{ fontSize: 12, color: '#94a3b8' }}>Loading the fleet…</div>;

  const scope: FleetScope = { mapId, fleetId, all: false, mapNames: new Map(fleet.maps.map((m) => [m.id, m.name])) };
  const now = estimateServerNow(telemetry.data.now, telemetry.fetchedAt, Date.now());
  const workers = telemetry.data.hosts.flatMap((h) => h.rollup.workers.map((w) => ({ host: h.host, w })));
  const cap = fleet.maxActiveClaims;

  return (
    <div className="mb-card" data-testid="mobile-fleet">
      <div className="mb-card-title">{fleet.name}</div>
      <div style={{ fontSize: 14, color: '#334155', marginTop: 4 }}>
        <strong>{fleet.activeClaims ?? '?'}</strong> active {cap > 0 ? <>/ fleet cap <strong>{cap}</strong></> : <span style={{ color: '#64748b' }}>· no fleet-wide cap</span>}
      </div>
      {(fleet.maps.length > 1 || fleet.hiddenMapCount > 0) && (
        <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
          Shares: {fleet.maps.map((m) => `${m.name} ${m.fleetShare}`).join(' · ')}
          {fleet.hiddenMapCount > 0 && ` · +${fleet.hiddenMapCount} you can't view`}
        </div>
      )}
      <ul style={{ margin: '10px 0 0', paddingLeft: 0, listStyle: 'none', fontSize: 13, lineHeight: 1.7 }}>
        {workers.length === 0 && <li style={{ color: '#94a3b8' }}>No worker reports for this map.</li>}
        {workers.map(({ host, w }) => {
          const project = projectLabel(scope, w.claim?.mapId);
          return (
            <li key={`${host}/${w.session}`}>
              <span>{w.worker ?? w.session}@{host}</span>
              {w.agent && <span style={badge} data-testid="agent-badge">{w.agent}</span>} <span style={{ color: '#64748b' }}>{effectiveWorkerState(w, now)}</span>
              {w.claim?.redacted && <span style={{ color: '#94a3b8' }}> — busy elsewhere</span>}
              {w.claim?.title && (
                <span>
                  {' '}— {project && <span style={tag}>{project}</span>}
                  {w.claim.title}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <a href={`/?fleet=${encodeURIComponent(fleetId)}`} style={{ display: 'inline-block', marginTop: 10, fontSize: 13, color: '#4f46e5' }}>
        Fleet page →
      </a>
    </div>
  );
}

const badge: React.CSSProperties = { display: 'inline-block', marginLeft: 6, padding: '0 6px', borderRadius: 999, background: '#eef2ff', color: '#3730a3', fontSize: 11 };
const tag: React.CSSProperties = { display: 'inline-block', padding: '0 6px', marginRight: 4, borderRadius: 4, background: '#f1f5f9', color: '#475569', fontSize: 11, fontWeight: 600 };
