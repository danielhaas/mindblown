/**
 * Landing-page computations for the Stakeholder digest and the PM cockpit.
 *
 * Pure functions over data the frontend already holds (nodes, computed,
 * versions, cycles, release forecast, change events, triage decisions) —
 * no new server computation. Persona Round 1 (2026-08-26) showed the
 * answers exist in the data; they were just never assembled on one screen.
 * Each function answers one question the persona asked, in its words.
 */
import type { Node, ComputedNodeValues, Cycle, Priority } from '@mindblown/core';
import { effectiveVersionId } from '@mindblown/core';
import type { ReleaseForecastRow, TriageDecision } from './api.js';
import { isLeafDone } from './viewScope.js';

export type StatusCategory = 'todo' | 'in_progress' | 'done';
export type CategoryOf = (node: Node) => StatusCategory;

/**
 * Open = not done by the shared either/or rule (status category OR 100 %).
 * Every filter on this page goes through here — a leaf at 100 % with a
 * never-set status is finished, whatever its category says (#332).
 */
function isOpen(node: Node, categoryOf: CategoryOf): boolean {
  return !isLeafDone(node, categoryOf(node));
}

const DAY = 86_400_000;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso.slice(0, 10)) - Date.parse(fromIso.slice(0, 10))) / DAY);
}

/** Leaves = nodes nobody points at as parent. */
export function leavesOf(nodes: Record<string, Node>): Node[] {
  const parents = new Set<string>();
  for (const n of Object.values(nodes)) if (n.parentId) parents.add(n.parentId);
  return Object.values(nodes).filter((n) => !parents.has(n.id));
}

export function breadcrumb(nodes: Record<string, Node>, node: Node, maxParts = 2): string {
  const parts: string[] = [];
  let cur = node.parentId ? nodes[node.parentId] : undefined;
  while (cur && cur.parentId && parts.length < maxParts) {
    parts.unshift(cur.text);
    cur = nodes[cur.parentId];
  }
  return parts.join(' › ');
}

// ── Release headline (stakeholder Q1/Q2) ─────────────────────────────

export interface ReleaseVerdict {
  level: 'on_track' | 'at_risk' | 'behind' | 'unknown';
  /** One sentence a non-PM can repeat on a call. */
  headline: string;
  /** Plain-word reasons, most important first. */
  reasons: string[];
}

/**
 * The release a stakeholder means by "the next one": the unreleased version
 * with the nearest target date, past targets first (they are the loudest
 * problem — persona found MVP's target 15 days gone and still "active").
 */
export function nextRelease(rows: ReleaseForecastRow[], today: Date = new Date()): ReleaseForecastRow | null {
  return openReleases(rows, today)[0] ?? null;
}

/**
 * Every open release the stakeholder should see, loudest first: overdue
 * ones (latest target first), then upcoming by target date, then undated
 * by sort order. Round 2 (Thomas): "give me a row per open release, not
 * just the loudest one" — MVP was 15 days late and hid V1.5 completely.
 */
export function openReleases(rows: ReleaseForecastRow[], today: Date = new Date()): ReleaseForecastRow[] {
  const open = rows.filter(
    (r) => (r.versionStatus === 'active' || r.versionStatus === 'planning') && (r.remainingTickets > 0 || r.leaves === 0),
  );
  const dated = open.filter((r) => r.targetDate).sort((a, b) => a.targetDate!.localeCompare(b.targetDate!));
  const t = isoDay(today);
  const overdue = dated.filter((r) => r.targetDate! < t).reverse();
  const upcoming = dated.filter((r) => r.targetDate! >= t);
  const undated = open.filter((r) => !r.targetDate).sort((a, b) => a.sortOrder - b.sortOrder);
  return [...overdue, ...upcoming, ...undated];
}

