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
  collapseDuplicates,
  breadcrumb,
} from './landing.js';
import type { ChangeEventLite } from './landing.js';
import { pickCurrentCycle } from './roles.js';
import { Shell, Card, Muted, Link } from './DigestView.js';
import { DispatchCard, FleetCard } from './DispatchCards.js';
import { linkifyRefs } from './dispatch.js';

const WINDOW_DAYS = 3;
const EVENT_CAP = 1000;
const TRIAGE_PAGE = 500;
const CAUSE_PREVIEW = 8;

export function CockpitView() {
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const currentMap = useMindmapStore((s) => s.currentMap);
  const nodes = useMindmapStore((s) => s.nodes);
  const computed = useMindmapStore((s) => s.computed);
  const cycles = useMindmapStore((s) => s.cycles);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const setActiveView = useMindmapStore((s) => s.setActiveView);

  const [forecast, setForecast] = useState<ReleaseForecastResponse | null>(null);
  // Which blocker causes are unfolded to show their tasks (Dan: clicking a
  // cause jumped to one random task).
  const [openCauses, setOpenCauses] = useState<Set<number>>(new Set());
  const [showAllCauses, setShowAllCauses] = useState(false);
  const [events, setEvents] = useState<ChangeEventLite[]>([]);
  const [triage, setTriage] = useState<TriageDecision[]>([]);
  // Server-side total — the list is capped, the real backlog was 1946 (Round 2).
  const [triageTotal, setTriageTotal] = useState<number | null>(null);
  const [triageError, setTriageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentMapId) return;
    let cancelled = false;
    setError(null);
    // Reset per map — otherwise map A's broken-pipeline strip (or its 403)
    // outlives the switch to map B (review finding).
    setTriage([]);
    setTriageTotal(null);
    setTriageError(null);
    Promise.all([
      api.fetchReleaseForecast(currentMapId),
      api.fetchChangeHistory(currentMapId, { sinceDays: WINDOW_DAYS, limit: EVENT_CAP }),
      // A failed triage fetch must not hide the strip silently (Round 2: a
      // token-auth PM got 403 and saw "nothing waiting").
      api
        .listTriageDecisions(currentMapId, { reviewed: false, limit: TRIAGE_PAGE })
        .then((t) => ({ ok: true as const, ...t }))
        .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : 'unavailable' })),
    ])
      .then(([f, ev, t]) => {
        if (cancelled) return;
        setForecast(f);
        setEvents(ev.events);
        if (t.ok) {
          setTriage(t.decisions);
          setTriageTotal(t.total);
          setTriageError(null);
        } else {
          setTriageError(t.error);
        }
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
  const escalate = useMemo(() => collapseDuplicates(escalations(nodes, computed, categoryOf, 10)).slice(0, 5), [nodes, computed, categoryOf]);

  if (error) return <Shell><p style={{ color: '#b91c1c' }}>{error}</p></Shell>;
  if (!forecast) return <Shell><p style={{ color: '#64748b' }}>Loading…</p></Shell>;

  const totalBlocked = blockers.reduce((n, g) => n + g.nodeIds.length, 0);
  // #NNNN in a blockedReason links to the bound repo — workers write
  // "waiting on PR #8770" and a PM otherwise looks it up by hand.
  const repo = currentMap?.githubRepoOwner && currentMap?.githubRepoName
    ? { owner: currentMap.githubRepoOwner, name: currentMap.githubRepoName }
    : null;
  const orphanedCount = blockers.find((g) => g.kind === 'orphaned_claim')?.nodeIds.length ?? 0;
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
          {pipeline.since ? ` since at least ${pipeline.since.slice(0, 10)}` : ''} — {triageTotal ?? pipeline.count} tickets untriaged. Cause:{' '}
          <code>{pipeline.cause}</code>
        </div>
      )}
      {!pipeline.broken && (triageTotal ?? 0) > 0 && (
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
          {triageTotal} tickets waiting for triage.
        </div>
      )}
      {triage.length >= TRIAGE_PAGE && (
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 12 }}>
          Pipeline check reads the newest {TRIAGE_PAGE} pending decisions only.
        </div>
      )}
      {events.length >= EVENT_CAP && (
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 12 }}>
          Change log capped at {EVENT_CAP} events for the last {WINDOW_DAYS} days — the Slipped card may undercount.
        </div>
      )}
      {triageError && (
        <div style={{ fontSize: 12, color: '#b45309', marginBottom: 12 }}>
          Triage queue could not be loaded ({triageError}) — the count above may be missing.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <Card title="Slipped" accent={slippedReleases.length || growth.promoted.length ? '#fde68a' : undefined}>
          {slippedReleases.length === 0 && Object.keys(growth.promotedByVersion).length === 0 && growth.effortDelta <= 0 ? (
            <Muted>No release date moved this week and nothing was moved between versions.</Muted>
          ) : (
            <ul style={listStyle}>
              {slippedReleases.map((r) => {
                // The "why": tickets promoted into this release in the window.
                const promoted = (growth.promotedByVersion[r.versionId] ?? []).filter((id) => nodes[id]);
                const promotedEffort = promoted.reduce((s, id) => s + (nodes[id].effortEstimate ?? 0), 0);
                return (
                  <li key={r.versionId}>
                    <Link onClick={() => setActiveView('releases')}>{r.versionName}</Link> {weeklyDelta(r)}
                    {promoted.length > 0 && (
                      <span>
                        {' '}— {promoted.length} tickets ({Math.round(promotedEffort * 10) / 10} {forecast.effortUnit}) moved into it in the last {WINDOW_DAYS} days
                      </span>
                    )}
                  </li>
                );
              })}
              {Object.entries(growth.promotedByVersion)
                .filter(([vid]) => !slippedReleases.some((r) => r.versionId === vid))
                .map(([vid, ids]) => {
                  const name = forecast.releases.find((r) => r.versionId === vid)?.versionName ?? 'a version';
                  return (
                    <li key={vid}>
                      {ids.length} tickets moved into {name} in the last {WINDOW_DAYS} days
                      {ids[0] && nodes[ids[0]] && (
                        <> — e.g. <Link onClick={() => selectNode(ids[0])}>{nodes[ids[0]].text}</Link></>
                      )}
                    </li>
                  );
                })}
              {growth.effortDelta > 0 && (
                <li>
                  Scope grew by {Math.round(growth.effortDelta * 10) / 10} {forecast.effortUnit} net in the last {WINDOW_DAYS} days
                  {' '}(+{Math.round(growth.effortAdded * 10) / 10} / −{Math.round(growth.effortRemoved * 10) / 10})
                </li>
              )}
            </ul>
          )}
        </Card>

        <Card title={`Blocked — ${totalBlocked}, by cause`} accent={totalBlocked ? '#fecaca' : undefined}>
          {blockers.length === 0 ? (
            <Muted>Nothing is blocked.</Muted>
          ) : (
            <ul style={{ ...listStyle, paddingLeft: 0, listStyle: 'none' }}>
              {(showAllCauses ? blockers : blockers.slice(0, CAUSE_PREVIEW)).map((g, i) => {
                const open = openCauses.has(i);
                return (
                  <li key={i} style={{ marginBottom: 4 }}>
                    <Link
                      onClick={() =>
                        setOpenCauses((s) => {
                          const n = new Set(s);
                          if (n.has(i)) n.delete(i);
                          else n.add(i);
                          return n;
                        })
                      }
                    >
                      <span style={pillStyle}>{g.nodeIds.length} {g.nodeIds.length === 1 ? 'task' : 'tasks'}</span>{' '}
                      <span style={{ color: '#94a3b8', fontSize: 10 }}>{open ? '▾' : '▸'}</span> {g.label}
                    </Link>
                    {g.kind === 'orphaned_claim' && <span style={{ color: '#b91c1c' }}> — reset to todo or re-dispatch</span>}
                    {g.kind === 'merge_blocked' && <span style={{ color: '#b91c1c' }}> — one fix unblocks all</span>}
                    {open && (
                      <ul style={{ margin: '4px 0 6px 12px', paddingLeft: 14, fontSize: 12, lineHeight: 1.6 }}>
                        {collapseDuplicates(g.nodeIds.map((id) => nodes[id]).filter(Boolean)).map(({ node: { id }, duplicates }) =>
                          nodes[id] ? (
                            <li key={id}>
                              <Link onClick={() => selectNode(id)}>{nodes[id].text}</Link>
                              {duplicates > 0 && <span style={dupPillStyle}>×{duplicates + 1} — duplicate node</span>}
                              {breadcrumb(nodes, nodes[id]) && <span style={{ color: '#94a3b8' }}> — {breadcrumb(nodes, nodes[id])}</span>}
                              {g.kind !== 'orphaned_claim' && nodes[id].blockedReason && (
                                <div style={{ color: '#94a3b8', fontSize: 11 }}>
                                  {linkifyRefs(nodes[id].blockedReason.slice(0, 140), repo).map((seg, si) =>
                                    'ref' in seg ? (
                                      <a key={si} href={seg.url} target="_blank" rel="noreferrer" style={{ color: '#4f46e5' }} onClick={(e) => e.stopPropagation()}>
                                        {seg.ref}
                                      </a>
                                    ) : (
                                      <span key={si}>{seg.text}</span>
                                    ),
                                  )}
                                </div>
                              )}
                            </li>
                          ) : null,
                        )}
                      </ul>
                    )}
                  </li>
                );
              })}
              {blockers.length > CAUSE_PREVIEW && (
                <li style={{ marginTop: 4 }}>
                  <Link onClick={() => setShowAllCauses((v) => !v)}>
                    {showAllCauses ? `Show top ${CAUSE_PREVIEW} causes only` : `Show all ${blockers.length} causes`}
                  </Link>
                </li>
              )}
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
                Tagged with this sprint: <strong>{sprint.openInSprint + sprint.doneInSprint}</strong> tasks —{' '}
                <strong>{sprint.doneInSprint}</strong> done, <strong>{sprint.inProgressInSprint}</strong> started,{' '}
                <strong>{sprint.openInSprint - sprint.inProgressInSprint}</strong> not started
              </div>
              <div>
                Rolls over unless finished: <strong>{sprint.openInSprint}</strong>
              </div>
            </div>
          ) : (
            <Muted>No sprint covers today.</Muted>
          )}
        </Card>

        {/* Map-wide, on purpose: the WIP limit is a map setting, and "in
            progress" only means somebody marked it started — not that it is
            in the sprint, and (see stalled) not that anyone is still on it. */}
        <Card title="Work in progress — whole map" accent={overWip ? '#fecaca' : undefined}>
          <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.6 }}>
            <div>
              Marked started: <strong style={{ color: overWip ? '#b91c1c' : undefined }}>{sprint.inProgress}</strong>
              {sprint.wipLimit !== null ? ` / limit ${sprint.wipLimit}` : ''}
            </div>
            {sprint.stalled > 0 && (
              <div>
                <strong>{sprint.stalled}</strong> of those untouched for 14+ days
              </div>
            )}
            {orphanedCount > 0 && (
              <div>
                <strong style={{ color: '#b91c1c' }}>{orphanedCount}</strong> are orphaned claims — a worker died and the status never reset
              </div>
            )}
            <div style={{ color: '#94a3b8', fontSize: 12 }}>
              Actually moving: about {Math.max(0, sprint.inProgress - sprint.stalled - orphanedCount)}
            </div>
          </div>
        </Card>

        <Card title="Escalate" accent={escalate.length ? '#fde68a' : undefined}>
          {escalate.length === 0 ? (
            <Muted>No blocked P0/P1 with a named reason.</Muted>
          ) : (
            <ul style={listStyle}>
              {escalate.map(({ node: n, duplicates, duplicateIds }) => (
                <li key={n.id}>
                  <span style={{ fontWeight: 700, color: n.priority === 'P0' ? '#dc2626' : '#ea580c' }}>{n.priority}</span>{' '}
                  <Link onClick={() => selectNode(n.id)}>{n.text}</Link>
                  {duplicates > 0 && (
                    <span style={dupPillStyle} title={`Same issue is also on node(s) ${duplicateIds.map((d) => d.slice(0, 8)).join(', ')}`}>
                      ×{duplicates + 1} — duplicate node
                    </span>
                  )}
                  <div style={{ color: '#64748b', fontSize: 12 }}>
                    {breadcrumb(nodes, n) ? `${breadcrumb(nodes, n)} — ` : ''}{n.blockedReason}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Leidang fleet: steer (Dispatch) and see what the map holds
            (Fleet). Last in the grid on purpose — the Monday questions
            above come first; these are the operator's controls. */}
        <DispatchCard />
        <FleetCard />
      </div>
    </Shell>
  );
}

const listStyle: React.CSSProperties = { margin: 0, paddingLeft: 18, fontSize: 13, color: '#334155', lineHeight: 1.6 };
const dupPillStyle: React.CSSProperties = {
  marginLeft: 6,
  padding: '0 6px',
  borderRadius: 999,
  background: '#fef3c7',
  color: '#92400e',
  fontSize: 10,
  fontWeight: 700,
};
const pillStyle: React.CSSProperties = {
  display: 'inline-block',
  minWidth: 56,
  textAlign: 'center',
  padding: '0 6px',
  borderRadius: 999,
  background: '#fee2e2',
  color: '#991b1b',
  fontSize: 11,
  fontWeight: 700,
};
