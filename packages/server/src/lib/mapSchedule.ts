/**
 * The map's projected schedule (the Gantt), computed once for every caller:
 * GET /api/maps/:id/schedule and "freeze baseline" (#113), which snapshots
 * exactly what the Gantt shows.
 */
import { schedule, criticalPath, capacityCriticalPath, clampFocusFactor, nodesInVersion } from '@mindblown/core';
import type { Baseline, ScheduleConstraint, NodeId, Node as CoreNode, MindMap } from '@mindblown/core';

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
  const MS_PER_DAY = 86_400_000;
  const toDayOffset = (isoDate: string): number => {
    const d = new Date(isoDate);
    d.setUTCHours(0, 0, 0, 0);
    const calendarDays = Math.round((d.getTime() - projectStartDate.getTime()) / MS_PER_DAY);
    // Convert calendar-day offset back to the scheduler's effort-unit space.
    return calendarDays * unitsPerDay;
  };

  const constraints = new Map<NodeId, ScheduleConstraint>();
  for (const n of scopedNodes) {
    const pin: ScheduleConstraint = {};
    if (n.startDate) pin.minStart = toDayOffset(n.startDate);
    if (n.dueDate) pin.maxEnd = toDayOffset(n.dueDate);
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

  // Missed deadlines (#113): nodes whose projected end lands after their
  // due date, as dates and calendar days, worst first.
  const offsetToDate = (offset: number): string => {
    const d = new Date(projectStartDate.getTime());
    d.setUTCDate(d.getUTCDate() + Math.ceil(offset / unitsPerDay));
    return d.toISOString().slice(0, 10);
  };
  const scopedById = new Map(scopedNodes.map((n) => [n.id, n]));
  const dueViolations = scheduled
    .filter((s) => s.dueOverrun !== undefined && s.dueOverrun > 0)
    .map((s) => {
      const node = scopedById.get(s.nodeId)!;
      return {
        nodeId: s.nodeId,
        text: node.text,
        dueDate: (node.dueDate as string).slice(0, 10),
        projectedEnd: offsetToDate(s.computedEnd),
        lateDays: Math.ceil((s.dueOverrun as number) / unitsPerDay),
      };
    })
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
    /** Scheduler offset → calendar date (YYYY-MM-DD). */
    offsetToDate,
    /** A bar as the Gantt draws it (GanttView scheduleDates): offsets
     *  rounded to whole days, a non-empty bar at least one day wide. */
    barDates: (s: { computedStart: number; computedEnd: number; duration: number }) => {
      const startDays = Math.round(s.computedStart / unitsPerDay);
      const endDays = Math.round(Math.max(s.computedEnd / unitsPerDay, s.computedStart / unitsPerDay + (s.duration === 0 ? 0 : 1)));
      const at = (days: number) => {
        const d = new Date(projectStartDate.getTime());
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
      };
      return { start: at(startDays), end: at(endDays) };
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