export function releaseVerdict(row: ReleaseForecastRow, today: Date = new Date()): ReleaseVerdict {
  const forecast = row.velocityAdjustedFinishDate ?? row.plannedFinishDate;
  const reasons: string[] = [];
  const t = isoDay(today);

  if (row.remainingTickets === 0) {
    return { level: 'on_track', headline: `${row.versionName}: all work is done.`, reasons };
  }
  if (row.targetDate && row.targetDate < t) {
    reasons.push(`Target ${row.targetDate} is ${daysBetween(row.targetDate, t)} days gone and ${row.remainingTickets} tasks are still open.`);
  }
  if (row.unestimatedOpenLeaves > 0) {
    const share = row.leaves ? Math.round((row.unestimatedOpenLeaves / Math.max(1, row.remainingTickets)) * 100) : 0;
    reasons.push(`${row.unestimatedOpenLeaves} of ${row.remainingTickets} open tasks have no effort estimate (${share}%) — the forecast can only be a floor.`);
  }
  if (row.confidence.level === 'caution' && row.confidence.divergenceDays !== null) {
    reasons.push(`Two forecast models disagree by ${Math.abs(row.confidence.divergenceDays)} days.`);
  }

  if (!forecast || !row.targetDate) {
    return {
      level: 'unknown',
      headline: forecast
        ? `${row.versionName}: forecast ${forecast}, no target date set.`
        : `${row.versionName}: no forecast possible yet.`,
      reasons,
    };
  }

  const slip = daysBetween(row.targetDate, forecast);
  if (slip > 0) {
    reasons.unshift(`Forecast ${forecast} is ${slip} days after the target ${row.targetDate}.`);
    return { level: 'behind', headline: `${row.versionName}: behind — forecast ${forecast}, target ${row.targetDate}.`, reasons };
  }
  const shaky = row.confidence.level !== 'agree' || row.unestimatedOpenLeaves > row.remainingTickets / 4;
  if (shaky) {
    return { level: 'at_risk', headline: `${row.versionName}: on target ${row.targetDate} on paper, but the forecast is not trustworthy yet.`, reasons };
  }
  return { level: 'on_track', headline: `${row.versionName}: on track for ${row.targetDate} (forecast ${forecast}).`, reasons };
}

/** "Did the date move since last week?" — from the 7-day snapshot trend. */
export function weeklyDelta(row: ReleaseForecastRow): string | null {
  const d = row.velocityFinishDeltaDays7d ?? row.plannedFinishDeltaDays7d;
  if (d === null) return null;
  if (d === 0) return 'unchanged since last week';
  return d > 0 ? `slipped ${d} days since last week` : `pulled in ${-d} days since last week`;
}

// ── Threats (stakeholder Q2, PM escalation) ──────────────────────────

export interface Threat {
  text: string;
  nodeId: string | null;
  /** Effort in planning units, for the caller to render in the reader's vocabulary. */
  effort: number | null;
}

// ── Effort in a stakeholder's vocabulary ─────────────────────────────

/**
 * Planning units per calendar day the team actually burns. Measured rate
 * first (netEffortPerDay from the change log); otherwise the configured
 * capacity × focus factor. Stakeholders never see raw units: "15d" reads
 * as three working weeks to them while an agent fleet burns it in two days
 * (Dan, 26.08.).
 */
export function paceRate(f: {
  netEffortPerDay?: number | null;
  dailyCapacity: number;
  focusFactor: number;
}): { rate: number; measured: boolean } | null {
  if (f.netEffortPerDay && f.netEffortPerDay > 0) return { rate: f.netEffortPerDay, measured: true };
  const configured = f.dailyCapacity * (f.focusFactor || 1);
  return configured > 0 ? { rate: configured, measured: false } : null;
}

/** "≈ 3 calendar days at the current pace" — never a planning unit. */
export function calendarAtPace(effort: number, rate: number | null): string {
  if (!rate || effort <= 0) return '';
  const days = effort / rate;
  if (days < 0.75) return 'under a day at the current pace';
  const n = Math.round(days);
  if (n >= 14) return `≈ ${Math.round(n / 7)} weeks at the current pace`;
  return `≈ ${n} calendar day${n === 1 ? '' : 's'} at the current pace`;
}

/**
 * Top threats to a version, from what the persona actually flagged:
 * big blocked chunks still counted, unowned wrap-up work, unestimated bulk.
 */
