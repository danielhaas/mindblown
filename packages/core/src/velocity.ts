/**
 * Velocity & capacity helpers.
 *
 * The **focus factor** models the fraction of a worker's calendar time that
 * actually reaches planned-ticket work. Meetings, support, firefighting and
 * unplanned tickets all eat into a day — a team that spends half its time on
 * planned work has a focus factor of 0.5, so the same estimated effort takes
 * twice as long in calendar terms.
 *
 * It is orthogonal to the estimation *fudge factor* (actual/estimate): the
 * fudge factor corrects how a ticket is *sized*, the focus factor corrects how
 * much sizing gets *delivered* per calendar day. A realistic completion
 * forecast applies both:
 *
 *     calendarDays = schedulerDays × fudgeFactor ÷ focusFactor
 *
 * Default 1.0 = no capacity leakage (the historical behaviour — every existing
 * map forecasts exactly as before until its focus factor is set).
 */

export const FOCUS_FACTOR_MIN = 0.05;
export const FOCUS_FACTOR_MAX = 1;
export const DEFAULT_FOCUS_FACTOR = 1;

/**
 * Clamp a focus factor to the sane range (0.05, 1]. A factor above 1 would
 * mean spending more than 100% of calendar time on planned work (that's the
 * fudge factor's job, not this knob); a factor at/below 0 would blow up the
 * `÷ focusFactor` division. Non-finite / missing values fall back to the
 * default (1.0 = no effect).
 */
export function clampFocusFactor(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return DEFAULT_FOCUS_FACTOR;
  return Math.min(FOCUS_FACTOR_MAX, Math.max(FOCUS_FACTOR_MIN, value));
}

/**
 * Capacity-based calendar projection for a **scoped** forecast (a version /
 * milestone or a subtree), from now.
 *
 * The whole-map completion forecast runs the critical-path scheduler over the
 * entire map and reads a scope's finish off where its leaves land in that
 * global ordering. For a *scoped* forecast that is wrong: the milestone's
 * leaves get buried behind the entire backlog, so the date reflects the
 * backlog's size, not the milestone's. When you commit to a milestone you work
 * *it*, so the honest projection is its own remaining effort against the team's
 * capacity:
 *
 *     plannedCalendarDays  = remaining ÷ (workers × unitsPerDay)
 *     velocityCalendarDays = remaining × fudge ÷ (workers × unitsPerDay × focus)
 *
 * Both are measured from today (the work is ahead of you). This intentionally
 * ignores within-scope dependency chains — a milestone with a long serial
 * critical path can run longer than pure capacity implies; that refinement can
 * schedule the isolated subtree later. It is still far closer than the
 * backlog-buried scheduler position it replaces.
 */
export interface ScopedCapacityInput {
  workers: number;
  unitsPerDay: number;
  fudge: number;
  focusFactor: number;
}

export function scopedCapacityDays(
  remainingEffort: number,
  opts: ScopedCapacityInput,
): { plannedCalendarDays: number; velocityCalendarDays: number } {
  const capacityPerDay = Math.max(1e-9, opts.workers * opts.unitsPerDay);
  const focus = clampFocusFactor(opts.focusFactor);
  const rem = Math.max(0, remainingEffort);
  return {
    plannedCalendarDays: rem / capacityPerDay,
    velocityCalendarDays: (rem * opts.fudge) / (capacityPerDay * focus),
  };
}

// ── Repo throughput: net-of-rework rate + review latency ──────────
//
// The MindBlown velocity above measures *gross* completion — effort marked
// done per calendar day. In an agent-fleet workflow that overstates real
// progress two ways, both visible in the connected repo's merged-PR stream:
//
//  1. **Rework.** A large share of merges are corrections of work that was
//     already "done" (fix/revert/follow-up PRs). Counting those as progress
//     inflates the rate. Net-new rate = gross × (1 − reworkFraction).
//  2. **Review latency.** open→merged time is the human-review-plus-CI wait;
//     usually short, but spikes when the reviewer is offline. Reported as a
//     separate signal (it paces delivery but isn't a rework loss).
//
// v1 detects rework by signal, not file-overlap: a merged PR is rework if its
// title/body carries a correction keyword OR references (#NNN) another PR that
// also merged in the window. That is "same work-item", cheap (no per-PR file
// fetch), and tighter than a bare keyword match. File-level same-area is a
// documented follow-up refinement.

