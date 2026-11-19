/**
 * "N merged changes not deployed" on the Fleet tab — the fleet merges
 * trusted PRs, nothing deploys them, and on 18.–19.11.2026 four sat for
 * up to 19 h unseen. The drift comes from the map's deploy probe (Map
 * settings → Deploy probe), or for MindBlown's own map from the server's
 * checkout; a map with neither renders nothing. A probe that fails says so.
 */
import { useEffect, useState } from 'react';
import * as api from './api.js';

const POLL_MS = 5 * 60_000;

export function waitedLabel(since: string, now: Date): string {
  const h = Math.floor((now.getTime() - Date.parse(since)) / 3_600_000);
  if (!Number.isFinite(h) || h < 1) return 'under an hour';
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} days`;
}

export function DeployDriftBanner({ mapId }: { mapId: string }) {
  const [drift, setDrift] = useState<api.DeployDrift | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [poll, setPoll] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setPoll((n) => n + 1), POLL_MS);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    let cancelled = false;
    api
      .fetchDeployDrift(mapId)
      .then((r) => {
        if (cancelled) return;
        setDrift(r.drift);
        setProbeError(r.probeError);
      })
      .catch(() => {
        if (cancelled) return;
        setDrift(null);
        setProbeError(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mapId, poll]);

  if (probeError) {
    return (
      <div data-testid="deploy-probe-error" style={{ margin: '0 0 16px', fontSize: 12, color: '#92400e' }}>
        Deploy probe failed — what is live is unknown: {probeError}
      </div>
    );
  }
  if (!drift || drift.undeployed === 0 || !drift.undeployedSince) return null;
  const n = drift.undeployed;
  return (
    <div
      data-testid="deploy-drift"
      style={{
        margin: '0 0 16px',
        padding: '10px 14px',
        background: '#fffbeb',
        border: '1px solid #fde68a',
        borderRadius: 8,
        fontSize: 13,
        color: '#92400e',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ all: 'unset', cursor: 'pointer', fontWeight: 600 }}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} {n} merged {n === 1 ? 'change' : 'changes'} not deployed — oldest waiting{' '}
        {waitedLabel(drift.undeployedSince, new Date())}
      </button>
      <span style={{ marginLeft: 8, color: '#b45309', fontWeight: 400 }}>prod runs {drift.sha.slice(0, 8)}</span>
      {open && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 20, color: '#78350f' }}>
          {drift.commits.map((c) => (
            <li key={c.sha} style={{ margin: '2px 0' }}>
              {c.subject}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