export function threats(
  nodes: Record<string, Node>,
  computed: Map<string, ComputedNodeValues>,
  categoryOf: CategoryOf,
  versionId: string | null,
  limit = 3,
): Threat[] {
  const inScope = leavesOf(nodes).filter((n) => isOpen(n, categoryOf) && (!versionId || inVersion(nodes, n, versionId)));
  const out: Threat[] = [];

  const blockedBig = inScope
    .filter((n) => computed.get(n.id)?.isBlocked && (n.effortEstimate ?? 0) > 0)
    .sort((a, b) => (b.effortEstimate ?? 0) - (a.effortEstimate ?? 0));
  for (const n of blockedBig.slice(0, 2)) {
    out.push({ text: `${n.text} is blocked but still counted: ${n.blockedReason ?? 'waiting on a predecessor'}`, nodeId: n.id, effort: n.effortEstimate });
  }

  // "No owner" is only a signal on maps that assign work at all. On the
  // Fulcrum map 2 of 4,900 nodes carry an assignee, so this line would be
  // true for every release forever (Round 2, Thomas) — gate it on usage.
  const allOpen = leavesOf(nodes).filter((n) => isOpen(n, categoryOf));
  const assigned = allOpen.filter((n) => n.assigneeIds.length > 0 || n.claimedBySession).length;
  const assignmentInUse = assigned >= Math.max(3, allOpen.length * 0.05);
  const unowned = inScope.filter((n) => (n.priority === 'P0' || n.priority === 'P1') && n.assigneeIds.length === 0 && !n.claimedBySession);
  if (assignmentInUse && unowned.length) {
    out.push({ text: `${unowned.length} high-priority tasks have no owner`, nodeId: unowned[0].id, effort: null });
  }

  const unestimated = inScope.filter((n) => n.effortEstimate === null);
  if (unestimated.length >= Math.max(3, inScope.length / 4)) {
    out.push({ text: `${unestimated.length} of ${inScope.length} open tasks have no estimate — the finish date is a guess`, nodeId: null, effort: null });
  }
  return out.slice(0, limit);
}

/** Same membership rule as the server release forecast: nearest tagged ancestor wins. */
export function inVersion(nodes: Record<string, Node>, node: Node, versionId: string): boolean {
  return effectiveVersionId(node.id, new Map(Object.entries(nodes))) === versionId;
}

// ── Recently done (stakeholder Q3) ───────────────────────────────────

export function recentlyDone(
  nodes: Record<string, Node>,
  categoryOf: CategoryOf,
  days = 14,
  today: Date = new Date(),
  limit = 5,
): Node[] {
  const since = today.getTime() - days * DAY;
  // completedAt only — the server stamps it on every done-transition (status
  // OR 100 %, so a 100 % leaf with no status carries one too). Falling back
  // to updatedAt ranked tickets somebody re-saved this morning above the
  // things actually finished (Round 2, Thomas).
  return leavesOf(nodes)
    .filter((n) => !isOpen(n, categoryOf) && n.completedAt)
    .map((n) => ({ n, at: Date.parse(n.completedAt!) }))
    .filter((x) => x.at >= since)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((x) => x.n);
}

// ── Scope growth (stakeholder Q4, PM "slipped") ──────────────────────

export interface ChangeEventLite {
  eventType: string;
  fieldName: string | null;
  oldValue: unknown;
  newValue: unknown;
  nodeId: string | null;
  createdAt: string;
}

/** The burnup accounting for one bucket of events. */
export interface ScopeTotals {
  created: number;
  deleted: number;
  /** Effort that entered the plan: estimates of nodes created in the window + upward estimate edits. */
  effortAdded: number;
  /** Effort that left: estimates of nodes deleted in the window + downward estimate edits. */
  effortRemoved: number;
  /** Net, same sign convention as the burnup tool. */
  effortDelta: number;
}

export interface ScopeGrowth extends ScopeTotals {
  /** Nodes moved *into* `versionId` in the window (promotions). */
  promoted: string[];
  /** Promotions into every version, so a slip can be explained (Round 2: "V1 +126d because 27 tickets were promoted into it"). */
  promotedByVersion: Record<string, string[]>;
  /**
   * The same accounting restricted to events whose node sits in `versionId`
   * (inherited membership, see `inVersion`). null when no version is focused
   * or the caller passed no `nodes` to resolve against — then the map-wide
   * figures above are all there is.
   */
  forVersion: ScopeTotals | null;
  /**
   * Events whose node resolves to no release at all: the node is gone and
   * its delete snapshot predates the `versionId` field, or nothing in its
   * parent chain is tagged. Counted, not dropped — the sum of every version
   * bucket plus this one is the map-wide total (#333).
   */
  unattributed: ScopeTotals;
}

export function emptyScopeTotals(): ScopeTotals {
  return { created: 0, deleted: 0, effortAdded: 0, effortRemoved: 0, effortDelta: 0 };
}

