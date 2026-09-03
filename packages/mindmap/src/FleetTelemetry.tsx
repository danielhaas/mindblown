/**
 * Satellite + orchestrator telemetry inside the cockpit's Fleet card.
 *
 * Renders what the satellites pushed (`PUT /fleet-status/:host`, every
 * ~2 min) and what the orchestrator judged (`POST /fleet-ticks`, every
 * ~30 min). Reading is core `fleet.ts` — the same staleness/deadness
 * rules the orchestrator applies: a rollup older than 20 min is a host
 * that is down, paused, or whose agent stopped, and it does not count as
 * capacity; a worker that says "working" but has not moved for 30 min is
 * dead.
 *
 * Clocks: staleness is judged against the SERVER time the last response
 * carried (core `estimateServerNow`), advanced by a 30-s ticker — a fleet
 * that dies sends nothing, so the card must age its data on its own, not
 * wait for the next push. Refetches on every `fleet:updated` socket
 * message and every 60 s as a backstop.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { summarizeFleet, effectiveWorkerState, silentSatellites, estimateServerNow, summarizeTick } from '@mindblown/core';
import type { FleetWorkerStatus, HostSummary, Node, TickSummary } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { FleetResponse } from './api.js';
import { Link } from './DigestView.js';
import { formatAge } from './dispatch.js';

const CLOCK_MS = 30_000;
const POLL_MS = 60_000;

const STATE_STYLE: Record<string, { bg: string; color: string }> = {
  working: { bg: '#dcfce7', color: '#166534' },
  prompt: { bg: '#dbeafe', color: '#1e40af' },
  clearing: { bg: '#ede9fe', color: '#5b21b6' },
  'limit-parked': { bg: '#ffedd5', color: '#9a3412' },
  'auth-parked': { bg: '#fef3c7', color: '#92400e' },
  parked: { bg: '#f1f5f9', color: '#475569' },
  dead: { bg: '#fee2e2', color: '#991b1b' },
};
const STATE_ORDER = ['working', 'prompt', 'clearing', 'parked', 'limit-parked', 'auth-parked', 'dead'];

function localHHMM(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

type Loaded = { data: FleetResponse; fetchedAt: number };

export function FleetTelemetry() {
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const fleetRev = useMindmapStore((s) => s.fleetRev);
  const nodes = useMindmapStore((s) => s.nodes);
  const selectNode = useMindmapStore((s) => s.selectNode);
  // data + fetchedAt live in ONE state so the server time and the moment it
  // was fetched can never come from different fetches (that pairing
  // double-counted the page's uptime and painted every host red).
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openHosts, setOpenHosts] = useState<Set<string>>(new Set());
  const [clock, setClock] = useState(0);
  const [poll, setPoll] = useState(0);

  useEffect(() => {
    const c = setInterval(() => setClock((t) => t + 1), CLOCK_MS);
    const p = setInterval(() => setPoll((t) => t + 1), POLL_MS);
    return () => {
      clearInterval(c);
      clearInterval(p);
    };
  }, []);

  useEffect(() => {
    if (!currentMapId) return;
    let cancelled = false;
    api
      .fetchFleet(currentMapId)
      .then((r) => {
        if (cancelled) return;
        setLoaded({ data: r, fetchedAt: Date.now() });
        setError(null);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : 'unavailable'));
    return () => {
      cancelled = true;
    };
  }, [currentMapId, fleetRev, poll]);

  // Re-evaluated on every clock tick, so a fleet that went silent turns
  // stale on screen without anyone pushing.
  const now = useMemo(
    () => (loaded ? estimateServerNow(loaded.data.now, loaded.fetchedAt, Date.now()) : new Date()),
    [loaded, clock], // eslint-disable-line react-hooks/exhaustive-deps -- clock is the ticker
  );
  const summary = useMemo(
    () => summarizeFleet((loaded?.data.hosts ?? []).map((h) => ({ rollup: h.rollup, receivedAt: h.receivedAt })), now),
    [loaded, now],
  );
  const tick = loaded?.data.ticks[0] ?? null;
  const silent = useMemo(() => silentSatellites(tick?.payload.pullStatus, summary.hosts.map((h) => h.host)), [tick, summary.hosts]);

  if (error) return <div style={{ fontSize: 12, color: '#b45309' }}>Fleet telemetry unavailable ({error}).</div>;
  if (!loaded) return <div style={{ fontSize: 12, color: '#94a3b8' }}>Loading fleet telemetry…</div>;

  const totals = Object.entries(summary.totals).sort((a, b) => {
    const ia = STATE_ORDER.indexOf(a[0]);
    const ib = STATE_ORDER.indexOf(b[0]);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const allStale = summary.hosts.length > 0 && summary.freshHosts === 0;

  return (
    <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.6, marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid #f1f5f9' }}>
      {summary.hosts.length === 0 ? (
        <div style={{ color: '#94a3b8', fontSize: 12 }}>
          No satellite has pushed a rollup yet — the fleet is off, or rollup.sh on the satellites does not have the fleet-status push yet.
        </div>
      ) : (
        <>
          <div>
            Satellites: <strong>{summary.freshHosts}</strong>/{summary.hosts.length} reporting ·{' '}
            <strong>{summary.workersTotal}</strong> workers on reporting hosts
            {summary.staleWorkers > 0 && <span style={{ color: '#94a3b8' }}> (+{summary.staleWorkers} last seen on stale hosts, not counted)</span>}
            {totals.length > 0 && (
              <span style={{ color: '#64748b' }}>
                {' '}—{' '}
                {totals.map(([s, n], i) => (
                  <span key={s}>
                    {i > 0 && ' · '}
                    <span style={{ ...pill, ...(STATE_STYLE[s] ?? { bg: '#f1f5f9', color: '#475569' }) }}>{s} {n}</span>
                  </span>
                ))}
              </span>
            )}
          </div>
          {allStale && (
            <div style={{ color: '#991b1b', fontSize: 12 }}>
              No host is reporting — every rollup is older than 20 min. Fleet stopped, hosts down, or the agents are not running.
            </div>
          )}
          {!allStale && summary.working === 0 && summary.workersTotal > 0 && (
            <div style={{ color: '#991b1b', fontSize: 12 }}>Nobody is working. Cap and gate are not the reason — look at the worker states below.</div>
          )}
          {silent.map((s) =>
            s.reason === 'not-pushing' ? (
              <div key={s.sat} style={{ color: '#94a3b8', fontSize: 12 }}>
                {s.sat} delivers to the orchestrator but does not push to MindBlown yet (sender patch not rolled out there).
              </div>
            ) : (
              <div key={s.sat} style={{ color: '#991b1b', fontSize: 12 }}>
                Satellite <strong>{s.sat}</strong> is configured but {s.reason === 'unreachable' ? 'unreachable over ssh' : 'delivered no rollup — agent not running'}.
              </div>
            ),
          )}
          <ul style={{ margin: '4px 0 0', paddingLeft: 0, listStyle: 'none' }}>
            {summary.hosts.map((h) => (
              <HostRow
                key={h.host}
                host={h}
                now={now}
                open={openHosts.has(h.host)}
                onToggle={() =>
                  setOpenHosts((s) => {
                    const n = new Set(s);
                    if (n.has(h.host)) n.delete(h.host);
                    else n.add(h.host);
                    return n;
                  })
                }
                nodes={nodes}
                selectNode={selectNode}
              />
            ))}
          </ul>
        </>
      )}

      <div style={{ marginTop: 8 }}>
        {tick ? <TickBlock tick={tick} now={now} /> : <div style={{ color: '#94a3b8', fontSize: 12 }}>No orchestrator tick received yet.</div>}
      </div>
      <TickHistory mapId={currentMapId} fleetRev={fleetRev} now={now} />
    </div>
  );
}

type NodeIndex = Record<string, Pick<Node, 'text'>>;

function HostRow({ host: h, now, open, onToggle, nodes, selectNode }: {
  host: HostSummary;
  now: Date;
  open: boolean;
  onToggle: () => void;
  nodes: NodeIndex;
  selectNode: (id: string) => void;
}) {
  const age = `${Math.round(h.freshness.ageMin)}m`;
  return (
    <li style={{ marginTop: 4 }}>
      <Link onClick={onToggle}>
        <span style={{ color: '#94a3b8', fontSize: 10 }}>{open ? '▾' : '▸'}</span> <strong>{h.host}</strong>
      </Link>
      <span style={{ color: h.freshness.stale ? '#991b1b' : '#64748b', fontSize: 12 }}>
        {' '}· {age} ago{h.freshness.stale ? ' — STALE: host down, paused, or agent stopped?' : ''}
      </span>
      {h.draining && <span style={{ ...pill, background: '#fef3c7', color: '#92400e', marginLeft: 6 }}>draining: {h.draining}</span>}
      <span style={{ color: '#64748b', fontSize: 12 }}>
        {' '}· {Object.entries(h.counts).map(([s, n]) => `${s} ${n}`).join(', ') || 'no workers'}
        {h.freshness.stale && h.workers.length > 0 ? ' (last seen)' : ''}
      </span>
      {open && (
        <ul style={{ margin: '2px 0 4px 14px', paddingLeft: 12, fontSize: 12, lineHeight: 1.7 }}>
          {h.workers.map((w) => (
            <WorkerRow key={w.session} w={w} now={now} nodes={nodes} selectNode={selectNode} />
          ))}
        </ul>
      )}
    </li>
  );
}

function WorkerRow({ w, now, nodes, selectNode }: { w: FleetWorkerStatus; now: Date; nodes: NodeIndex; selectNode: (id: string) => void }) {
  const state = effectiveWorkerState(w, now);
  const style = STATE_STYLE[state] ?? { bg: '#f1f5f9', color: '#475569' };
  const claimId = w.claim?.nodeId;
  const claimTitle = w.claim?.title ?? (claimId ? nodes[claimId]?.text : undefined);
  return (
    <li>
      <span title={w.session}>{w.worker ?? w.session}</span>
      {w.model && <span style={{ color: '#94a3b8' }}> {w.model}</span>}{' '}
      <span style={{ ...pill, ...style }}>{state}</span>
      {claimTitle && (
        <span>
          {' '}— {claimId && nodes[claimId] ? <Link onClick={() => selectNode(claimId)}>{claimTitle}</Link> : claimTitle}
        </span>
      )}
      {state === 'limit-parked' && w.limit_reset_at && <span style={{ color: '#9a3412' }}> · reset {localHHMM(w.limit_reset_at)}</span>}
      {state === 'prompt' && w.prompt_question && <span style={{ color: '#1e40af' }}> · asks: {w.prompt_question}</span>}
      {w.waiting?.reason && <span style={{ color: '#64748b' }}> · waiting: {w.waiting.reason}</span>}
      {typeof w.ctx_pct === 'number' && <span style={{ color: '#94a3b8' }}> · ctx {w.ctx_pct}%</span>}
      {w.last_activity && <span style={{ color: '#94a3b8' }}> · idle {formatAge(w.last_activity, now)}</span>}
    </li>
  );
}

const sevColor = (s: string) => (s === 'critical' ? '#991b1b' : s === 'warn' || s === 'warning' ? '#b45309' : '#64748b');

function TickBlock({ tick, now }: { tick: FleetResponse['ticks'][number]; now: Date }) {
  const p = tick.payload;
  const anomalies = p.anomalies ?? [];
  const asks = p.asks ?? [];
  return (
    <div style={{ fontSize: 12 }}>
      <div style={{ color: '#334155' }}>
        <strong>Orchestrator</strong> · last tick {formatAge(tick.receivedAt, now)} ago
        {p.noJudgment && <span style={{ color: '#b45309' }}> · no judgment this tick ({p.noJudgment})</span>}
        {p.summary?.heartbeat && <span style={{ color: '#94a3b8' }}> · {p.summary.heartbeat}</span>}
      </div>
      {p.assessment && <div style={{ color: '#475569', marginTop: 2 }}>{p.assessment}</div>}
      {anomalies.length > 0 && (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {anomalies.map((a, i) => (
            <li key={i} style={{ color: sevColor(a.severity) }} title={a.evidence}>
              <strong>{a.severity}</strong> — {a.what}
            </li>
          ))}
        </ul>
      )}
      {asks.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ fontWeight: 700, color: '#334155' }}>Asks for you</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {asks.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        </div>
      )}
      {(p.cap?.set != null || p.policy?.set || p.gate_recommendation?.set) && (
        <div style={{ color: '#64748b', marginTop: 4 }}>
          {p.cap?.set != null && <span>cap → {p.cap.set} ({p.cap.reason}) </span>}
          {p.policy?.set && <span>policy → {p.policy.set.join(' › ')} ({p.policy.reason}) </span>}
          {p.gate_recommendation?.set && <span style={{ color: '#b45309' }}>gate recommended → {p.gate_recommendation.set.join(' + ')} ({p.gate_recommendation.reason}) — your call, use Dispatch</span>}
        </div>
      )}
    </div>
  );
}

/** 24 h at the 30-min cadence is ~48 ticks; 7 d is ~336 — the server keeps 7 days and serves at most 500. */
const HISTORY_PRESETS = {
  '24h': { label: '24 h', hours: 24, limit: 200 },
  '7d': { label: '7 d', hours: 24 * 7, limit: 500 },
} as const;
type HistoryPreset = keyof typeof HISTORY_PRESETS;

