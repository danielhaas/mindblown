/**
 * The map's projected schedule (the Gantt), computed once for every caller:
 * GET /api/maps/:id/schedule and "freeze baseline" (#113), which snapshots
 * exactly what the Gantt shows.
 */
import { schedule, criticalPath, capacityCriticalPath, clampFocusFactor, nodesInVersion } from '@mindblown/core';
import type { Baseline, ScheduleConstraint, NodeId, Node as CoreNode, MindMap } from '@mindblown/core';
import { mapDayMapper } from './holidays.js';

export interface MapScheduleOptions {
  versionId?: string;
  /** Overrides the map's workerCount (the Gantt's ?workers=). */
  workers?: string;
}

export function computeMapSchedule(data: { map: MindMap; nodes: CoreNode[] }, opts: MapScheduleOptions = {}) {
  // Anchor day 0 of the schedule to the map's projectStartDate (or today).
  const projectStartDate = data.map.projectStartDate
    ? new Date(data.map.projectStartDate)
    : new Date(new Date().toISOString().slice(0, 10));
  // Normalize to UTC midnight so day arithmetic is stable.
  projectStartDate.setUTCHours(0, 0, 0, 0);

  // Conversion factor: effort-unit → calendar days.
  // - days: 1 unit = 1 day
  // - hours: 1 unit = 1 / hoursPerDay days
  // - points: undefined (clients should warn); default to 1 day/point so a
  //   roadmap still renders something.
  const unitsPerDay =
    data.map.effortUnit === 'hours'
      ? (data.map.hoursPerDay ?? 8)
      : 1;

  // ── Version scoping ──────────────────────────────────────
  const versionId = opts.versionId;
  let scopedNodes = data.nodes;
  const crossVersionDependencies: Array<{
    fromNodeId: string;
    fromText: string;
    toNodeId: string;
    toText: string;
    type: string;
  }> = [];
  if (versionId) {
    // A node is in scope when its EFFECTIVE version is this one — its own
    // versionId, else the nearest ancestor's (#357). Walking up to *any*
    // ancestor with the version kept nodes that override it with their
    // own version, so a version-scoped landing date counted another
    // release's work. Same rule as search_nodes and the dispatch gate.
    const nodeById = new Map(data.nodes.map((n) => [n.id, n]));
    const inScope = nodesInVersion(data.nodes, versionId);
    // Prune dependencies that cross the version boundary; record them.
    scopedNodes = data.nodes
      .filter((n) => inScope.has(n.id))
      .map((n) => {
        const kept: typeof n.dependencies = [];
        for (const dep of n.dependencies) {
          if (inScope.has(dep.targetNodeId)) {
            kept.push(dep);
          } else {
            const target = nodeById.get(dep.targetNodeId);
            crossVersionDependencies.push({
              fromNodeId: n.id,
              fromText: n.text,
              toNodeId: dep.targetNodeId,
              toText: target?.text ?? dep.targetNodeId,
              type: dep.type,
            });
          }
        }
        // childrenIds also need pruning so the scheduler's tree view stays valid
        const keptChildren = n.childrenIds.filter((cid) => inScope.has(cid));
        return { ...n, dependencies: kept, childrenIds: keptChildren };
      });
  }

  // Build per-node constraints from manual start/due dates. Any node with
  // a user-set date gets pinned; everything else flows from effort + deps.
  // Dates ↔ day offsets go through the map's calendar (#110): every day by
  // default, Mon–Fri minus holidays once a holiday calendar is set.
  const MS_PER_DAY = 86_400_000;
  const { mapper, holidays } = mapDayMapper(data.map, projectStartDate);
  const toDayOffset = (isoDate: string): number => mapper.toOffset(isoDate) * unitsPerDay;
  // The END of a due day as a day offset: the boundary after the last
  // working day on or before it — a due date on a weekend or holiday means
  // "by the end of the working day before". On every-day maps: offset + 1.
  const dueEndDay = (isoDate: string): number =>
    mapper.toOffset(new Date(new Date(isoDate.slice(0, 10)).getTime() + MS_PER_DAY));

  const constraints = new Map<NodeId, ScheduleConstraint>();
  for (const n of scopedNodes) {
    const pin: ScheduleConstraint = {};
    if (n.startDate) pin.minStart = toDayOffset(n.startDate);
    // The deadline is the END of the due day: work whose last day is the
    // due date is on time (#113 review).
    if (n.dueDate) pin.maxEnd = dueEndDay(n.dueDate) * unitsPerDay;
    if (pin.minStart !== undefined || pin.maxEnd !== undefined) {
      constraints.set(n.id, pin);
    }
  }

  // Resolve effective worker count: query param overrides map setting.
  // Floor at 1, cap at 100 to keep accidental ?workers=999999 from being
  // weird.
  const queryWorkers = opts.workers ? Number(opts.workers) : NaN;
  const effectiveWorkers = Number.isFinite(queryWorkers) && queryWorkers >= 1
    ? Math.min(100, Math.floor(queryWorkers))
    : Math.max(1, Math.min(100, Math.floor(data.map.workerCount ?? 1)));

  // Compute "today" in scheduler units. Used by the scheduler to pin
  // done leaves so they end at the today line (and don't all stack at
  // projectStartDay). If today is before the project anchor, the value
  // is negative — done items render to the left of the anchor, which
  // is the right semantic.
  const todayDate = new Date(new Date().toISOString().slice(0, 10));
  todayDate.setUTCHours(0, 0, 0, 0);
  const todayDay = toDayOffset(todayDate.toISOString().slice(0, 10));

  // Build per-node completedAt offsets so done bars sit at their actual
  // close dates instead of all piling on `todayDay`. Backfill populated
  // these via the migration; new completions write them on each status
  // transition. Nodes without a completedAt fall back to today in the
  // scheduler.
  const completedAtByNodeId = new Map<NodeId, number>();
  for (const n of scopedNodes) {
    if (n.completedAt) {
      completedAtByNodeId.set(n.id, toDayOffset(n.completedAt.slice(0, 10)));
    }
  }

  const tracks = new Map<NodeId, number>();
  const scheduled = schedule(scopedNodes, 0, constraints, undefined, effectiveWorkers, todayDay, completedAtByNodeId, tracks);
  // The critical path is the chain that decides the projected end UNDER
  // the worker count (#112); the dependency-only CPM stays available for
  // callers that want the plan's logical chain regardless of capacity.
  const cp = capacityCriticalPath(scopedNodes, scheduled, tracks);

  // A bar as the Gantt draws it (GanttView scheduleDates): offsets rounded
  // to whole days, a non-empty bar at least one day wide. The ONE rounding
  // rule — the drawn bar, the red overrun, projectedEnd and lateDays all
  // come from it, so they agree on hours maps and half-day estimates.
  const barDays = (s: { computedStart: number; computedEnd: number; duration: number }) => ({
    start: Math.round(s.computedStart / unitsPerDay),
    end: Math.round(Math.max(s.computedEnd / unitsPerDay, s.computedStart / unitsPerDay + (s.duration === 0 ? 0 : 1))),
  });
  // Whole-day offset → date on the map's calendar (a boundary: a bar's start,
  // or its exclusive end).
  const dayToDate = (days: number): string => mapper.toDate(days).toISOString().slice(0, 10);

  // Missed deadlines (#113): the drawn bar runs past the end of the due
  // day. projectedEnd = the last working day; lateDays counted in whole
  // days the way the bar is drawn, worst first. A sub-day overrun the
  // rounding absorbs is not a miss — the bar does not show one either.
  const scopedById = new Map(scopedNodes.map((n) => [n.id, n]));
  const dueViolations = scheduled
    .filter((s) => s.dueOverrun !== undefined && s.dueOverrun > 0)
    .map((s) => {
      const node = scopedById.get(s.nodeId)!;
      const dueDate = (node.dueDate as string).slice(0, 10);
      const endDays = barDays(s).end;
      // The day the work ends — its last (working) day.
      const projectedEnd = mapper.lastDay(endDays).toISOString().slice(0, 10);
      return {
        nodeId: s.nodeId,
        text: node.text,
        dueDate,
        projectedEnd,
        // Calendar days past the due date, like every other slip — on a
        // working calendar too ("finishes Mon, due Fri" is 3 days late).
        lateDays:
          endDays > dueEndDay(dueDate)
            ? Math.round((Date.parse(projectedEnd) - Date.parse(dueDate)) / MS_PER_DAY)
            : 0,
      };
    })
    .filter((v) => v.lateDays > 0)
    .sort((a, b) => b.lateDays - a.lateDays);

  return {
    schedule: scheduled,
    criticalPath: cp,
    dependencyCriticalPath: criticalPath(scopedNodes),
    projectStartDate: projectStartDate.toISOString().slice(0, 10),
    effortUnit: data.map.effortUnit,
    unitsPerDay,
    workerCount: effectiveWorkers,
    focusFactor: clampFocusFactor(data.map.focusFactor),
    versionId: versionId ?? null,
    crossVersionDependencies: versionId ? crossVersionDependencies : [],
    dueViolations,
    // Null = offsets are calendar days. Otherwise offsets are working days
    // (Mon–Fri minus these dates) — build the same mapper with
    // makeDayMapper(projectStartDate, new Set(holidays)) (#110).
    workingCalendar: holidays
      ? { jurisdiction: data.map.holidayJurisdiction ?? null, holidays: [...holidays].sort() }
      : null,
    /** A bar as the Gantt draws it, as dates (end exclusive). */
    barDates: (s: { computedStart: number; computedEnd: number; duration: number }) => {
      const d = barDays(s);
      return { start: dayToDate(d.start), end: dayToDate(d.end) };
    },
  };
}

