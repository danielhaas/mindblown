/**
 * PM cockpit — persona "Jenna"'s Monday page (Round 1, 2026-08-26): a
 * pipeline-broken strip, then Slipped / Blocked-by-cause / Sprint /
 * Escalate, each line clickable to the node. The tabs are the drill-down.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import { summarisePace, describeStalled } from '@mindblown/core';
import { useStalled } from './useStalled.js';
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
import type { ChangeEventLite, BlockerKind } from './landing.js';
import { pickCurrentCycle } from './roles.js';
import { Shell, Card, Muted, Link } from './DigestView.js';
import { linkifyRefs } from './dispatch.js';

const WINDOW_DAYS = 3;
const EVENT_CAP = 1000;
// Pace shows the last 14 days of the forecast's own 56-day measurement —
// asking for 14 would evict the 56-day repo-throughput cache on every open.
const PACE_FETCH_DAYS = 56;
const PACE_DAYS = 14;
const TRIAGE_PAGE = 500;
const CAUSE_PREVIEW = 8;
/** Blocker causes where "release all" is a sane default (see the Blocked card). */
const BULK_RELEASE_KINDS = new Set<BlockerKind>(['decision', 'external', 'other']);

export function CockpitView() {
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const currentMap = useMindmapStore((s) => s.currentMap);
  const nodes = useMindmapStore((s) => s.nodes);
  const computed = useMindmapStore((s) => s.computed);
  const cycles = useMindmapStore((s) => s.cycles);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const setActiveView = useMindmapStore((s) => s.setActiveView);
  const unblockNode = useMindmapStore((s) => s.unblockNode);

  const [forecast, setForecast] = useState<ReleaseForecastResponse | null>(null);
  // Which blocker causes are unfolded to show their tasks (Dan: clicking a
  // cause jumped to one random task).
  const [openCauses, setOpenCauses] = useState<Set<number>>(new Set());
  const [showAllCauses, setShowAllCauses] = useState(false);
  const [events, setEvents] = useState<ChangeEventLite[]>([]);
  const [triage, setTriage] = useState<TriageDecision[]>([]);
  // Server-side total — the list is capped, the real backlog was 1946 (Round 2).
  const [triageTotal, setTriageTotal] = useState<number | null>(null);
  const [pipelineState, setPipelineState] = useState<api.TriagePipelineResponse | null>(null);
  const [velocity, setVelocity] = useState<api.VelocityPaceResponse | null | 'error'>(null);
  const [triageError, setTriageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Asks loop: ids currently being released back into the queue. One at a
  // time per click (bulk runs sequentially) so a failure names the ticket.
  const [releasing, setReleasing] = useState<Set<string>>(new Set());
  const [releaseNote, setReleaseNote] = useState<string | null>(null);

  const releaseTickets = async (ids: string[], label: string) => {
    if (ids.length > 1 && !window.confirm(`Release ${ids.length} tickets under "${label}" back into the pull queue?\n\nEach gets blockedReason cleared, the blocked tag removed and its status reset to todo (done stays done). The fleet can pull them within ~2 min.`)) return;
    let ok = 0;
    let failed: string | null = null;
    for (const id of ids) {
      setReleasing(new Set([id]));
      if (await unblockNode(id)) ok += 1;
      else {
        // Read through the store, not the render closure — `nodes` is stale after the first await.
        failed = useMindmapStore.getState().nodes[id]?.text ?? id;
        break;
      }
    }
    setReleasing(new Set());
    setReleaseNote(failed ? `Released ${ok}, then failed on "${failed}" — see the error banner.` : `Released ${ok} ticket${ok === 1 ? '' : 's'} back into the queue.`);
  };

  useEffect(() => {
    if (!currentMapId) return;
    let cancelled = false;
    setError(null);
    // Reset per map — otherwise map A's broken-pipeline strip (or its 403)
    // outlives the switch to map B (review finding).
    setTriage([]);
    setTriageTotal(null);
    setTriageError(null);
    setPipelineState(null);
    setVelocity(null);
    // Pace: estimated days finished per calendar day (batch writes excluded).
    api
      .fetchVelocity(currentMapId, PACE_FETCH_DAYS)
      .then((v) => !cancelled && setVelocity(v))
      .catch(() => !cancelled && setVelocity('error'));
    // The pipeline state comes from the server (#320): it sees every pending
    // row and the reviewed successes that prove a recovery, and it answers
    // API-key callers too — the row list below does not.
    api
      .fetchTriagePipeline(currentMapId)
      .then((p) => !cancelled && setPipelineState(p))
      .catch(() => {});
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
  const stalled = useStalled();
  const stalledById = useMemo(() => new Map(stalled.map((s) => [s.nodeId, s])), [stalled]);
  const blockers = useMemo(
    () => groupBlockers(nodes, computed, categoryOf, stalled),
    [nodes, computed, categoryOf, stalled],
  );
  const sprint = useMemo(
    () => sprintHealth(pickCurrentCycle(cycles), nodes, categoryOf, currentMap?.wipLimit ?? null),
    [cycles, nodes, categoryOf, currentMap?.wipLimit],
  );
  const localPipeline = useMemo(() => triagePipelineState(triage), [triage]);
  const pipeline = pipelineState ?? localPipeline;
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
      {pipeline.stale && (
        <div
          style={{
            background: '#fffbeb',
            border: '1px solid #fde68a',
            color: '#92400e',
            borderRadius: 10,
            padding: '10px 16px',
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <strong>Triage recovered</strong> — {pipeline.count} tickets from the outage
          {pipeline.since ? ` (since ${pipeline.since.slice(0, 10)})` : ''} still need a Re-classify. Cause was:{' '}
          <code>{pipeline.cause}</code>
        </div>
      )}
      {!pipeline.broken && !pipeline.stale && (triageTotal ?? 0) > 0 && (
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
        <PaceCard velocity={velocity} />

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
          {releaseNote && (
            <div style={{ fontSize: 12, color: '#166534', background: '#dcfce7', borderRadius: 6, padding: '4px 8px', marginBottom: 8 }}>
              {releaseNote}{' '}
              <Link onClick={() => setReleaseNote(null)}>dismiss</Link>
            </div>
          )}
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
                    {g.kind === 'stalled' && <span style={{ color: '#b91c1c' }}> — release to the queue, or park it</span>}
                    {g.kind === 'merge_blocked' && <span style={{ color: '#b91c1c' }}> — one fix unblocks all</span>}
                    {/* Bulk only where re-queueing is the right default. pr_open /
                        merge_blocked tickets have finished code in review — a
                        re-pull would duplicate it; orphaned claims need a look at
                        the half-finished worktree first. Those keep the per-row button. */}
                    {BULK_RELEASE_KINDS.has(g.kind) && g.nodeIds.length > 1 && (
                      <button
                        style={releaseBtnStyle}
                        disabled={releasing.size > 0}
                        title="Release every ticket under this cause back into the pull queue: blockedReason cleared, blocked tag removed, status back to todo (done stays done)."
                        onClick={() => void releaseTickets(g.nodeIds, g.label)}
                      >
                        Release all {g.nodeIds.length}
                      </button>
                    )}
                    {open && (
                      <ul style={{ margin: '4px 0 6px 12px', paddingLeft: 14, fontSize: 12, lineHeight: 1.6 }}>
                        {collapseDuplicates(g.nodeIds.map((id) => nodes[id]).filter(Boolean)).map(({ node: { id }, duplicates }) =>
                          nodes[id] ? (
                            <li key={id}>
                              <Link onClick={() => selectNode(id)}>{nodes[id].text}</Link>
                              {duplicates > 0 && <span style={dupPillStyle}>×{duplicates + 1} — duplicate node</span>}
                              {breadcrumb(nodes, nodes[id]) && <span style={{ color: '#94a3b8' }}> — {breadcrumb(nodes, nodes[id])}</span>}
                              {g.kind !== 'dependency' && (
                                <button
                                  style={releaseBtnStyle}
                                  disabled={releasing.size > 0}
                                  title={
                                    nodes[id].claimedBySession
                                      ? `Still claimed by ${nodes[id].claimedBySession} — this clears the reason and tag but leaves the status; release the claim first if that worker is gone.`
                                      : 'Release back into the pull queue: blockedReason cleared, blocked tag removed, status back to todo (done stays done).'
                                  }
                                  onClick={() => void releaseTickets([id], nodes[id].text)}
                                >
                                  {releasing.has(id) ? 'Releasing…' : 'Release'}
                                </button>
                              )}
                              {g.kind === 'stalled' && stalledById.has(id) && (
                                <div style={{ color: '#92400e', fontSize: 11 }}>{describeStalled(stalledById.get(id)!)}</div>
                              )}
                              {g.kind !== 'orphaned_claim' && nodes[id].blockedReason && (
                                <div style={{ color: '#94a3b8', fontSize: 11 }}>
                                  {linkifyRefs(truncateReason(nodes[id].blockedReason), repo).map((seg, si) =>
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

        {/* The Leidang cards (Dispatch + Fleet) moved to their own Fleet
            tab — buried as the last grid items here, nobody found them. */}
      </div>
    </Shell>
  );
}

/** 140 chars, but never through the middle of a `#NNNN` (→ a wrong link). */
function truncateReason(reason: string): string {
  if (reason.length <= 140) return reason;
  return reason.slice(0, 140).replace(/#\d*$/, '') + '…';
}

const listStyle: React.CSSProperties = { margin: 0, paddingLeft: 18, fontSize: 13, color: '#334155', lineHeight: 1.6 };
const releaseBtnStyle: React.CSSProperties = {
  marginLeft: 8,
  fontSize: 11,
  padding: '1px 8px',
  border: '1px solid #bbf7d0',
  borderRadius: 6,
  background: '#f0fdf4',
  color: '#166534',
  cursor: 'pointer',
  fontFamily: 'inherit',
  verticalAlign: 'middle',
};
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

/**
 * Pace — "we planned days for today's work, and did it all today". The
 * plan's estimated days finished per calendar day against what the plan
 * assumes a day delivers (workers × units per day), with the last two
 * weeks as bars. Batch writes (hygiene passes, sprint closes) are left out,
 * the same way velocity_report and the forecast count.
 */
function PaceCard({ velocity }: { velocity: api.VelocityPaceResponse | null | 'error' }) {
  if (velocity === 'error') {
    return (
      <Card title="Pace">
        <Muted>Could not measure the pace right now.</Muted>
      </Card>
    );
  }
  if (!velocity) {
    return (
      <Card title="Pace">
        <Muted>Measuring…</Muted>
      </Card>
    );
  }
  const unit = velocity.effortUnit === 'hours' ? 'h' : velocity.effortUnit === 'days' ? 'd' : 'pts';
  const daily = velocity.daily.slice(-PACE_DAYS);
  const pace = summarisePace(daily, velocity.nominalCapacity, velocity.effortUnit);
  const max = Math.max(...daily.map((d) => d.completed), velocity.nominalCapacity, 0.0001);
  const fmt = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));
  const fast = pace.ratio >= 1.5;
  return (
    <Card title="Pace" accent={fast ? '#bbf7d0' : pace.ratio > 0 && pace.ratio <= 0.67 ? '#fde68a' : undefined}>
      <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.5, marginBottom: 10 }}>{pace.note}</div>
      <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#475569', marginBottom: 10 }}>
        <span>
          Today <strong style={{ fontSize: 15, color: '#0f172a' }}>{fmt(pace.today)}{unit}</strong>
        </span>
        <span>
          7 days <strong style={{ fontSize: 15, color: '#0f172a' }}>{fmt(pace.last7)}{unit}</strong>
        </span>
        <span>
          {pace.windowDays} days <strong style={{ fontSize: 15, color: '#0f172a' }}>{fmt(pace.window)}{unit}</strong>
        </span>
      </div>
      <div
        role="img"
        aria-label={`Estimated work finished per day, last ${daily.length} days: ${daily.map((d) => fmt(d.completed)).join(', ')} ${velocity.effortUnit}`}
        style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 64, position: 'relative' }}
      >
        {/* the plan: what one calendar day is supposed to deliver */}
        <div
          title={`Planned: ${fmt(velocity.nominalCapacity)}${unit} per day`}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: `${(velocity.nominalCapacity / max) * 64}px`,
            borderTop: '1px dashed #94a3b8',
          }}
        />
        {daily.map((d, i) => (
          <div
            key={d.day}
            title={`${d.day}: ${fmt(d.completed)}${unit} finished (${d.completions} completion${d.completions === 1 ? '' : 's'})`}
            style={{
              flex: 1,
              height: `${Math.max(d.completed > 0 ? 2 : 0, (d.completed / max) * 64)}px`,
              background: i === daily.length - 1 ? '#4f46e5' : '#c7d2fe',
              borderRadius: 2,
            }}
          />
        ))}
      </div>
      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
        Estimated {velocity.effortUnit} finished per UTC day; dashed line = planned {fmt(velocity.nominalCapacity)}
        {unit}/day (workers × capacity per worker, map settings). Batch updates left out.
      </div>
    </Card>
  );
}
