/**
 * Leidang fleet telemetry — the shapes the satellites and the orchestrator
 * push into MindBlown, and the pure reading of them the Fleet card shows.
 *
 * Ownership (Leidang design): the satellites own worker state, the
 * orchestrator owns the judgment. MindBlown is a RECEIVER of last-known
 * snapshots — it never derives fleet topology, never writes back, and a
 * missing or stale rollup is a signal, not an error. This module has no
 * I/O; the schema mirrors `leidang/agent/rollup.sh` (v1) and the
 * orchestrator's `decision.json`.
 */

// ── Fleet entity knobs (#477) ──────────────────────────────────

export const FLEET_SHARE_MIN = 0.1;
export const FLEET_SHARE_MAX = 100;
export const DEFAULT_FLEET_SHARE = 1;

/** A map's weight inside its fleet, clamped to 0.1–100; junk → 1. */
export function clampFleetShare(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return DEFAULT_FLEET_SHARE;
  return Math.min(FLEET_SHARE_MAX, Math.max(FLEET_SHARE_MIN, value));
}

/**
 * The map cap a connect leaves behind (#482). Picking a fleet means "take
 * care of this project", so a map still on hold (cap 0) opens to one
 * ticket at a time. A cap the caller sends in the same update wins, and a
 * map that already had a cap keeps it. Undefined = leave the cap alone.
 */
export function capOnFleetConnect(
  before: { fleetId: string | null | undefined; maxActiveClaims: number | null | undefined },
  input: { fleetId?: string | null; maxActiveClaims?: number },
): number | undefined {
  if (!input.fleetId || input.fleetId === before.fleetId) return undefined;
  if (input.maxActiveClaims !== undefined) return undefined;
  return (before.maxActiveClaims ?? 0) === 0 ? 1 : undefined;
}

// ── Fleet pull: which project's ticket wins (#478) ─────────────
//
// Smooth weighted round-robin (the nginx upstream scheme). Each grant,
// every map with a ticket to give earns its share; the winner is the map
// with the most credit and pays back the sum of the shares that took part.
// Shares 2:1 grant A, B, A, A, B, A… — interleaved, not bursts, and with no
// randomness, so the same state always picks the same map. A map that has
// nothing to give takes no part and keeps its credit as it was; it doesn't
// block the others and doesn't bank credit while it is idle.

/** Persisted credit per map id (fleets.pull_deficits). */
export type FleetPullDeficits = Record<string, number>;

/** Credit outside this band is clamped — a guard against drift, never reached in steady state. */
const DEFICIT_BOUND = 10_000;

const creditOf = (deficits: FleetPullDeficits, mapId: string): number => {
  const v = deficits[mapId];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};

/**
 * The maps in the order the fleet should try them: most credit after this
 * round's share first. Ties keep the input order (callers pass oldest map
 * first). The caller claims from the first map that still has a ticket.
 */
