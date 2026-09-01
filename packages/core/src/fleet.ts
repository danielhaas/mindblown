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

/** One worker, as `driver/claude-code/status.sh` reports it (status file v1). */
export interface FleetWorkerStatus {
  v?: number;
  /** Same string used as the MindBlown claim owner (`claimedBySession`). */
  session: string;
  worker?: string;
  pane?: string;
  runner?: string;
  model?: string;
  account?: string;
  profile?: string;
  /** working | parked | limit-parked | auth-parked | prompt | clearing — anything else is shown verbatim. */
  state: string;
  state_since?: string | null;
  last_activity?: string | null;
  ctx_pct?: number | null;
  claim?: { mapId?: string; nodeId?: string; title?: string } | null;
  limit_reset_at?: string | null;
  /** Set by the satellite: state says working but nothing moved past the threshold. */
  derived_dead?: boolean;
  pr_number?: number | null;
  prompt_question?: string | null;
  waiting?: { since: string; reason: string } | null;
  blocked_nodes?: { node: string; at: string }[];
}

/** One host's rollup (`rollup/<host>.json`, v1). */
export interface FleetRollup {
  v: number;
  host: string;
  generated_at: string;
  map_id?: string;
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
  return { ...(r as unknown as FleetRollup), v: typeof r.v === 'number' ? r.v : 1, workers };
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
  workersTotal: number;
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
        if (w.claim && (w.claim.nodeId || w.claim.title)) claims += 1;
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
  for (const h of hosts) {
    if (h.freshness.stale) continue;
    for (const [s, n] of Object.entries(h.counts)) {
      totals[s] = (totals[s] ?? 0) + n;
      workersTotal += n;
    }
  }
  return {
    hosts,
    totals,
    workersTotal,
    working: totals.working ?? 0,
    freshHosts: hosts.filter((h) => !h.freshness.stale).length,
    staleHosts: hosts.filter((h) => h.freshness.stale).map((h) => h.host),
  };
}

/**
 * Configured satellites that delivered nothing this tick — invisible
 * unless named (2026-07-26: sat2 ran six workers unseen). From the
 * orchestrator's pull-status; hosts are matched by rollup file name.
 */
export function silentSatellites(
  pullStatus: FleetTickPayload['pullStatus'] | undefined,
  knownHosts: string[],
): { sat: string; reason: 'unreachable' | 'no-rollup' }[] {
  if (!pullStatus) return [];
  const known = new Set(knownHosts.map((h) => `${h}.json`));
  return pullStatus
    .filter((p) => !p.ok || !p.files.some((f) => known.has(f)))
    .map((p) => ({ sat: p.sat, reason: p.ok ? 'no-rollup' : 'unreachable' }));
}