/** Where the version resolver can start for one event. */
interface EventAttribution {
  /** Explicit version stamped on the event payload (create newValue / delete snapshot). */
  explicit: string | null | undefined;
  /** Parent recorded on the payload, for nodes no longer in the current tree. */
  parentId: string | null | undefined;
}

/**
 * The (inherited) release an event belongs to, or null when nothing can
 * say. Preference order: a version stamped on the event payload, then the
 * node's current chain, then the chain above the parent the payload names
 * — that last one is how a deleted node still finds its release when the
 * snapshot predates the `versionId` field.
 */
function attributeEvent(
  e: ChangeEventLite,
  nodeById: Map<string, Node>,
  hint: EventAttribution,
): string | null {
  if (typeof hint.explicit === 'string') return hint.explicit;
  if (e.nodeId && nodeById.has(e.nodeId)) {
    const v = effectiveVersionId(e.nodeId, nodeById);
    if (v) return v;
  }
  if (typeof hint.parentId === 'string' && nodeById.has(hint.parentId)) {
    return effectiveVersionId(hint.parentId, nodeById);
  }
  return null;
}

/**
 * Exactly the accounting of the MCP `burnup` tool (packages/mcp, 'burnup'),
 * so the number a stakeholder reads here matches what a developer quotes
 * back: created nodes count the estimate on the create event, deleted
 * leaves count the snapshot on the delete event, estimate edits count in
 * full. Subtree deletes only snapshot the primary node (server) — same
 * blind spot as burnup, by design.
 *
 * The top-level figures are always map-wide (that is what burnup reports).
 * With `nodes` the same events are also attributed to releases, and
 * `forVersion` carries the focused release's share — issue #333: the card
 * under "What threatens MVP" said the plan grew by 11 weeks, all of it V1.
 */
export function scopeGrowth(
  events: ChangeEventLite[],
  versionId: string | null,
  nodes?: Record<string, Node>,
): ScopeGrowth {
  const g: ScopeGrowth = {
    ...emptyScopeTotals(),
    promoted: [],
    promotedByVersion: {},
    forVersion: null,
    unattributed: emptyScopeTotals(),
  };
  const nodeById = nodes ? new Map(Object.entries(nodes)) : null;
  const perVersion = nodeById && versionId ? emptyScopeTotals() : null;

  // Map-wide first, then the same delta into the bucket the event belongs to.
  const book = (e: ChangeEventLite, hint: EventAttribution, apply: (t: ScopeTotals) => void) => {
    apply(g);
    if (!nodeById) return;
    const v = attributeEvent(e, nodeById, hint);
    if (v === null) apply(g.unattributed);
    else if (perVersion && v === versionId) apply(perVersion);
  };

  for (const e of events) {
    if (e.eventType === 'node.created') {
      const nv = e.newValue as { effortEstimate?: number | null; versionId?: string | null; parentId?: string | null } | null;
      book(e, { explicit: nv?.versionId, parentId: nv?.parentId }, (t) => {
        t.created += 1;
        t.effortAdded += nv?.effortEstimate ?? 0;
      });
    } else if (e.eventType === 'node.deleted') {
      const snap = e.oldValue as
        | { effortEstimate?: number | null; isLeaf?: boolean; versionId?: string | null; parentId?: string | null }
        | null;
      book(e, { explicit: snap?.versionId, parentId: snap?.parentId }, (t) => {
        t.deleted += 1;
        if (snap?.isLeaf && snap.effortEstimate != null) t.effortRemoved += snap.effortEstimate;
      });
    } else if (e.eventType === 'node.field_changed' && e.fieldName === 'effortEstimate') {
      const d = (Number(e.newValue) || 0) - (Number(e.oldValue) || 0);
      book(e, { explicit: undefined, parentId: undefined }, (t) => {
        if (d > 0) t.effortAdded += d;
        else t.effortRemoved += -d;
      });
    } else if (e.eventType === 'node.field_changed' && e.fieldName === 'versionId' && typeof e.newValue === 'string' && e.nodeId) {
      (g.promotedByVersion[e.newValue] ??= []).push(e.nodeId);
      if (versionId && e.newValue === versionId) g.promoted.push(e.nodeId);
    }
  }
  for (const t of [g, g.unattributed, perVersion]) if (t) t.effortDelta = t.effortAdded - t.effortRemoved;
  g.forVersion = perVersion;
  return g;
}

// ── Blocked, grouped by root cause (PM Q2, issue #322) ───────────────