export function orderFleetPull<T extends { mapId: string; share: number }>(eligible: T[], deficits: FleetPullDeficits): T[] {
  return eligible
    .map((m, i) => ({ m, i, score: creditOf(deficits, m.mapId) + clampFleetShare(m.share) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.m);
}

/**
 * Credit after one actual grant to `winnerId`. Only maps in `eligible`
 * move; keys for maps no longer connected (`connectedIds`) are dropped.
 */
export function advanceFleetPull(
  deficits: FleetPullDeficits,
  eligible: Array<{ mapId: string; share: number }>,
  winnerId: string,
  connectedIds: string[],
): FleetPullDeficits {
  const keep = new Set(connectedIds);
  const next: FleetPullDeficits = {};
  for (const id of Object.keys(deficits)) if (keep.has(id)) next[id] = creditOf(deficits, id);
  let total = 0;
  for (const m of eligible) {
    const share = clampFleetShare(m.share);
    next[m.mapId] = creditOf(next, m.mapId) + share;
    total += share;
  }
  next[winnerId] = creditOf(next, winnerId) - total;
  for (const id of Object.keys(next)) next[id] = Math.max(-DEFICIT_BOUND, Math.min(DEFICIT_BOUND, next[id]));
  return next;
}

/** One worker, as `driver/claude-code/status.sh` reports it (status file v1). */
export interface FleetWorkerStatus {
  v?: number;
  /** Same string used as the MindBlown claim owner (`claimedBySession`). */
  session: string;
  worker?: string;
  pane?: string;
  runner?: string;
  /** Rollup v2 (#479): which agent runs this worker — `claude-code`, `qwen-code`, … Shown verbatim. */
  agent?: string;
  model?: string;
  account?: string;
  profile?: string;
  /** working | parked | limit-parked | auth-parked | prompt | clearing — anything else is shown verbatim. */
  state: string;
  state_since?: string | null;
  last_activity?: string | null;
  ctx_pct?: number | null;
  /**
   * `redacted` is set by the server on a read (#479): the claim is on a map
   * the reader can't view, so its map, node and title were removed.
   */
  claim?: { mapId?: string; nodeId?: string; title?: string; redacted?: true } | null;
  limit_reset_at?: string | null;
  /** Set by the satellite: state says working but nothing moved past the threshold. */
  derived_dead?: boolean;
  pr_number?: number | null;
  prompt_question?: string | null;
  waiting?: { since: string; reason: string } | null;
  blocked_nodes?: { node: string; at: string }[];
}

/**
 * One host's rollup (`rollup/<host>.json`). v1 is pushed per map and
 * serves that map; v2 (#479) is pushed once per fleet and names the maps
 * the host serves in `maps`. Everything else is shared.
 */
export interface FleetRollup {
  v: number;
  host: string;
  generated_at: string;
  map_id?: string;
  /** v2: the maps this host takes tickets from. */
  maps?: string[];
  /** Non-null = host is draining (DRAIN file), string = the reason. */
  draining?: string | null;
  workers: FleetWorkerStatus[];
  counts?: Record<string, number>;
  dead?: string[];
  blocked?: { count: number; recent: { node: string; at: string }[] };
}

/** The orchestrator's judgment for one tick (`decision.json`) plus the numbers it judged from. */
export interface FleetTickPayload {
  assessment?: string;
  cap?: { set: number | null; reason: string | null };
  policy?: { set: string[] | null; reason: string | null };
  gate_recommendation?: { set: string[] | null; reason: string | null };
  phase_recommendation?: { phase: string; why: string; gate?: string[]; policy?: string[] } | null;
  anomalies?: { severity: string; what: string; evidence?: string }[];
  asks?: string[];
  notify?: { title?: string; priority?: number } | null;
  /** Live numbers at tick time — from the orchestrator's own summary, not re-derived here. */
  summary?: {
    claims?: number;
    cap?: number;
    pullableInGate?: number;
    needsBrief?: number;
    workers?: Record<string, number>;
    heartbeat?: string;
  };
  /** Expected-vs-delivered per configured satellite (`pull-status.json`). */
  pullStatus?: { sat: string; ok: boolean; files: string[]; at?: string }[];
  /** Set when the tick ran without judgment (orchestrator account at its limit). */
  noJudgment?: string | null;
  /** Set by the server on a read (#479): the prose was removed for a reader who can't view every map of the fleet. */
  redacted?: true;
}

/** Mirrors the orchestrator/dashboard constant: older than this = host down, paused, or agent stopped. */
export const ROLLUP_STALE_MIN = 20;
/** A worker that says "working" but has not moved for this long is dead (status files cannot report their own death). */
export const WORKER_DEAD_MIN = 30;

/** Minimal shape check for an incoming rollup — enough to store and render, nothing more. */
export function parseRollup(x: unknown): FleetRollup | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Record<string, unknown>;
  if (typeof r.host !== 'string' || r.host.trim() === '') return null;
  if (typeof r.generated_at !== 'string' || Number.isNaN(Date.parse(r.generated_at))) return null;
  if (!Array.isArray(r.workers)) return null;
  const workers = r.workers.filter(
    (w): w is FleetWorkerStatus => !!w && typeof w === 'object' && typeof (w as FleetWorkerStatus).session === 'string' && typeof (w as FleetWorkerStatus).state === 'string',
  );
  const out: FleetRollup = { ...(r as unknown as FleetRollup), v: typeof r.v === 'number' ? r.v : 1, workers };
  if (r.maps !== undefined) {
    if (!Array.isArray(r.maps)) return null;
    out.maps = [...new Set(r.maps.filter((m): m is string => typeof m === 'string' && m !== ''))];
  }
  return out;
}

/**
 * The maps a rollup reports for: v2 names them; a v1 rollup serves the
 * single map it was pushed for (`pushedFor`, the map route's id).
 */
export function rollupServedMaps(rollup: FleetRollup, pushedFor: string | null): string[] {
  if (rollup.maps && rollup.maps.length > 0) return rollup.maps;
  const one = rollup.map_id ?? pushedFor;
  return one ? [one] : [];
}

/**
 * A rollup as a reader who can view only `visible` may see it (#479): maps
 * they can't view drop out of `maps`, and a claim on one becomes
 * `{ redacted: true }` — together with everything else that talks about
 * that ticket (the worker's prompt question, what it waits on, its PR,
 * the nodes it parked). A claim that names no map belongs to the host's
 * only served map, or to any of them when the reader sees them all; else
 * it can't be placed and is redacted too. Node lists that carry no map
 * (`blocked_nodes`, `blocked.recent`) stay only when the reader sees every
 * map the host serves.
 */
export function redactRollup(rollup: FleetRollup, served: string[], visible: ReadonlySet<string>): FleetRollup {
  const seesAll = served.length > 0 && served.every((m) => visible.has(m));
  const workers = rollup.workers.map((w) => {
    const out: FleetWorkerStatus = { ...w };
    if (w.claim) {
      const mapId = w.claim.mapId ?? (served.length === 1 ? served[0] : null);
      const placed = mapId ? visible.has(mapId) : seesAll;
      if (!placed) {
        out.claim = { redacted: true };
        delete out.prompt_question;
        delete out.waiting;
        delete out.pr_number;
        delete out.blocked_nodes;
      }
    }
    if (!seesAll) delete out.blocked_nodes;
    return out;
  });
  const out: FleetRollup = { ...rollup, workers };
  if (rollup.maps) out.maps = rollup.maps.filter((m) => visible.has(m));
  if (rollup.map_id && !visible.has(rollup.map_id)) delete out.map_id;
  if (!seesAll && rollup.blocked) out.blocked = { count: rollup.blocked.count, recent: [] };
  return out;
}

/**
 * A tick as a reader who can't view every map of the fleet may see it
 * (#479): one orchestrator writes about all projects, so its prose —
 * assessment, anomalies, asks, recommendations, reasons, the files it
 * pulled — stays with readers who see them all. The numbers stay.
 */
export function redactTick(payload: FleetTickPayload): FleetTickPayload {
  const out: FleetTickPayload = { redacted: true };
  if (payload.summary) out.summary = payload.summary;
  if (payload.cap) out.cap = { set: payload.cap.set, reason: null };
  if (payload.policy) out.policy = { set: payload.policy.set, reason: null };
  if (payload.noJudgment !== undefined) out.noJudgment = payload.noJudgment;
  if (payload.pullStatus) out.pullStatus = payload.pullStatus.map((p) => ({ sat: p.sat, ok: p.ok, files: [], ...(p.at ? { at: p.at } : {}) }));
  return out;
}

/** Minimal shape check for an incoming tick. */
export function parseTick(x: unknown): FleetTickPayload | null {
  if (!x || typeof x !== 'object') return null;
  const t = x as Record<string, unknown>;
  const out: FleetTickPayload = { ...(t as FleetTickPayload) };
  if (out.anomalies !== undefined && !Array.isArray(out.anomalies)) out.anomalies = [];
  if (out.asks !== undefined && !Array.isArray(out.asks)) out.asks = [];
  return out;
}

function minutesBetween(later: Date, earlier: Date): number {
  return Math.max(0, (later.getTime() - earlier.getTime()) / 60_000);
}

export interface HostFreshness {
  /** Minutes since the OLDER of generated_at / received_at — a skewed satellite clock cannot look fresh. */
  ageMin: number;
  stale: boolean;
}

export function hostFreshness(generatedAt: string, receivedAt: string, now: Date, staleMin = ROLLUP_STALE_MIN): HostFreshness {
  const g = new Date(generatedAt);
  const r = new Date(receivedAt);
  const ages = [g, r].filter((d) => !Number.isNaN(d.getTime())).map((d) => minutesBetween(now, d));
  const ageMin = ages.length > 0 ? Math.max(...ages) : Number.POSITIVE_INFINITY;
  return { ageMin, stale: ageMin > staleMin };
}

/** Dead = the satellite said so, or "working" with no activity past the threshold. */
export function isWorkerDead(w: FleetWorkerStatus, now: Date, deadMin = WORKER_DEAD_MIN): boolean {
  if (w.derived_dead) return true;
  if (w.state !== 'working' || !w.last_activity) return false;
  const last = new Date(w.last_activity);
  if (Number.isNaN(last.getTime())) return false;
  return minutesBetween(now, last) > deadMin;
}

/** Display state: the satellite's word, or `dead` when staleness says otherwise. */
export function effectiveWorkerState(w: FleetWorkerStatus, now: Date): string {
  return isWorkerDead(w, now) ? 'dead' : w.state;
}

export interface HostSummary {
  host: string;
  generatedAt: string;
  receivedAt: string;
  freshness: HostFreshness;
  draining: string | null;
  workers: FleetWorkerStatus[];
  /** Effective states (dead derived) → count. */
  counts: Record<string, number>;
  claims: number;
}

export interface FleetSummary {
  hosts: HostSummary[];
  /** Effective state → count across fresh hosts only; stale hosts are listed but not counted as capacity. */
  totals: Record<string, number>;
  /** Workers on fresh (reporting) hosts. */
  workersTotal: number;
  /** Workers on stale hosts — last seen, not capacity. */
  staleWorkers: number;
  working: number;
  /** Fresh hosts / all hosts. */
  freshHosts: number;
  staleHosts: string[];
}

/**
 * The fleet as MindBlown last saw it. Stale hosts keep their rows (a PM
 * wants to see what was there) but do not count toward capacity — the
 * orchestrator treats a stale rollup as host-down and so does this.
 */
export function summarizeFleet(
  rows: { rollup: FleetRollup; receivedAt: string }[],
  now: Date,
  staleMin = ROLLUP_STALE_MIN,
): FleetSummary {
  const hosts: HostSummary[] = rows
    .map(({ rollup, receivedAt }) => {
      const counts: Record<string, number> = {};
      let claims = 0;
      for (const w of rollup.workers) {
        const s = effectiveWorkerState(w, now);
        counts[s] = (counts[s] ?? 0) + 1;
        if (w.claim && (w.claim.nodeId || w.claim.title || w.claim.redacted)) claims += 1;
      }
      return {
        host: rollup.host,
        generatedAt: rollup.generated_at,
        receivedAt,
        freshness: hostFreshness(rollup.generated_at, receivedAt, now, staleMin),
        draining: rollup.draining ?? null,
        workers: rollup.workers,
        counts,
        claims,
      };
    })
    .sort((a, b) => a.host.localeCompare(b.host));

  const totals: Record<string, number> = {};
  let workersTotal = 0;
  let staleWorkers = 0;
  for (const h of hosts) {
    if (h.freshness.stale) {
      staleWorkers += h.workers.length;
      continue;
    }
    for (const [s, n] of Object.entries(h.counts)) {
      totals[s] = (totals[s] ?? 0) + n;
      workersTotal += n;
    }
  }
  return {
    hosts,
    totals,
    workersTotal,
    staleWorkers,
    working: totals.working ?? 0,
    freshHosts: hosts.filter((h) => !h.freshness.stale).length,
    staleHosts: hosts.filter((h) => h.freshness.stale).map((h) => h.host),
  };
}

export type SilentReason =
  /** ssh to the satellite failed — host down or unreachable. */
  | 'unreachable'
  /** ssh fine, but the satellite had no rollup file — agent not running. */
  | 'no-rollup'
  /** Delivered to the orchestrator (scp) but nothing reached MindBlown — sender patch not rolled out there yet. Mild. */
  | 'not-pushing';

/**
 * Configured satellites that are not accounted for — invisible unless
 * named (2026-07-26: sat2 ran six workers unseen). `pullStatus` is the
 * orchestrator's scp channel; `knownHosts` is who pushed to MindBlown.
 * The two channels differ, so "delivered by scp but not pushed" is its own,
 * mild category and never the red one.
 */
export function silentSatellites(
  pullStatus: FleetTickPayload['pullStatus'] | undefined,
  knownHosts: string[],
): { sat: string; reason: SilentReason }[] {
  if (!pullStatus) return [];
  const known = new Set(knownHosts.map((h) => `${h}.json`));
  const out: { sat: string; reason: SilentReason }[] = [];
  for (const p of pullStatus) {
    if (!p.ok) out.push({ sat: p.sat, reason: 'unreachable' });
    else if (p.files.length === 0) out.push({ sat: p.sat, reason: 'no-rollup' });
    else if (!p.files.some((f) => known.has(f))) out.push({ sat: p.sat, reason: 'not-pushing' });
  }
  return out;
}

/**
 * The client's best estimate of the server clock: the `now` the last
 * response carried, advanced by the time elapsed since THAT fetch. Both
 * values must come from the same fetch — pairing a fresh server time with
 * the first fetch's timestamp double-counts the page's whole uptime.
 */
export function estimateServerNow(serverNowIso: string, fetchedAtMs: number, nowMs: number): Date {
  const serverNow = Date.parse(serverNowIso);
  if (Number.isNaN(serverNow)) return new Date(nowMs);
  return new Date(serverNow + Math.max(0, nowMs - fetchedAtMs));
}

// ── Tick history ──────────────────────────────────────────────────
//
// The Fleet card and `fleet_status` show only the latest tick; the history
// answers "what happened last night" without a terminal. Both read the
// same flattening (`summarizeTick`) and the same window rules
// (`parseTickWindow`) so a limit clamped on one surface is clamped on all.

/** Ticks a plain read returns (the Fleet card renders `ticks[0]`, the rest is context). */
export const TICK_WINDOW_DEFAULT_LIMIT = 20;
/** Ticks a `since` read returns by default — 7 days at the 30-min cadence is 336. */
export const TICK_HISTORY_DEFAULT_LIMIT = 500;
/**
 * Hard ceiling per read. Covers 7 days at the 30-min cadence (336); the
 * store's row cap (2000) is higher, so a faster orchestrator can hold more
 * than one read returns — the readers say "newest N only" when that happens.
 */
export const TICK_WINDOW_MAX_LIMIT = 500;

export interface TickWindow {
  since: Date | null;
  until: Date | null;
  limit: number;
}

/**
 * Validate a history window from untrusted query/tool input. Unparsable
 * dates and non-numeric limits are errors (a silently ignored `since`
 * would hand the caller 20 recent ticks and look like "nothing happened
 * last night"); an out-of-range limit is clamped, not refused.
 */
export function parseTickWindow(q: { since?: unknown; until?: unknown; limit?: unknown }): TickWindow | { error: string } {
  const date = (v: unknown, name: string): Date | null | { error: string } => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') return { error: `${name} must be a single ISO 8601 timestamp` };
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return { error: `${name} must be an ISO 8601 timestamp, got "${v}"` };
    return d;
  };
  const since = date(q.since, 'since');
  if (since && 'error' in since) return since;
  const until = date(q.until, 'until');
  if (until && 'error' in until) return until;
  let limit = since ? TICK_HISTORY_DEFAULT_LIMIT : TICK_WINDOW_DEFAULT_LIMIT;
  if (q.limit !== undefined && q.limit !== null && q.limit !== '') {
    const n = typeof q.limit === 'number' ? q.limit : typeof q.limit === 'string' ? Number(q.limit) : Number.NaN;
    if (!Number.isFinite(n)) return { error: `limit must be a number, got "${String(q.limit)}"` };
    limit = Math.min(TICK_WINDOW_MAX_LIMIT, Math.max(1, Math.trunc(n)));
  }
  return { since, until, limit };
}

