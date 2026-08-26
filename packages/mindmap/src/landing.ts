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
import type { ReleaseForecastRow, TriageDecision } from './api.js';

export type StatusCategory = 'todo' | 'in_progress' | 'done';
export type CategoryOf = (node: Node) => StatusCategory;

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
  const open = rows.filter(
    (r) => (r.versionStatus === 'active' || r.versionStatus === 'planning') && (r.remainingTickets > 0 || r.leaves === 0),
  );
  const dated = open.filter((r) => r.targetDate).sort((a, b) => a.targetDate!.localeCompare(b.targetDate!));
  const t = isoDay(today);
  const overdue = dated.filter((r) => r.targetDate! < t);
  if (overdue.length) return overdue[overdue.length - 1];
  const active = dated.find((r) => r.versionStatus === 'active') ?? dated[0];
  return active ?? open.sort((a, b) => a.sortOrder - b.sortOrder)[0] ?? null;
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
  const inScope = leavesOf(nodes).filter((n) => categoryOf(n) !== 'done' && (!versionId || inVersion(nodes, n, versionId)));
  const out: Threat[] = [];

  const blockedBig = inScope
    .filter((n) => computed.get(n.id)?.isBlocked && (n.effortEstimate ?? 0) > 0)
    .sort((a, b) => (b.effortEstimate ?? 0) - (a.effortEstimate ?? 0));
  for (const n of blockedBig.slice(0, 2)) {
    out.push({ text: `${n.text} (${n.effortEstimate}d) is blocked but still counted: ${n.blockedReason ?? 'waiting on a predecessor'}`, nodeId: n.id });
  }

  const unowned = inScope.filter((n) => (n.priority === 'P0' || n.priority === 'P1') && n.assigneeIds.length === 0 && !n.claimedBySession);
  if (unowned.length) {
    out.push({ text: `${unowned.length} high-priority tasks have no owner`, nodeId: unowned[0].id });
  }

  const unestimated = inScope.filter((n) => n.effortEstimate === null);
  if (unestimated.length >= Math.max(3, inScope.length / 4)) {
    out.push({ text: `${unestimated.length} of ${inScope.length} open tasks have no estimate — the finish date is a guess`, nodeId: null });
  }
  return out.slice(0, limit);
}

export function inVersion(nodes: Record<string, Node>, node: Node, versionId: string): boolean {
  let cur: Node | undefined = node;
  while (cur) {
    if (cur.versionId === versionId) return true;
    cur = cur.parentId ? nodes[cur.parentId] : undefined;
  }
  return false;
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
  return leavesOf(nodes)
    .filter((n) => categoryOf(n) === 'done')
    .map((n) => ({ n, at: Date.parse(n.completedAt ?? n.updatedAt) }))
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

export interface ScopeGrowth {
  created: number;
  deleted: number;
  /** Net effort added through estimate edits, in effort units. */
  effortDelta: number;
  /** Nodes moved *into* `versionId` in the window (promotions). */
  promoted: string[];
}

export function scopeGrowth(events: ChangeEventLite[], versionId: string | null): ScopeGrowth {
  const g: ScopeGrowth = { created: 0, deleted: 0, effortDelta: 0, promoted: [] };
  for (const e of events) {
    if (e.eventType === 'node.created') g.created += 1;
    else if (e.eventType === 'node.deleted') g.deleted += 1;
    else if (e.eventType === 'node.field_changed' && e.fieldName === 'effortEstimate') {
      g.effortDelta += (Number(e.newValue) || 0) - (Number(e.oldValue) || 0);
    } else if (e.eventType === 'node.field_changed' && e.fieldName === 'versionId' && versionId && e.newValue === versionId && e.nodeId) {
      g.promoted.push(e.nodeId);
    }
  }
  return g;
}

// ── Blocked, grouped by root cause (PM Q2, issue #322) ───────────────

export interface BlockerGroup {
  kind: 'orphaned_claim' | 'dependency' | 'reason';
  label: string;
  nodeIds: string[];
}

const ORPHAN_RE = /swept off|nobody on it|orphan/i;

function normaliseReason(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/#\d+/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-zäöüß0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
}

export function groupBlockers(
  nodes: Record<string, Node>,
  computed: Map<string, ComputedNodeValues>,
  categoryOf: CategoryOf,
): BlockerGroup[] {
  const orphaned: string[] = [];
  const dependency: string[] = [];
  const byReason = new Map<string, { label: string; ids: string[] }>();

  for (const n of leavesOf(nodes)) {
    const c = computed.get(n.id);
    if (!c?.isBlocked || categoryOf(n) === 'done') continue;
    if (n.blockedReason && ORPHAN_RE.test(n.blockedReason)) {
      orphaned.push(n.id);
    } else if (n.blockedReason) {
      const key = normaliseReason(n.blockedReason);
      const g = byReason.get(key) ?? { label: n.blockedReason.slice(0, 80), ids: [] };
      g.ids.push(n.id);
      byReason.set(key, g);
    } else if (c.blockedBy.predecessorIds.length) {
      dependency.push(n.id);
    }
  }

  const out: BlockerGroup[] = [];
  if (orphaned.length) out.push({ kind: 'orphaned_claim', label: 'Claim swept off a worker — in progress with nobody on it', nodeIds: orphaned });
  for (const g of [...byReason.values()].sort((a, b) => b.ids.length - a.ids.length)) {
    out.push({ kind: 'reason', label: g.label, nodeIds: g.ids });
  }
  if (dependency.length) out.push({ kind: 'dependency', label: 'Waiting on a predecessor task', nodeIds: dependency });
  return out;
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
  const inProg = leaves.filter((n) => categoryOf(n) === 'in_progress');
  const stalledSince = today.getTime() - stalledAfterDays * DAY;
  const t = isoDay(today);
  return {
    cycle,
    daysLeft: cycle ? daysBetween(t, cycle.endDate) : null,
    endedButNotClosed: !!cycle && cycle.endDate.slice(0, 10) < t && cycle.status !== 'completed',
    inProgress: inProg.length,
    wipLimit,
    stalled: inProg.filter((n) => Date.parse(n.updatedAt) < stalledSince).length,
    openInSprint: cycle ? leaves.filter((n) => n.cycleId === cycle.id && categoryOf(n) !== 'done').length : 0,
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
export function triagePipelineState(decisions: Pick<TriageDecision, 'reason' | 'decidedAt' | 'decision'>[], threshold = 5): TriagePipelineState {
  const errors = decisions
    .map((d) => ({ m: TRIAGE_ERROR_RE.exec(d.reason ?? ''), at: d.decidedAt }))
    .filter((x) => x.m);
  if (errors.length < threshold) return { broken: false, count: 0, cause: null, since: null };
  const causes = new Map<string, number>();
  for (const e of errors) {
    // Same cause, different ticket number → one key.
    const key = e.m![1].replace(/\(?#\d+\)?/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
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
    .filter((n) => categoryOf(n) !== 'done' && (n.priority === 'P0' || n.priority === 'P1') && computed.get(n.id)?.isBlocked && n.blockedReason)
    .sort((a, b) => prio(a.priority) - prio(b.priority) || (b.effortEstimate ?? 0) - (a.effortEstimate ?? 0))
    .slice(0, limit);
}
