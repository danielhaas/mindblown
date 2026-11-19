/**
 * The map's projected schedule (the Gantt), computed once for every caller:
 * GET /api/maps/:id/schedule and "freeze baseline" (#113), which snapshots
 * exactly what the Gantt shows.
 */
import { schedule, criticalPath, capacityCriticalPath, clampFocusFactor, nodesInVersion, withoutParked, latestAskDates, leaveDaysOff, isFleetBuilt } from '@mindblown/core';
import type { Baseline, ScheduleConstraint, ScheduleCalendars, DaysOff, NodeId, Node as CoreNode, MindMap, PersonLeave } from '@mindblown/core';
import { mapDayMapper } from './holidays.js';

export interface MapScheduleOptions {
  versionId?: string;
  /** Overrides the map's workerCount (the Gantt's ?workers=). */
  workers?: string;
}

/** Leave of one person inside the projection (#664) — get_schedule, the Gantt, the export line. */
export interface ScheduleLeave {
  userId: string;
  name: string;
  /** The worker track that is this person's (map `workers`), null = only via assigned nodes. */
  track: number | null;
  /** Ranges that fall inside the projected work, each with its working days. */
  ranges: Array<{ startDate: string; endDate: string; note: string | null; workingDays: number }>;
  /** The working days of leave inside the projected work ('YYYY-MM-DD'), ascending. */
  days: string[];
}