/**
 * The tick history behind a collapsed disclosure — how cap / claims / gate
 * / anomalies moved over a window, for "what happened last night" without
 * a terminal. Fetched only while open and kept in its own state: the
 * 60-s poll above must not pull hundreds of ticks for a table nobody has
 * expanded. A socket push (`fleetRev`) refetches while open so a tick
 * landing mid-read shows up.
 */
function TickHistory({ mapId, fleetRev, now }: { mapId: string | null; fleetRev: number; now: Date }) {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<HistoryPreset>('24h');
  const [history, setHistory] = useState<{ data: FleetResponse; preset: HistoryPreset } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The window is anchored on the SERVER clock estimate (the store filters
  // by received_at); read through a ref so the 30-s ticker does not refetch.
  const nowRef = useRef(now);
  nowRef.current = now;

  useEffect(() => {
    if (!open || !mapId) return;
    let cancelled = false;
    const { hours, limit } = HISTORY_PRESETS[preset];
    const since = new Date(nowRef.current.getTime() - hours * 3_600_000).toISOString();
    setLoading(true);
    api
      .fetchFleet(mapId, { since, limit })
      .then((r) => {
        if (cancelled) return;
        setHistory({ data: r, preset });
        setError(null);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : 'unavailable'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, mapId, preset, fleetRev]);

  const rows = useMemo<TickSummary[]>(() => (history ? [...history.data.ticks].reverse().map(summarizeTick) : []), [history]);
  const shown = history?.preset === preset ? history : null;
  const cut = shown?.data.window && shown.data.ticks.length >= shown.data.window.limit ? shown.data.window.limit : null;

  return (
    <div style={{ marginTop: 6, fontSize: 12 }}>
      <Link onClick={() => setOpen((o) => !o)}>
        <span style={{ color: '#94a3b8', fontSize: 10 }}>{open ? '▾' : '▸'}</span> Tick history
      </Link>
      {open && (
        <span style={{ marginLeft: 8 }}>
          {(Object.keys(HISTORY_PRESETS) as HistoryPreset[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPreset(p)}
              style={{
                ...pill,
                marginRight: 4,
                border: '1px solid #e2e8f0',
                cursor: 'pointer',
                background: p === preset ? '#e2e8f0' : '#fff',
                color: p === preset ? '#0f172a' : '#64748b',
              }}
            >
              {HISTORY_PRESETS[p].label}
            </button>
          ))}
          {loading && <span style={{ color: '#94a3b8' }}>loading…</span>}
        </span>
      )}
      {open && error && <div style={{ color: '#b45309' }}>Tick history unavailable ({error}).</div>}
      {open && !error && shown && rows.length === 0 && (
        <div style={{ color: '#94a3b8' }}>No ticks in the last {HISTORY_PRESETS[preset].label} — the orchestrator was not running, or its push is off.</div>
      )}
      {open && !error && shown && rows.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 4 }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 11, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
            <thead>
              <tr style={{ color: '#94a3b8', textAlign: 'left' }}>
                <th style={th}>Time</th>
                <th style={{ ...th, textAlign: 'right' }} title="active claims / maxActiveClaims">Claims</th>
                <th style={{ ...th, textAlign: 'right' }} title="pullable tickets inside the gate">In gate</th>
                <th style={{ ...th, textAlign: 'right' }} title="tickets still needing a brief">Brief</th>
                <th style={th}>Writes</th>
                <th style={th}>Anomalies (warn+)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t, i) => (
                <HistoryRow key={t.receivedAt + i} t={t} prev={rows[i - 1]} />
              ))}
            </tbody>
          </table>
          {cut !== null && <div style={{ color: '#94a3b8', marginTop: 2 }}>Newest {cut} ticks of the window — switch to 24 h for a finer read.</div>}
        </div>
      )}
    </div>
  );
}

