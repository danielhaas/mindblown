/**
 * Stakeholder digest — the one screen persona "Thomas" asked for
 * (Round 1, 2026-08-26): "V1.5 — target — forecast (moved since last week?)
 * — on track yes/no and why — finished this fortnight — scope growth".
 * Round 2 added: a card per open release (overdue first) instead of only
 * the loudest one, and honest data sources for the three lower cards.
 * Read-only; every line that names a node selects it.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { ReleaseForecastResponse, ReleaseForecastRow } from './api.js';
import { statusCategory } from './viewScope.js';
import {
  openReleases,
  releaseVerdict,
  weeklyDelta,
  threats,
  recentlyDone,
  scopeGrowth,
  breadcrumb,
  paceRate,
  calendarAtPace,
} from './landing.js';
import type { ChangeEventLite } from './landing.js';

const LEVEL_STYLE = {
  on_track: { label: 'On track', bg: '#ecfdf5', fg: '#047857', border: '#a7f3d0' },
  at_risk: { label: 'At risk', bg: '#fffbeb', fg: '#b45309', border: '#fde68a' },
  behind: { label: 'Behind', bg: '#fef2f2', fg: '#b91c1c', border: '#fecaca' },
  unknown: { label: 'No forecast', bg: '#f8fafc', fg: '#475569', border: '#e2e8f0' },
} as const;

const WINDOW_DAYS = 14;
const EVENT_CAP = 1000;
const MAX_RELEASES = 3;

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
  const [focusId, setFocusId] = useState<string | null>(null);

  useEffect(() => {
    if (!currentMapId) return;
    let cancelled = false;
    setError(null);
    Promise.all([
      api.fetchReleaseForecast(currentMapId),
      api.fetchChangeHistory(currentMapId, { sinceDays: WINDOW_DAYS, limit: EVENT_CAP }),
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

  const releases = useMemo(() => (forecast ? openReleases(forecast.releases).slice(0, MAX_RELEASES) : []), [forecast]);
  // The threats/scope cards follow one release: the loudest by default, or
  // whichever card the reader clicked.
  const focus = releases.find((r) => r.versionId === focusId) ?? releases[0] ?? null;
  const risks = useMemo(
    () => threats(nodes, computed, categoryOf, focus?.versionId ?? null),
    [nodes, computed, categoryOf, focus?.versionId],
  );
  const done = useMemo(() => recentlyDone(nodes, categoryOf, WINDOW_DAYS), [nodes, categoryOf]);
  const growth = useMemo(() => scopeGrowth(events, focus?.versionId ?? null), [events, focus?.versionId]);

  if (error) {
    return <Shell><p style={{ color: '#b91c1c' }}>{error}</p></Shell>;
  }
  if (!forecast) {
    return <Shell><p style={{ color: '#64748b' }}>Loading…</p></Shell>;
  }

  const pace = paceRate(forecast);
  const rate = pace?.rate ?? null;
  const cal = (units: number) => calendarAtPace(units, rate) || 'no pace measured yet';

  return (
    <Shell>
      {releases.length === 0 ? (
        <section style={{ ...cardBase, marginBottom: 18 }}>
          <div style={{ fontSize: 14, color: '#475569' }}>
            No open release. Create a version with a target date in the Releases tab.
          </div>
        </section>
      ) : (
        releases.map((r, i) => (
          <ReleaseCard
            key={r.versionId}
            row={r}
            primary={i === 0}
            focused={focus?.versionId === r.versionId}
            onFocus={() => setFocusId(r.versionId)}
            onOpen={() => setActiveView('releases')}
          />
        ))
      )}

      {forecast.calibrationNote && (
        <div style={{ fontSize: 12, color: '#b45309', margin: '0 0 18px' }}>
          Forecast caveat: {forecast.calibrationNote}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        <Card title={focus ? `What threatens ${focus.versionName}` : 'What threatens it'}>
          {risks.length === 0 ? (
            <Muted>Nothing stands out.</Muted>
          ) : (
            <ol style={listStyle}>
              {risks.map((t, i) => (
                <li key={i}>
                  {t.nodeId ? <Link onClick={() => selectNode(t.nodeId!)}>{t.text}</Link> : t.text}
                  {t.effort !== null && t.effort > 0 && (
                    <span style={{ color: '#64748b' }}> — {cal(t.effort)}</span>
                  )}
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
                  <span style={{ color: '#94a3b8', fontSize: 11 }}>{n.completedAt!.slice(5, 10)} </span>
                  <Link onClick={() => selectNode(n.id)}>{n.text}</Link>
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
              {growth.effortDelta > 0 ? (
                <>The plan grew by <strong style={{ color: '#b91c1c' }}>{cal(growth.effortDelta)}</strong></>
              ) : growth.effortDelta < 0 ? (
                <>The plan shrank by <strong style={{ color: '#047857' }}>{cal(-growth.effortDelta)}</strong></>
              ) : (
                <>The amount of work did not change</>
              )}
              {growth.effortAdded > 0 && growth.effortRemoved > 0 && (
                <span style={{ color: '#94a3b8' }}> (added {cal(growth.effortAdded)}, removed {cal(growth.effortRemoved)})</span>
              )}
            </div>
            {events.length >= EVENT_CAP && (
              <div style={{ color: '#94a3b8', fontSize: 12 }}>Change log capped at {EVENT_CAP} events — counts are a floor.</div>
            )}
            {focus && growth.promoted.length > 0 && (
              <div>
                <strong>{growth.promoted.length}</strong> tasks were moved into {focus.versionName}
              </div>
            )}
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 18, fontSize: 12, color: '#94a3b8' }}>
        {pace
          ? pace.measured
            ? `"Current pace" is measured from what the team finished over the last ${forecast.ratesWindowDays ?? 14} days. `
            : '"Current pace" is the configured capacity — nothing has been measured yet. '
          : ''}
        Detail lives in the{' '}
        <Link onClick={() => setActiveView('releases')}>Releases</Link> tab. Forecast snapshot:{' '}
        {forecast.lastSnapshotAt ? forecast.lastSnapshotAt.slice(0, 16).replace('T', ' ') : 'none yet'}.
      </div>
    </Shell>
  );
}

function ReleaseCard({
  row,
  primary,
  focused,
  onFocus,
  onOpen,
}: {
  row: ReleaseForecastRow;
  primary: boolean;
  focused: boolean;
  onFocus: () => void;
  /** Open the Releases tab — the real drill-down for a release. */
  onOpen: () => void;
}) {
  const verdict = releaseVerdict(row);
  const lv = LEVEL_STYLE[verdict.level];
  const delta = weeklyDelta(row);
  const forecastDate = row.velocityAdjustedFinishDate ?? row.plannedFinishDate;
  return (
    <section
      // Clicking the card only re-targets the lower cards; that is invisible
      // on the card that is already focused, so it must not look like a link.
      onClick={focused ? undefined : onFocus}
      style={{
        background: lv.bg,
        border: `1px solid ${lv.border}`,
        outline: focused && !primary ? `2px solid ${lv.fg}` : 'none',
        borderRadius: 10,
        padding: primary ? '18px 22px' : '10px 16px',
        marginBottom: primary ? 14 : 10,
        cursor: focused ? 'default' : 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <Link onClick={onOpen}>
          <span style={{ fontSize: primary ? 22 : 15, fontWeight: 700, color: '#0f172a', textDecoration: 'underline', textDecorationColor: '#c7d2fe', textUnderlineOffset: 4 }}>
            {row.versionName}
          </span>
        </Link>
        <span style={{ fontSize: 12, fontWeight: 700, color: lv.fg, textTransform: 'uppercase', letterSpacing: 0.5 }}>{lv.label}</span>
      </div>
      <div style={{ fontSize: primary ? 14 : 13, color: '#1e293b', marginTop: 4 }}>{verdict.headline}</div>
      <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
        {row.targetDate ? `Target ${row.targetDate}` : 'No target date'}
        {' · '}
        {forecastDate ? `Forecast ${forecastDate}` : 'No forecast'}
        {delta ? ` · ${delta}` : ''}
        {' · '}
        {row.remainingTickets} tasks open
      </div>
      {(primary || focused) && verdict.reasons.length > 0 && (
        <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 13, color: '#334155', lineHeight: 1.5 }}>
          {verdict.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Bits ─────────────────────────────────────────────────────────────

const listStyle: React.CSSProperties = { margin: 0, paddingLeft: 18, fontSize: 13, color: '#334155', lineHeight: 1.6 };
const cardBase: React.CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '14px 18px' };

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: '100%', overflow: 'auto', background: '#f8fafc' }}>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '28px 24px 48px' }}>{children}</div>
    </div>
  );
}

export function Card({ title, children, accent }: { title: string; children: React.ReactNode; accent?: string }) {
  return (
    <section style={{ ...cardBase, border: `1px solid ${accent ?? '#e2e8f0'}` }}>
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
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
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