export type BlockerKind =
  | 'orphaned_claim'
  | 'merge_blocked'
  | 'pr_open'
  | 'decision'
  | 'external'
  | 'dependency'
  | 'other';

export interface BlockerGroup {
  kind: BlockerKind;
  label: string;
  /** Who can unblock it, when the reason names someone. */
  unblocker: string | null;
  nodeIds: string[];
}

/**
 * Cause vocabulary, tested in order. Round 2 (Jenna) showed that keying on
 * the reason text collapses only byte-identical strings — 133 of 136 groups
 * were singletons while 41 nodes shared one cause ("CI red on main"). The
 * PM decides on causes, so the classifier names causes, not tickets.
 */
const BLOCKER_KINDS: { kind: BlockerKind; label: string; re: RegExp }[] = [
  { kind: 'orphaned_claim', label: 'Claim swept off a worker — in progress with nobody on it', re: /swept off|nobody on it|orphan/i },
  {
    kind: 'merge_blocked',
    label: 'Code done, cannot merge — CI red on main / migration fork / Actions not dispatching',
    re: /ci (is )?red|red ci|main (is )?red|cannot merge|can't merge|migration[- ]?(graph )?fork|not dispatch|workflow scope|merge[- ]blocked|blocks merging/i,
  },
  { kind: 'pr_open', label: 'PR open, waiting for review or checks', re: /\bPRs?\b.*(open|review|green|pending|approv)|pull request|awaiting review|in review/i },
  {
    kind: 'decision',
    label: 'Waiting on a named decision',
    re: /\bgate\b|entscheid|decision|decide|ruling|klärung|klaerung|wartet auf|waiting (on|for) (dan|thomas|rita|daniel|alpine|the )|needs? (dan|thomas|rita|daniel)|spec from|sign-?off/i,
  },
  { kind: 'external', label: 'External party, no date', re: /extern|pentest|vendor|provider|third[- ]party|supplier|lieferant|awaiting .* from/i },
];

// The person after a 'needs / waiting on / wartet auf / decision by' — no name list.
const NAME_RE = /(?:needs?|waiting (?:on|for)|wartet auf|entscheid|decision (?:by|from)|spec from|from)\s+(?!Entscheid|Decision|Gate|Spec|Review|The\b|Der\b|Die\b|Das\b)([A-ZÄÖÜ][a-zäöüß]+)/i;

export function classifyBlocker(reason: string): BlockerKind {
  for (const k of BLOCKER_KINDS) if (k.re.test(reason)) return k.kind;
  return 'other';
}

export function groupBlockers(
  nodes: Record<string, Node>,
  computed: Map<string, ComputedNodeValues>,
  categoryOf: CategoryOf,
): BlockerGroup[] {
  const byKey = new Map<string, BlockerGroup>();
  const add = (key: string, g: Omit<BlockerGroup, 'nodeIds'>, id: string) => {
    const cur = byKey.get(key) ?? { ...g, nodeIds: [] };
    cur.nodeIds.push(id);
    byKey.set(key, cur);
  };

  for (const n of leavesOf(nodes)) {
    const c = computed.get(n.id);
    if (!c?.isBlocked || !isOpen(n, categoryOf)) continue;
    if (n.blockedReason) {
      const kind = classifyBlocker(n.blockedReason);
      const def = BLOCKER_KINDS.find((k) => k.kind === kind);
      const who = kind === 'decision' ? (NAME_RE.exec(n.blockedReason)?.[1] ?? null) : null;
      if (kind === 'other') {
        add('other', { kind, label: 'Other reasons (see Blocked panel)', unblocker: null }, n.id);
      } else {
        add(`${kind}:${who ?? ''}`, { kind, label: who ? `${def!.label} — ${who}` : def!.label, unblocker: who }, n.id);
      }
    } else if (c.blockedBy.predecessorIds.length) {
      add('dependency', { kind: 'dependency', label: 'Waiting on a predecessor task', unblocker: null }, n.id);
    }
  }

  const rank: Record<BlockerKind, number> = { orphaned_claim: 0, merge_blocked: 1, decision: 2, pr_open: 3, external: 4, dependency: 5, other: 6 };
  return [...byKey.values()].sort((a, b) => rank[a.kind] - rank[b.kind] || b.nodeIds.length - a.nodeIds.length);
}

// ── Sprint health (PM Q4, issue #324) ────────────────────────────────