/** Correction-intent keywords in a PR title/body → likely rework. */
const REWORK_KEYWORD = /\b(fix|fixup|hotfix|revert|reverts|redo|rework|re-?work|follow-?ups?|followup|regress\w*|correct\w*|amend|nit|nits)\b/i;

/** PRs merged more than this many hours after opening = reviewer likely offline. */
export const OFFLINE_MERGE_HOURS = 6;

export interface PrRecord {
  number: number;
  title: string;
  body?: string | null;
  createdAt: string; // ISO 8601
  mergedAt: string; // ISO 8601
}

export interface RepoThroughput {
  merged: number;
  /** open→merged latency (review + CI), hours. */
  medianLatencyHours: number;
  meanLatencyHours: number;
  maxLatencyHours: number;
  /** merges that waited > OFFLINE_MERGE_HOURS (reviewer offline). */
  offlineMergeCount: number;
  reworkCount: number;
  /** 0–1 share of merged PRs that are corrections of prior work. */
  reworkFraction: number;
}

function referencedNumbers(pr: PrRecord): number[] {
  const out: number[] = [];
  const re = /#(\d+)/g;
  const text = `${pr.title}\n${pr.body ?? ''}`;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(Number(m[1]));
  return out;
}

/**
 * Analyse the merged-PR stream for review latency and rework share.
 *
 * `prs` should be the PRs that merged inside the measurement window. Rework is
 * self-referential to that set: a PR referencing another merged PR in the same
 * window is a follow-up on recent work.
 */
export function analyzeRepoThroughput(prs: PrRecord[]): RepoThroughput {
  const mergedSet = new Set(prs.map((p) => p.number));

  const latencies: number[] = [];
  let offline = 0;
  let rework = 0;
  for (const pr of prs) {
    const openMs = Date.parse(pr.createdAt);
    const mergeMs = Date.parse(pr.mergedAt);
    if (Number.isFinite(openMs) && Number.isFinite(mergeMs) && mergeMs >= openMs) {
      const hours = (mergeMs - openMs) / 3_600_000;
      latencies.push(hours);
      if (hours > OFFLINE_MERGE_HOURS) offline++;
    }
    const keyword = REWORK_KEYWORD.test(pr.title) || REWORK_KEYWORD.test(pr.body ?? '');
    const refsRecent = referencedNumbers(pr).some(
      (n) => n !== pr.number && mergedSet.has(n),
    );
    if (keyword || refsRecent) rework++;
  }

  latencies.sort((a, b) => a - b);
  const n = latencies.length;
  const median = n === 0 ? 0 : n % 2 ? latencies[(n - 1) / 2] : (latencies[n / 2 - 1] + latencies[n / 2]) / 2;
  const mean = n === 0 ? 0 : latencies.reduce((s, x) => s + x, 0) / n;
  const max = n === 0 ? 0 : latencies[n - 1];

  return {
    merged: prs.length,
    medianLatencyHours: median,
    meanLatencyHours: mean,
    maxLatencyHours: max,
    offlineMergeCount: offline,
    reworkCount: rework,
    reworkFraction: prs.length === 0 ? 0 : rework / prs.length,
  };
}

/** Net-of-rework delivery rate: gross × (1 − reworkFraction). */
export function netDeliveryRate(grossRatePerDay: number, reworkFraction: number): number {
  const f = Math.min(1, Math.max(0, reworkFraction));
  return Math.max(0, grossRatePerDay) * (1 - f);
}