function HistoryRow({ t, prev }: { t: TickSummary; prev: TickSummary | undefined }) {
  const d = new Date(t.at);
  const valid = !Number.isNaN(d.getTime());
  const prevDay = prev ? new Date(prev.at).toDateString() : '';
  const newDay = valid && d.toDateString() !== prevDay;
  const n = (v: number | null) => (v === null ? '–' : v);
  return (
    <tr style={{ borderTop: '1px solid #f1f5f9', color: t.noJudgment ? '#94a3b8' : '#334155' }}>
      <td style={td} title={t.at}>
        {newDay && <span style={{ color: '#94a3b8', marginRight: 4 }}>{d.toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>}
        {valid ? localHHMM(t.at) : t.at}
      </td>
      <td style={{ ...td, textAlign: 'right' }}>
        {n(t.claims)}/{n(t.cap)}
      </td>
      <td style={{ ...td, textAlign: 'right' }}>{n(t.pullableInGate)}</td>
      <td style={{ ...td, textAlign: 'right' }}>{n(t.needsBrief)}</td>
      <td style={td}>
        {t.capWrite && (
          <span style={{ ...pill, background: '#dbeafe', color: '#1e40af', marginRight: 4 }} title={t.capWrite.reason ?? undefined}>
            cap → {t.capWrite.set}
          </span>
        )}
        {t.policyWrite && (
          <span style={{ ...pill, background: '#ede9fe', color: '#5b21b6', marginRight: 4 }} title={t.policyWrite.reason ?? undefined}>
            policy → {t.policyWrite.set.join(' › ')}
          </span>
        )}
        {t.gateRecommendation && (
          <span style={{ color: '#b45309', marginRight: 4 }} title={t.gateRecommendation.reason ?? undefined}>
            gate? {t.gateRecommendation.set.join(' + ')}
          </span>
        )}
        {t.noJudgment && (
          <span style={{ ...pill, background: '#ffedd5', color: '#9a3412' }} title={t.noJudgment}>
            no judgment
          </span>
        )}
      </td>
      <td style={td}>
        {t.anomalies.map((a, i) => (
          <span key={i} style={{ color: sevColor(a.severity), marginRight: 6 }} title={a.evidence}>
            <strong>{a.severity}</strong> {a.what}
          </span>
        ))}
        {t.asksCount > 0 && <span style={{ color: '#64748b' }}>· {t.asksCount} ask{t.asksCount === 1 ? '' : 's'}</span>}
      </td>
    </tr>
  );
}

const th: React.CSSProperties = { padding: '1px 6px', fontWeight: 600, borderBottom: '1px solid #e2e8f0' };
const td: React.CSSProperties = { padding: '1px 6px', verticalAlign: 'top' };

const pill: React.CSSProperties = { display: 'inline-block', padding: '0 7px', borderRadius: 999, fontSize: 11, fontWeight: 600 };