/** `leave`: the people's leave (db/leave withMapLeave) — absent = nobody's leave applies. */
export function computeMapSchedule(data: { map: MindMap; nodes: CoreNode[]; leave?: PersonLeave[] }, opts: MapScheduleOptions = {}) {
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

  // ── Parked branches (#655) ───────────────────────────────
  // Kept in the map, never planned: no dates, no critical path, not in the
  // total duration. Dependencies on them are dropped (nothing to wait for).
  const planned = withoutParked(data.nodes);

  // ── Version scoping ──────────────────────────────────────
  const versionId = opts.versionId;
  let scopedNodes = planned;
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
    const nodeById = new Map(planned.map((n) => [n.id, n]));
    const inScope = nodesInVersion(planned, versionId);
    // Prune dependencies that cross the version boundary; record them.
    scopedNodes = planned
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
    // A wait's clock starts when we asked (#654).
    if (n.requestedAt) pin.requestedAt = toDayOffset(n.requestedAt);
    // The deadline is the END of the due day: work whose last day is the
    // due date is on time (#113 review).
    if (n.dueDate) pin.maxEnd = dueEndDay(n.dueDate) * unitsPerDay;
    if (pin.minStart !== undefined || pin.maxEnd !== undefined || pin.requestedAt !== undefined) {
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

  // ── Personal leave (#664) ─────────────────────────────────
  // Track t is workers[t]'s; an assigned leaf follows its assignee (on the
  // assignee's track when they are a map worker); fleet-built work ignores
  // leave. Without workers and leave, nothing changes.
  const workerIds = (data.map.workers ?? []).slice(0, effectiveWorkers);
  const leaveByUser = new Map((data.leave ?? []).map((p) => [p.userId, p]));
  const offByUser = new Map<string, DaysOff>();
  const offOf = (userId: string): DaysOff => {
    let off = offByUser.get(userId);
    if (!off) {
      const p = leaveByUser.get(userId);
      off = p ? leaveDaysOff(p.ranges, mapper, holidays, unitsPerDay).off : [];
      offByUser.set(userId, off);
    }
    return off;
  };
  // Whose leave each open leaf follows: its assignee, or (by track) a worker.
  const assignedTo = new Map<NodeId, string>();
  const fleetBuilt = new Set<NodeId>();
  let calendars: ScheduleCalendars | undefined;
  if (workerIds.length > 0 || leaveByUser.size > 0) {
    const nodesOff = new Map<NodeId, DaysOff>();
    const pinnedTrack = new Map<NodeId, number>();
    for (const n of scopedNodes) {
      if (n.childrenIds.length > 0) continue;
      if (isFleetBuilt(data.map, n)) {
        fleetBuilt.add(n.id);
        nodesOff.set(n.id, []);
        continue;
      }
      const a = n.assigneeIds?.[0];
      if (!a) continue;
      assignedTo.set(n.id, a);
      const t = workerIds.indexOf(a);
      if (t >= 0) pinnedTrack.set(n.id, t);
      else nodesOff.set(n.id, offOf(a));
    }
    calendars = { tracks: workerIds.map(offOf), nodes: nodesOff, pinnedTrack };
  }

  const tracks = new Map<NodeId, number>();
  const scheduled = schedule(scopedNodes, 0, constraints, undefined, effectiveWorkers, todayDay, completedAtByNodeId, tracks, calendars);
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
  const dayToDateIso = dayToDate;

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

  // Waits not asked for yet (#654): the last day to ask without delaying
  // the plan. risk_scan flags the ones due soon as "ask now".
  const askBy = latestAskDates(scopedNodes, scheduled)
    .map((a) => {
      const node = scopedById.get(a.nodeId)!;
      return {
        nodeId: a.nodeId,
        text: node.text,
        waitingOn: node.waitingOn ?? null,
        latestAskDate: dayToDate(Math.floor(a.latestStart / unitsPerDay)),
      };
    })
    .sort((a, b) => a.latestAskDate.localeCompare(b.latestAskDate));

  // Leave inside the projected work (#664): per person, the ranges and
  // working days from the start of the open work (project start or today,
  // whichever is later — leave can push the first bar past itself) to the
  // end of the last open bar that person works on.
  const leave: ScheduleLeave[] = [];
  const nodeLeave: Record<NodeId, string> = {};
  if (leaveByUser.size > 0) {
    const personOfLeaf = new Map<NodeId, string>();
    const first = Math.max(0, todayDay);
    let last = -Infinity;
    for (const s of scheduled) {
      const t = tracks.get(s.nodeId);
      if (t === undefined || fleetBuilt.has(s.nodeId)) continue; // not open work, or no person
      const person = assignedTo.get(s.nodeId) ?? workerIds[t];
      if (!person || !leaveByUser.has(person)) continue;
      personOfLeaf.set(s.nodeId, person);
      last = Math.max(last, s.computedEnd);
    }
    if (first < last) {
      const from = mapper.toDate(Math.floor(first / unitsPerDay)).toISOString().slice(0, 10);
      const to = mapper.lastDay(Math.ceil(last / unitsPerDay)).toISOString().slice(0, 10);
      const people = new Set(personOfLeaf.values());
      for (const userId of people) {
        const p = leaveByUser.get(userId)!;
        const ranges: ScheduleLeave['ranges'] = [];
        const days = new Set<string>();
        for (const r of p.ranges) {
          if (r.endDate < from || r.startDate > to) continue;
          const clipped = { startDate: r.startDate < from ? from : r.startDate, endDate: r.endDate > to ? to : r.endDate };
          const { off, days: n } = leaveDaysOff([clipped], mapper, holidays, 1);
          if (n === 0) continue;
          ranges.push({ ...r, workingDays: n });
          for (const [a, b] of off) for (let o = a; o < b; o++) days.add(dayToDateIso(o));
        }
        if (ranges.length === 0) continue;
        const t = workerIds.indexOf(userId);
        leave.push({ userId, name: p.name, track: t >= 0 ? t : null, ranges, days: [...days].sort() });
      }
      const withLeave = new Set(leave.map((l) => l.userId));
      for (const [nodeId, person] of personOfLeaf) if (withLeave.has(person)) nodeLeave[nodeId] = person;
    }
  }

  return {
    schedule: scheduled,
    leave,
    nodeLeave,
    askBy,
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
    /** The same bar as a person reads it: first day and LAST day, both inclusive. */
    barSpan: (s: { computedStart: number; computedEnd: number; duration: number }) => {
      const d = barDays(s);
      return { start: dayToDate(d.start), end: mapper.lastDay(Math.max(d.end, d.start + 1)).toISOString().slice(0, 10) };
    },
  };
}

/**
 * A baseline of what the Gantt shows right now (#113): every node's planning
 * fields plus its projected bar, so the ghost bars carry the whole committed
 * plan, not only the nodes someone pinned by hand.
 */
export function buildBaseline(data: { map: MindMap; nodes: CoreNode[]; leave?: PersonLeave[] }, name: string, now: Date = new Date()): Baseline {
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