/** critical > warn/warning > everything else (info, note, …). */
export function severityRank(severity: string): number {
  const s = severity.toLowerCase();
  if (s === 'critical') return 2;
  if (s === 'warn' || s === 'warning') return 1;
  return 0;
}

export interface TickSummary {
  /** The orchestrator's tick time (display; clamped to now by the server). */
  at: string;
  /** Server clock at receipt — what the window filters and orders by. */
  receivedAt: string;
  claims: number | null;
  cap: number | null;
  pullableInGate: number | null;
  needsBrief: number | null;
  heartbeat: string | null;
  noJudgment: string | null;
  /** Non-null only when the orchestrator actually wrote the cap this tick. */
  capWrite: { set: number; reason: string | null } | null;
  policyWrite: { set: string[]; reason: string | null } | null;
  gateRecommendation: { set: string[]; reason: string | null } | null;
  /** warn/warning/critical only, worst first — info-level noise would drown a 7-day table. */
  anomalies: { severity: string; what: string; evidence?: string }[];
  asksCount: number;
  assessment: string | null;
}

/** Flatten one stored tick into what a history row needs. Pure; tolerant of partial payloads. */
export function summarizeTick(tick: { tickAt: string; receivedAt: string; payload: FleetTickPayload }): TickSummary {
  const p = tick.payload;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const anomalies = (p.anomalies ?? [])
    .filter((a) => a && typeof a.severity === 'string' && severityRank(a.severity) > 0)
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  return {
    at: tick.tickAt,
    receivedAt: tick.receivedAt,
    claims: num(p.summary?.claims),
    cap: num(p.summary?.cap),
    pullableInGate: num(p.summary?.pullableInGate),
    needsBrief: num(p.summary?.needsBrief),
    heartbeat: p.summary?.heartbeat ?? null,
    noJudgment: p.noJudgment ?? null,
    capWrite: p.cap && typeof p.cap.set === 'number' ? { set: p.cap.set, reason: p.cap.reason ?? null } : null,
    policyWrite: p.policy?.set ? { set: p.policy.set, reason: p.policy.reason ?? null } : null,
    gateRecommendation: p.gate_recommendation?.set ? { set: p.gate_recommendation.set, reason: p.gate_recommendation.reason ?? null } : null,
    anomalies,
    asksCount: (p.asks ?? []).length,
    assessment: p.assessment ?? null,
  };
}