export interface SprintHealth {
  cycle: Cycle | null;
  daysLeft: number | null;
  endedButNotClosed: boolean;
  inProgress: number;
  wipLimit: number | null;
  stalled: number;
  /** Open leaves tagged with this sprint — what rolls over if nothing changes. */
  openInSprint: number;
}

export function sprintHealth(
  cycle: Cycle | null,
  nodes: Record<string, Node>,
  categoryOf: CategoryOf,
  wipLimit: number | null,
  today: Date = new Date(),
  stalledAfterDays = 14,
): SprintHealth {
  const leaves = leavesOf(nodes);
  // A leaf at 100 % whose status still says in_progress is finished work
  // waiting for a status click, not WIP.
  const inProg = leaves.filter((n) => categoryOf(n) === 'in_progress' && isOpen(n, categoryOf));
  const stalledSince = today.getTime() - stalledAfterDays * DAY;
  const t = isoDay(today);
  return {
    cycle,
    daysLeft: cycle ? daysBetween(t, cycle.endDate) : null,
    endedButNotClosed: !!cycle && cycle.endDate.slice(0, 10) < t && cycle.status !== 'completed',
    inProgress: inProg.length,
    wipLimit,
    stalled: inProg.filter((n) => Date.parse(n.updatedAt) < stalledSince).length,
    openInSprint: cycle ? leaves.filter((n) => n.cycleId === cycle.id && isOpen(n, categoryOf)).length : 0,
  };
}

// ── Triage pipeline state (PM Q3, issue #320) ────────────────────────

export interface TriagePipelineState {
  broken: boolean;
  count: number;
  cause: string | null;
  since: string | null;
}

const TRIAGE_ERROR_RE = /triage_error[:\s]*(.*)/i;

/** N pending decisions sharing one error text = the pipeline, not the tickets. */
/**
 * "400 {"type":"error","error":{"message":"Your credit balance is too low…"}}"
 * → "Your credit balance is too low…". The API error JSON is the cause a PM
 * has to read; the envelope around it is not.
 */
export function humaniseTriageCause(raw: string): string {
  const start = raw.indexOf('{');
  if (start === -1) return raw;
  const candidates = [raw.slice(start), raw.slice(start, raw.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    try {
      const j = JSON.parse(c) as { error?: { message?: string }; message?: string };
      const msg = j.error?.message ?? j.message;
      if (msg) return `${raw.slice(0, start).trim()} ${msg}`.trim();
    } catch {
      // truncated JSON — fall through to the regex
    }
  }
  const m = /"message"\s*:\s*"([^"]*)/.exec(raw);
  return m ? `${raw.slice(0, start).trim()} ${m[1]}`.trim() : raw;
}

export function triagePipelineState(decisions: Pick<TriageDecision, 'reason' | 'decidedAt' | 'decision'>[], threshold = 5): TriagePipelineState {
  const errors = decisions
    .map((d) => ({ m: TRIAGE_ERROR_RE.exec(d.reason ?? ''), at: d.decidedAt }))
    .filter((x) => x.m);
  if (errors.length < threshold) return { broken: false, count: 0, cause: null, since: null };
  const causes = new Map<string, number>();
  for (const e of errors) {
    // Same cause, different ticket number → one key.
    const key = humaniseTriageCause(e.m![1]).replace(/\(?#\d+\)?/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    causes.set(key, (causes.get(key) ?? 0) + 1);
  }
  const [cause, count] = [...causes.entries()].sort((a, b) => b[1] - a[1])[0];
  if (count < threshold) return { broken: false, count: 0, cause: null, since: null };
  const since = errors.map((e) => e.at).sort()[0] ?? null;
  return { broken: true, count: errors.length, cause, since };
}

// ── Escalations (PM Q6) ──────────────────────────────────────────────

export function escalations(
  nodes: Record<string, Node>,
  computed: Map<string, ComputedNodeValues>,
  categoryOf: CategoryOf,
  limit = 5,
): Node[] {
  const prio = (p: Priority | null) => (p === 'P0' ? 0 : p === 'P1' ? 1 : 2);
  return leavesOf(nodes)
    .filter((n) => isOpen(n, categoryOf) && (n.priority === 'P0' || n.priority === 'P1') && computed.get(n.id)?.isBlocked && n.blockedReason)
    .sort((a, b) => prio(a.priority) - prio(b.priority) || (b.effortEstimate ?? 0) - (a.effortEstimate ?? 0))
    .slice(0, limit);
}