/**
 * A baseline of what the Gantt shows right now (#113): every node's planning
 * fields plus its projected bar, so the ghost bars carry the whole committed
 * plan, not only the nodes someone pinned by hand.
 */
export function buildBaseline(data: { map: MindMap; nodes: CoreNode[] }, name: string, now: Date = new Date()): Baseline {
  const projection = computeMapSchedule(data);
  const projected = new Map(projection.schedule.map((s) => [s.nodeId, s]));
  const nodes: Baseline['nodes'] = {};
  for (const node of data.nodes) {
    const bar = projected.get(node.id);
    const planned = bar ? projection.barDates(bar) : null;
    nodes[node.id] = {
      effortEstimate: node.effortEstimate,
      percentComplete: node.percentComplete,
      startDate: node.startDate,
      dueDate: node.dueDate,
      status: node.status,
      ...(planned ? { plannedStart: planned.start, plannedEnd: planned.end } : {}),
    };
  }
  return { id: crypto.randomUUID(), name, createdAt: now.toISOString(), nodes };
}

/** Baselines kept per map: each carries every node, and the map payload
 *  (GET map, map:updated) carries all of them (#113 review). */
export const MAX_BASELINES = 10;

/** Keep the newest MAX_BASELINES (list is oldest first); name the dropped ones. */
export function capBaselines(all: Baseline[]): { kept: Baseline[]; dropped: string[] } {
  const kept = all.slice(-MAX_BASELINES);
  return { kept, dropped: all.slice(0, all.length - kept.length).map((b) => b.name) };
}
