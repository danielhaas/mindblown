/**
 * PM cockpit — persona "Jenna"'s Monday page (Round 1, 2026-08-26): a
 * pipeline-broken strip, then Slipped / Blocked-by-cause / Sprint /
 * Escalate, each line clickable to the node. The tabs are the drill-down.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { ReleaseForecastResponse, TriageDecision } from './api.js';
import { statusCategory } from './viewScope.js';
import {
  nextRelease,
  weeklyDelta,
  scopeGrowth,
  groupBlockers,
  sprintHealth,
  triagePipelineState,
  escalations,
  breadcrumb,
} from './landing.js';
import type { ChangeEventLite } from './landing.js';
import { pickCurrentCycle } from './roles.js';
import { Shell, Card, Muted, Link } from './DigestView.js';

const WINDOW_DAYS = 3;

export function CockpitView() {
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const currentMap = useMindmapStore((s) => s.currentMap);
  const nodes = useMindmapStore((s) => s.nodes);
  const computed = useMindmapStore((s) => s.computed);
  const cycles = useMindmapStore((s) => s.cycles);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const setActiveView = useMindmapStore((s) => s.setActiveView);

  const [forecast, setForecast] = useState<ReleaseForecastResponse | null>(null);
  const [events, setEvents] = useState<ChangeEventLite[]>([]);
  const [triage, setTriage] = useState<TriageDecision[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentMapId) return;
    let cancelled = false;
    setError(null);
    Promise.all([
      api.fetchReleaseForecast(currentMapId),
      api.fetchChangeHistory(currentMapId, { sinceDays: WINDOW_DAYS, limit: 1000 }),
      api.listTriageDecisions(currentMapId, { reviewed: false, limit: 500 }).catch(() => ({ decisions: [] as TriageDecision[] })),
    ])
      .then(([f, ev, t]) => {
        if (cancelled) return;
        setForecast(f);
        setEvents(ev.events);
        setTriage(t.decisions);
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
  const slippedReleases = useMemo(
    () => (forecast?.releases ?? []).filter((r) => (r.velocityFinishDeltaDays7d ?? r.plannedFinishDeltaDays7d ?? 0) > 0),
    [forecast],
  );
  const growth = useMemo(() => scopeGrowth(events, release?.versionId ?? null), [events, release?.versionId]);
  const blockers = useMemo(() => groupBlockers(nodes, computed, categoryOf), [nodes, computed, categoryOf]);
  const sprint = useMemo(
    () => sprintHealth(pickCurrentCycle(cycles), nodes, categoryOf, currentMap?.wipLimit ?? null),
    [cycles, nodes, categoryOf, currentMap?.wipLimit],
  );
  const pipeline = useMemo(() => triagePipelineState(triage), [triage]);
  const escalate = useMemo(() => escalations(nodes, computed, categoryOf), [nodes, computed, categoryOf]);

  if (error) return <Shell><p style={{ color: '#b91c1c' }}>{error}</p></Shell>;
  if (!forecast) return <Shell><p style={{ color: '#64748b' }}>Loading…</p></Shell>;

  const totalBlocked = blockers.reduce((n, g) => n + g.nodeIds.length, 0);
  const overWip = sprint.wipLimit !== null && sprint.inProgress > sprint.wipLimit;

  return (
    <Shell>
      {pipeline.broken && (
        <div
          style={{
            background: '#fef2f2',
            border: '1px solid #fecaca',
            color: '#991b1b',
            borderRadius: 10,
            padding: '10px 16px',
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <strong>Triage pipeline is broken</strong>
          {pipeline.since ? ` since ${pipeline.since.slice(0, 10)}` : ''} — {pipeline.count} tickets untriaged. Cause:{' '}
          <code>{pipeline.cause}</code>
        </div>
      )}
      {!pipeline.broken && triage.length > 0 && (
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
          {triage.length} tickets waiting for triage.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <Card title="Slipped" accent={slippedReleases.length || growth.promoted.length ? '#fde68a' : undefined}>
          {slippedReleases.length === 0 && growth.promoted.length === 0 && growth.effortDelta <= 0 ? (
            <Muted>No release date moved this week and nothing was promoted into {release?.versionName ?? 'the next release'}.</Muted>
          ) : (
            <ul style={listStyle}>
              {slippedReleases.map((r) => (
                <li key={r.versionId}>
                  <Link onClick={() => setActiveView('releases')}>{r.versionName}</Link> {weeklyDelta(r)}
                </li>
              ))}
              {growth.promoted.map((id) =>
                nodes[id] ? (
                  <li key={id}>
                    <Link onClick={() => selectNode(id)}>{nodes[id].text}</Link> moved into {release?.versionName} in the last {WINDOW_DAYS} days
                    {nodes[id].effortEstimate ? ` (${nodes[id].effortEstimate}d)` : ' (no estimate)'}
                  </li>
                ) : null,
              )}
              {growth.effortDelta > 0 && (
                <li>
                  Estimates grew by {Math.round(growth.effortDelta * 10) / 10} {forecast.effortUnit} in the last {WINDOW_DAYS} days
                </li>
              )}
            </ul>
          )}
        </Card>

        <Card title={`Blocked — ${totalBlocked}, by cause`} accent={totalBlocked ? '#fecaca' : undefined}>
          {blockers.length === 0 ? (
            <Muted>Nothing is blocked.</Muted>
          ) : (
            <ul style={listStyle}>
              {blockers.slice(0, 8).map((g, i) => (
                <li key={i}>
                  <strong>{g.nodeIds.length}</strong>{' '}
                  <Link onClick={() => selectNode(g.nodeIds[0])}>{g.label}</Link>
                  {g.kind === 'orphaned_claim' && <span style={{ color: '#b91c1c' }}> — reset to todo or re-dispatch</span>}
                </li>
              ))}
              {blockers.length > 8 && <li style={{ color: '#94a3b8' }}>… {blockers.length - 8} more causes</li>}
            </ul>
          )}
        </Card>

        <Card title="Sprint" accent={overWip || sprint.endedButNotClosed ? '#fecaca' : undefined}>
          {sprint.cycle ? (
            <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.6 }}>
              <div>
                <strong>{sprint.cycle.name}</strong>{' '}
                {sprint.endedButNotClosed
                  ? <span style={{ color: '#b91c1c' }}>ended {-sprint.daysLeft!} days ago and is still {sprint.cycle.status}</span>
                  : sprint.daysLeft !== null && sprint.daysLeft >= 0
                    ? `— ${sprint.daysLeft} days left`
                    : ''}
              </div>
              <div>
                In progress: <strong style={{ color: overWip ? '#b91c1c' : undefined }}>{sprint.inProgress}</strong>
                {sprint.wipLimit !== null ? ` / limit ${sprint.wipLimit}` : ''}
                {sprint.stalled > 0 && <>, <strong>{sprint.stalled}</strong> untouched for 14+ days</>}
              </div>
              <div>Open in this sprint: <strong>{sprint.openInSprint}</strong> (rolls over unless finished)</div>
            </div>
          ) : (
            <Muted>No sprint covers today.</Muted>
          )}
        </Card>

        <Card title="Escalate" accent={escalate.length ? '#fde68a' : undefined}>
          {escalate.length === 0 ? (
            <Muted>No blocked P0/P1 with a named reason.</Muted>
          ) : (
            <ul style={listStyle}>
              {escalate.map((n) => (
                <li key={n.id}>
                  <span style={{ fontWeight: 700, color: n.priority === 'P0' ? '#dc2626' : '#ea580c' }}>{n.priority}</span>{' '}
                  <Link onClick={() => selectNode(n.id)}>{n.text}</Link>
                  <div style={{ color: '#64748b', fontSize: 12 }}>
                    {breadcrumb(nodes, n) ? `${breadcrumb(nodes, n)} — ` : ''}{n.blockedReason}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Shell>
  );
}

const listStyle: React.CSSProperties = { margin: 0, paddingLeft: 18, fontSize: 13, color: '#334155', lineHeight: 1.6 };
