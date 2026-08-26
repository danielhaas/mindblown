/**
 * Stakeholder digest — the one screen persona "Thomas" asked for
 * (Round 1, 2026-08-26): "V1.5 — target — forecast (moved since last week?)
 * — on track yes/no and why — finished this fortnight — scope growth".
 * Read-only; every line that names a node selects it.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { ReleaseForecastResponse } from './api.js';
import { statusCategory } from './viewScope.js';
import {
  nextRelease,
  releaseVerdict,
  weeklyDelta,
  threats,
  recentlyDone,
  scopeGrowth,
  breadcrumb,
} from './landing.js';
import type { ChangeEventLite } from './landing.js';

const LEVEL_STYLE = {
  on_track: { label: 'On track', bg: '#ecfdf5', fg: '#047857', border: '#a7f3d0' },
  at_risk: { label: 'At risk', bg: '#fffbeb', fg: '#b45309', border: '#fde68a' },
  behind: { label: 'Behind', bg: '#fef2f2', fg: '#b91c1c', border: '#fecaca' },
  unknown: { label: 'No forecast', bg: '#f8fafc', fg: '#475569', border: '#e2e8f0' },
} as const;

const WINDOW_DAYS = 14;

export function DigestView() {
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const currentMap = useMindmapStore((s) => s.currentMap);
  const nodes = useMindmapStore((s) => s.nodes);
  const computed = useMindmapStore((s) => s.computed);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const setActiveView = useMindmapStore((s) => s.setActiveView);

  const [forecast, setForecast] = useState<ReleaseForecastResponse | null>(null);
  const [events, setEvents] = useState<ChangeEventLite[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentMapId) return;
    let cancelled = false;
    setError(null);
    Promise.all([
      api.fetchReleaseForecast(currentMapId),
      api.fetchChangeHistory(currentMapId, { sinceDays: WINDOW_DAYS, limit: 1000 }),
    ])
      .then(([f, ev]) => {
        if (cancelled) return;
        setForecast(f);
        setEvents(ev.events);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Failed to load'));
    return () => {
      cancelled = true;
    };
  }, [currentMapId]);

  const categoryOf = useMemo(() => {
    const wf = currentMap?.statusWorkflow ?? [];
    return (n: Parameters<typeof statusCategory>[0]) => statusCategory(n, wf);
  }, [currentMap?.statusWorkflow]);

  const release = useMemo(() => (forecast ? nextRelease(forecast.releases) : null), [forecast]);
  const verdict = useMemo(() => (release ? releaseVerdict(release) : null), [release]);
  const delta = release ? weeklyDelta(release) : null;
  const risks = useMemo(
    () => threats(nodes, computed, categoryOf, release?.versionId ?? null),
    [nodes, computed, categoryOf, release?.versionId],
  );
  const done = useMemo(() => recentlyDone(nodes, categoryOf, WINDOW_DAYS), [nodes, categoryOf]);
  const growth = useMemo(() => scopeGrowth(events, release?.versionId ?? null), [events, release?.versionId]);

  const openNode = (id: string) => {
    selectNode(id);
  };

  if (error) {
    return <Shell><p style={{ color: '#b91c1c' }}>{error}</p></Shell>;
  }
  if (!forecast) {
    return <Shell><p style={{ color: '#64748b' }}>Loading…</p></Shell>;
  }

  const lv = LEVEL_STYLE[verdict?.level ?? 'unknown'];

  return (
    <Shell>
      {/* Headline card */}
      <section
        style={{
          background: lv.bg,
          border: `1px solid ${lv.border}`,
          borderRadius: 10,
          padding: '18px 22px',
          marginBottom: 18,
        }}
      >
        {release ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 22, fontWeight: 700, color: '#0f172a' }}>{release.versionName}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: lv.fg, textTransform: 'uppercase', letterSpacing: 0.5 }}>{lv.label}</span>
            </div>
            <div style={{ fontSize: 14, color: '#1e293b', marginTop: 6 }}>{verdict?.headline}</div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
              {release.targetDate ? `Target ${release.targetDate}` : 'No target date'}
              {' · '}
              {release.velocityAdjustedFinishDate ?? release.plannedFinishDate
                ? `Forecast ${release.velocityAdjustedFinishDate ?? release.plannedFinishDate}`
                : 'No forecast'}
              {delta ? ` · ${delta}` : ''}
              {' · '}
              {release.remainingTickets} tasks open
            </div>
            {verdict && verdict.reasons.length > 0 && (
              <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 13, color: '#334155', lineHeight: 1.5 }}>
                {verdict.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <div style={{ fontSize: 14, color: '#475569' }}>
            No upcoming release. Create a version with a target date in the Releases tab.
          </div>
        )}
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        <Card title="What threatens it">
          {risks.length === 0 ? (
            <Muted>Nothing stands out.</Muted>
          ) : (
            <ol style={listStyle}>
              {risks.map((t, i) => (
                <li key={i}>
                  {t.nodeId ? <Link onClick={() => openNode(t.nodeId!)}>{t.text}</Link> : t.text}
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card title={`Finished in the last ${WINDOW_DAYS} days`}>
          {done.length === 0 ? (
            <Muted>Nothing was marked done in this window.</Muted>
          ) : (
            <ul style={listStyle}>
              {done.map((n) => (
                <li key={n.id}>
                  <Link onClick={() => openNode(n.id)}>{n.text}</Link>
                  {breadcrumb(nodes, n) && <span style={{ color: '#94a3b8' }}> — {breadcrumb(nodes, n)}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={`Scope change, last ${WINDOW_DAYS} days`}>
          <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.6 }}>
            <div>
              <strong>{growth.created}</strong> tasks added, <strong>{growth.deleted}</strong> removed
            </div>
            <div>
              Estimates moved by <strong>{growth.effortDelta > 0 ? '+' : ''}{Math.round(growth.effortDelta * 10) / 10}</strong> {forecast.effortUnit}
            </div>
            {release && growth.promoted.length > 0 && (
              <div>
                <strong>{growth.promoted.length}</strong> tasks were moved into {release.versionName}
              </div>
            )}
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 18, fontSize: 12, color: '#94a3b8' }}>
        Detail lives in the{' '}
        <Link onClick={() => setActiveView('releases')}>Releases</Link> tab. Forecast snapshot:{' '}
        {forecast.lastSnapshotAt ? forecast.lastSnapshotAt.slice(0, 16).replace('T', ' ') : 'none yet'}.
      </div>
    </Shell>
  );
}

// ── Bits ─────────────────────────────────────────────────────────────

const listStyle: React.CSSProperties = { margin: 0, paddingLeft: 18, fontSize: 13, color: '#334155', lineHeight: 1.6 };

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: '100%', overflow: 'auto', background: '#f8fafc' }}>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '28px 24px 48px' }}>{children}</div>
    </div>
  );
}

export function Card({ title, children, accent }: { title: string; children: React.ReactNode; accent?: string }) {
  return (
    <section
      style={{
        background: '#fff',
        border: `1px solid ${accent ?? '#e2e8f0'}`,
        borderRadius: 10,
        padding: '14px 18px',
      }}
    >
      <h3 style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

export function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 13, color: '#94a3b8' }}>{children}</div>;
}

export function Link({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        font: 'inherit',
        color: '#4f46e5',
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      {children}
    </button>
  );
}
