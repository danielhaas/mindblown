import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Node, NodeId, CriticalPathResult, ScheduledNode, ScheduleConstraint } from '@mindblown/core';
import { schedule as computeSchedule, criticalPath as computeCriticalPath } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import { fetchSchedule } from './api.js';

// ── Schedule response shape (from GET /api/maps/:id/schedule) ────

interface ScheduleResponse {
  schedule: ScheduledNode[];
  criticalPath: CriticalPathResult;
  projectStartDate: string; // ISO YYYY-MM-DD
  effortUnit: 'hours' | 'days' | 'points';
  unitsPerDay: number;
}

// ── Constants ─────────────────────────────────────────────────────

const DEFAULT_TASK_LIST_WIDTH = 300;
const MIN_TASK_LIST_WIDTH = 180;
const MAX_TASK_LIST_WIDTH = 700;
const ROW_HEIGHT = 36;
const HEADER_HEIGHT = 48;
const HEALTH_COLORS: Record<string, string> = {
  on_track: '#22c55e',
  at_risk: '#f59e0b',
  behind: '#ef4444',
};

const HEALTH_BG: Record<string, string> = {
  on_track: '#dcfce7',
  at_risk: '#fef3c7',
  behind: '#fee2e2',
};

const STATUS_LABELS: Record<string, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  done: 'Done',
  blocked: 'Blocked',
};

type TimeScale = 'day' | 'week' | 'month' | 'quarter';

// ── Date helpers ──────────────────────────────────────────────────

function parseDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(a: Date, b: Date): number {
  const msPerDay = 86400000;
  return Math.round((b.getTime() - a.getTime()) / msPerDay);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function formatDate(d: Date, scale: TimeScale): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  switch (scale) {
    case 'day':
      return `${months[d.getMonth()]} ${d.getDate()}`;
    case 'week':
      return `${months[d.getMonth()]} ${d.getDate()}`;
    case 'month':
      return `${months[d.getMonth()]} ${d.getFullYear()}`;
    case 'quarter':
      return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`;
  }
}

function getColumnWidth(scale: TimeScale): number {
  switch (scale) {
    case 'day': return 40;
    case 'week': return 100;
    case 'month': return 160;
    case 'quarter': return 240;
  }
}

function getStepDays(scale: TimeScale): number {
  switch (scale) {
    case 'day': return 1;
    case 'week': return 7;
    case 'month': return 30;
    case 'quarter': return 91;
  }
}

/** Snap a date to the start of its period. */
function snapToStart(d: Date, scale: TimeScale): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  switch (scale) {
    case 'day':
      return r;
    case 'week': {
      const day = r.getDay();
      r.setDate(r.getDate() - day); // Sunday start
      return r;
    }
    case 'month':
      r.setDate(1);
      return r;
    case 'quarter': {
      const qMonth = Math.floor(r.getMonth() / 3) * 3;
      r.setMonth(qMonth, 1);
      return r;
    }
  }
}

/** Advance to the next period boundary. */
function nextPeriod(d: Date, scale: TimeScale): Date {
  const r = new Date(d);
  switch (scale) {
    case 'day':
      r.setDate(r.getDate() + 1);
      return r;
    case 'week':
      r.setDate(r.getDate() + 7);
      return r;
    case 'month':
      r.setMonth(r.getMonth() + 1);
      return r;
    case 'quarter':
      r.setMonth(r.getMonth() + 3);
      return r;
  }
}

// ── Flatten tree ──────────────────────────────────────────────────

interface FlatRow {
  node: Node;
  depth: number;
  isExpanded: boolean;
  hasChildren: boolean;
}

function flattenTree(
  nodes: Record<string, Node>,
  rootNodeId: string | null,
  collapsedSet: Set<string>,
): FlatRow[] {
  if (!rootNodeId || !nodes[rootNodeId]) return [];
  const result: FlatRow[] = [];

  function walk(nodeId: string, depth: number) {
    const node = nodes[nodeId];
    if (!node) return;
    const hasChildren = node.childrenIds.length > 0;
    const isExpanded = !collapsedSet.has(nodeId);
    result.push({ node, depth, isExpanded, hasChildren });
    if (hasChildren && isExpanded) {
      for (const childId of node.childrenIds) {
        walk(childId, depth + 1);
      }
    }
  }

  walk(rootNodeId, 0);
  return result;
}

// ── Timeline date range computation ──────────────────────────────

function computeTimeRange(
  rows: FlatRow[],
  scale: TimeScale,
  scheduleDates: Map<string, { start: Date; end: Date }>,
  baselines: Map<string, { startDate: string | null; dueDate: string | null }>,
): { rangeStart: Date; rangeEnd: Date; columns: Date[] } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let minDate = today;
  let maxDate = today;

  for (const row of rows) {
    const dates = scheduleDates.get(row.node.id);
    if (dates) {
      if (dates.start < minDate) minDate = dates.start;
      if (dates.end > maxDate) maxDate = dates.end;
    }

    // Check baselines too
    const bl = baselines.get(row.node.id);
    if (bl) {
      const bs = parseDate(bl.startDate);
      const bd = parseDate(bl.dueDate);
      if (bs && bs < minDate) minDate = bs;
      if (bd && bd > maxDate) maxDate = bd;
    }
  }

  // Add padding: 2 periods before and 4 after
  const stepDays = getStepDays(scale);
  const rangeStart = snapToStart(addDays(minDate, -stepDays * 2), scale);
  const rangeEnd = addDays(maxDate, stepDays * 4);

  // Generate columns
  const columns: Date[] = [];
  let current = new Date(rangeStart);
  while (current <= rangeEnd) {
    columns.push(new Date(current));
    current = nextPeriod(current, scale);
  }

  return { rangeStart, rangeEnd, columns };
}

// ── Arrow path between two bars ──────────────────────────────────

function computeArrowPath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): string {
  const midX = fromX + (toX - fromX) / 2;

  if (toX - fromX > 20) {
    // Simple S-curve
    return `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`;
  }
  // Route around: go right, down/up, then left to target
  const detour = 16;
  const fromRight = fromX + detour;
  return `M ${fromX} ${fromY} L ${fromRight} ${fromY} L ${fromRight} ${toY} L ${toX} ${toY}`;
}

// ── Arrowhead marker ID ──────────────────────────────────────────

const ARROW_MARKER_ID = 'gantt-arrowhead';

// ── Main component ───────────────────────────────────────────────

export function GanttView() {
  const nodes = useMindmapStore((s) => s.nodes);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);
  const computed = useMindmapStore((s) => s.computed);
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const currentMap = useMindmapStore((s) => s.currentMap);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const updateNode = useMindmapStore((s) => s.updateNode);
  const reorderChildren = useMindmapStore((s) => s.reorderChildren);
  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);
  const activeCycleFilter = useMindmapStore((s) => s.activeCycleFilter);
  const activeVersionFilter = useMindmapStore((s) => s.activeVersionFilter);

  // Local UI state
  const [scale, setScale] = useState<TimeScale>('week');
  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(() => new Set());
  const [serverScheduleData, setServerScheduleData] = useState<ScheduleResponse | null>(null);
  const [selectedBaseline, setSelectedBaseline] = useState<string | null>(null);
  const [sequentialMode, setSequentialMode] = useState(false);
  const [parallelism, setParallelism] = useState(1);
  const [taskListWidth, setTaskListWidth] = useState<number>(() => {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem('mindblown_gantt_task_width') : null;
    const n = raw ? parseInt(raw, 10) : NaN;
    return !isNaN(n) && n >= MIN_TASK_LIST_WIDTH && n <= MAX_TASK_LIST_WIDTH ? n : DEFAULT_TASK_LIST_WIDTH;
  });

  // Drag state
  const [dragInfo, setDragInfo] = useState<{
    nodeId: string;
    startX: number;
    originalStart: string;
    originalDue: string;
  } | null>(null);

  // Row-reorder drag state for the task-list panel. The live gesture
  // lives in a ref (so window listeners don't re-subscribe per pixel
  // of movement) and we only mirror the drop slot into React state
  // for the visual indicator + the "source is dimmed" effect.
  const reorderDragRef = useRef<{
    sourceId: string;
    sourceParentId: string;
    dropIdx: number | null;
  } | null>(null);
  const [reorderSourceId, setReorderSourceId] = useState<string | null>(null);
  const [dropIndicatorY, setDropIndicatorY] = useState<number | null>(null);

  // Refs for synchronized scrolling
  const taskListRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const timelineHeaderRef = useRef<HTMLDivElement>(null);
  const hasAutoScrolled = useRef(false);

  // ── Fetch critical path / schedule ──────────────────────────────

  useEffect(() => {
    if (!currentMapId) return;
    fetchSchedule(currentMapId)
      .then((data: unknown) => {
        const d = data as ScheduleResponse | null;
        if (d && Array.isArray(d.schedule)) {
          setServerScheduleData(d);
        }
      })
      .catch(() => {
        // Graceful fallback: no computed schedule, Gantt shows empty bars.
      });
  }, [currentMapId, nodes]);

  // ── Sequential what-if schedule ────────────────────────────────
  //
  // When sequential mode is on, we re-run the scheduler client-side with
  // synthetic FS dependencies between siblings so the Gantt can answer
  // "what if I did these one after another?" without mutating the map.
  // `parallelism = N` means N parallel tracks — sibling[i] gets an extra
  // FS dep on sibling[i - N]. N=1 is fully sequential.
  //
  // Manual startDate/dueDate pins are still honored via constraints, using
  // the same ISO→unit math as the backend schedule route.
  const sequentialResult = useMemo<{
    data: ScheduleResponse;
    edges: number;
    skipped: number;
    fills: number;
    pinnedLeaves: number;
    doneLeaves: number;
    activeLeaves: number;
    error: string | null;
  } | null>(() => {
    if (!serverScheduleData || !sequentialMode) return null;

    const unitsPerDay = serverScheduleData.unitsPerDay || 1;
    const anchor = new Date(serverScheduleData.projectStartDate);
    anchor.setUTCHours(0, 0, 0, 0);

    const nodeList = Object.values(nodes);
    if (nodeList.length === 0) {
      return {
        data: serverScheduleData,
        edges: 0,
        skipped: 0,
        fills: 0,
        pinnedLeaves: 0,
        doneLeaves: 0,
        activeLeaves: 0,
        error: 'no nodes',
      };
    }

    const p = Math.max(1, parallelism);

    // Sibling chain order = tree order (childrenIds). Users control
    // sequencing by reordering nodes in the mindmap / Gantt task list,
    // not by whatever the scheduler happened to produce. The cycle
    // filter further down still drops any edge that would reverse an
    // existing dependency, so "drag this one first" can't silently
    // break explicit FS links.

    const nodeById = new Map<string, Node>();
    for (const n of nodeList) nodeById.set(n.id, n);

    // ── Leaf-level reachability precompute ────────────────────────
    // Cycle-safe sequencing of parent siblings requires knowing, for
    // every leaf L, which leaves L transitively depends on via the
    // expanded dep graph — own dependencies plus every ancestor's,
    // with each dep target resolved to the target's leaf descendants.
    // We precompute this once and use it as the oracle for candidate
    // parent-to-parent synthetic edges: a candidate is dropped iff any
    // leaf in the follower subtree already reaches any leaf in the
    // predecessor subtree (that would close a loop after the scheduler
    // expands parent deps internally).
    const leavesOfCache = new Map<string, string[]>();
    const computeLeavesOf = (id: string): string[] => {
      const cached = leavesOfCache.get(id);
      if (cached) return cached;
      const nd = nodeById.get(id);
      if (!nd) {
        leavesOfCache.set(id, []);
        return [];
      }
      let result: string[];
      if (nd.childrenIds.length === 0) {
        result = [id];
      } else {
        result = [];
        for (const c of nd.childrenIds) result.push(...computeLeavesOf(c));
      }
      leavesOfCache.set(id, result);
      return result;
    };
    for (const n of nodeList) computeLeavesOf(n.id);

    const parentOfNode = new Map<string, string>();
    for (const n of nodeList) {
      for (const c of n.childrenIds) parentOfNode.set(c, n.id);
    }

    const allLeafIds = nodeList.filter((n) => n.childrenIds.length === 0).map((n) => n.id);

    const leafDirectDeps = new Map<string, Set<string>>();
    for (const leafId of allLeafIds) {
      const set = new Set<string>();
      let cur: string | undefined = leafId;
      while (cur) {
        const nd = nodeById.get(cur);
        if (!nd) break;
        for (const dep of nd.dependencies) {
          for (const tl of computeLeavesOf(dep.targetNodeId)) {
            if (tl !== leafId) set.add(tl);
          }
        }
        cur = parentOfNode.get(cur);
      }
      leafDirectDeps.set(leafId, set);
    }

    const leafReach = new Map<string, Set<string>>();
    for (const leafId of allLeafIds) {
      const reach = new Set<string>();
      const stack = [...(leafDirectDeps.get(leafId) ?? [])];
      while (stack.length) {
        const curId = stack.pop()!;
        if (reach.has(curId)) continue;
        reach.add(curId);
        for (const next of leafDirectDeps.get(curId) ?? []) stack.push(next);
      }
      leafReach.set(leafId, reach);
    }

    const wouldCycle = (followerId: string, predId: string): boolean => {
      const fLeaves = computeLeavesOf(followerId);
      const pLeaves = computeLeavesOf(predId);
      for (const pl of pLeaves) {
        const reach = leafReach.get(pl);
        if (!reach || reach.size === 0) continue;
        for (const fl of fLeaves) {
          if (reach.has(fl)) return true;
        }
      }
      return false;
    };

    // Extend leafReach with the effect of adding "follower depends on
    // pred" — i.e. every leaf in follower's subtree now transitively
    // reaches every leaf in pred's subtree (and everything pred's
    // leaves already reached). Also fold into any leaf that previously
    // reached a follower leaf, so chains stay consistent.
    const extendReach = (followerId: string, predId: string) => {
      const fLeaves = computeLeavesOf(followerId);
      const pLeaves = computeLeavesOf(predId);
      const addedReach = new Set<string>();
      for (const pl of pLeaves) {
        addedReach.add(pl);
        const plReach = leafReach.get(pl);
        if (plReach) for (const x of plReach) addedReach.add(x);
      }
      for (const fl of fLeaves) {
        let flReach = leafReach.get(fl);
        if (!flReach) {
          flReach = new Set();
          leafReach.set(fl, flReach);
        }
        for (const x of addedReach) flReach.add(x);
      }
      // Propagate upstream: any leaf X whose reach included any fl now
      // also reaches addedReach.
      for (const [xId, xReach] of leafReach) {
        if (xId === followerId) continue;
        let touchesFollower = false;
        for (const fl of fLeaves) {
          if (xReach.has(fl)) {
            touchesFollower = true;
            break;
          }
        }
        if (touchesFollower) {
          for (const y of addedReach) xReach.add(y);
        }
      }
    };

    const extraDeps = new Map<string, { targetNodeId: string; type: 'FS'; lag: number }[]>();
    let edges = 0;
    let skipped = 0;

    for (const n of nodeList) {
      if (n.childrenIds.length < 2) continue;
      // Top-level epics (direct children of the tree root) run in
      // parallel — sequencing them would force "finish epic A before
      // starting epic B" which isn't usually what users want. Within
      // each epic we still chain siblings; that's the useful part.
      if (n.id === rootNodeId) continue;

      // Chain in tree order — n.childrenIds IS the user-controlled
      // sequence now that drag-reorder writes to it.
      const orderedChildren = n.childrenIds;

      for (let i = p; i < orderedChildren.length; i++) {
        const follower = orderedChildren[i];
        const predecessor = orderedChildren[i - p];

        if (wouldCycle(follower, predecessor)) {
          skipped++;
          continue;
        }

        const list = extraDeps.get(follower) ?? [];
        list.push({ targetNodeId: predecessor, type: 'FS', lag: 0 });
        extraDeps.set(follower, list);
        extendReach(follower, predecessor);
        edges++;
      }
    }

    // Patch leaf durations for sequential mode. Unestimated leaves get
    // a 1-day placeholder (otherwise zero-duration bars can't cascade).
    // In-progress leaves use their REMAINING work as duration so they
    // visibly end when the remaining work does. Done leaves keep their
    // original effort so the bar still takes the same visual width in
    // the past.
    const minLeafEffort = unitsPerDay;
    let fills = 0;
    const patched: Node[] = nodeList.map((n) => {
      const extra = extraDeps.get(n.id);
      const isLeaf = n.childrenIds.length === 0;

      let effortEstimate: number | null | undefined = n.effortEstimate;
      if (isLeaf) {
        const pct = n.percentComplete ?? 0;
        const baseEffort = (n.effortEstimate ?? 0) > 0 ? (n.effortEstimate as number) : minLeafEffort;
        if ((n.effortEstimate ?? 0) <= 0) fills++;
        if (pct > 0 && pct < 100) {
          effortEstimate = Math.max(baseEffort * (1 - pct / 100), minLeafEffort);
        } else {
          effortEstimate = baseEffort;
        }
      }

      if (!extra && effortEstimate === n.effortEstimate) return n;
      return {
        ...n,
        dependencies: extra ? [...n.dependencies, ...extra] : n.dependencies,
        effortEstimate,
      };
    });

    // Constraint building. Only pin LEAVES (parent start/end rolls up
    // from children, so a parent pin is a no-op at best and a subtree
    // clamp at worst).
    //
    // Per-node pinning rules:
    //  - Done (percentComplete === 100): pin to the recent past so the
    //    bar visibly shows when it was done instead of sitting in the
    //    middle of the upcoming chain. We anchor the END at today and
    //    work backward by effort.
    //  - In progress (0 < pct < 100): pin start to today; the remaining
    //    duration extends from there. This anchors "what you're working
    //    on now" at today so downstream cascade chains from here.
    //  - Todo (0 or null pct): respect manual startDate/dueDate pins
    //    if present, otherwise let the synthetic FS cascade decide.
    const MS_PER_DAY = 86400000;
    const isoToUnits = (isoDate: string): number => {
      const d = new Date(isoDate);
      d.setUTCHours(0, 0, 0, 0);
      const calendarDays = Math.round((d.getTime() - anchor.getTime()) / MS_PER_DAY);
      return calendarDays * unitsPerDay;
    };
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayUnits = isoToUnits(today.toISOString().slice(0, 10));

    const constraints = new Map<NodeId, ScheduleConstraint>();
    let pinnedLeaves = 0;
    let doneLeaves = 0;
    let activeLeaves = 0;
    for (const n of patched) {
      if (n.childrenIds.length > 0) continue;
      const pct = n.percentComplete ?? 0;
      const effortUnits = (n.effortEstimate ?? minLeafEffort) || minLeafEffort;

      if (pct >= 100) {
        // Done → end at today, bar occupies (today - effort, today)
        constraints.set(n.id, {
          minStart: todayUnits - effortUnits,
          maxEnd: todayUnits,
        });
        doneLeaves++;
        pinnedLeaves++;
      } else if (pct > 0) {
        // In progress → start at today, remaining effort extends forward.
        // effortEstimate on the patched node was already reduced to
        // remaining, so we just pin the start and let duration do the
        // rest (pin.maxEnd = today + remaining keeps the scheduler
        // honest if its own math slightly drifts).
        constraints.set(n.id, {
          minStart: todayUnits,
          maxEnd: todayUnits + effortUnits,
        });
        activeLeaves++;
        pinnedLeaves++;
      } else {
        // Todo → honor manual pins only
        const pin: ScheduleConstraint = {};
        if (n.startDate) pin.minStart = isoToUnits(n.startDate);
        if (n.dueDate) pin.maxEnd = isoToUnits(n.dueDate);
        if (pin.minStart !== undefined || pin.maxEnd !== undefined) {
          constraints.set(n.id, pin);
          pinnedLeaves++;
        }
      }
    }

    try {
      const scheduled = computeSchedule(patched, 0, constraints);
      const cp = computeCriticalPath(patched);
      return {
        data: {
          schedule: scheduled,
          criticalPath: cp,
          projectStartDate: serverScheduleData.projectStartDate,
          effortUnit: serverScheduleData.effortUnit,
          unitsPerDay,
        },
        edges,
        skipped,
        fills,
        pinnedLeaves,
        doneLeaves,
        activeLeaves,
        error: null,
      };
    } catch (e) {
      return {
        data: serverScheduleData,
        edges,
        skipped,
        fills,
        pinnedLeaves,
        doneLeaves,
        activeLeaves,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }, [serverScheduleData, sequentialMode, parallelism, nodes]);

  // Recompute tick — bumps every time the sequential schedule runs.
  // Lets us verify from the toolbar badge whether the memo actually
  // fires on a drag.
  const recomputeCountRef = useRef(0);
  const [recomputeCount, setRecomputeCount] = useState(0);
  useEffect(() => {
    if (!sequentialMode) return;
    recomputeCountRef.current += 1;
    setRecomputeCount(recomputeCountRef.current);
  }, [sequentialResult, sequentialMode]);

  const scheduleData: ScheduleResponse | null = sequentialMode
    ? sequentialResult?.data ?? serverScheduleData
    : serverScheduleData;

  const criticalPath = scheduleData?.criticalPath ?? null;

  // ── Map computed offsets → calendar dates ──────────────────────
  //
  // The backend returns schedule entries in effort-unit space relative to
  // a projectStartDate. Convert each to a real { start, end } Date pair so
  // the rest of the Gantt (bar rendering, time range, dependency arrows)
  // can work in familiar calendar units.
  const scheduleDates = useMemo(() => {
    const map = new Map<string, { start: Date; end: Date }>();
    if (!scheduleData) return map;

    const anchor = new Date(scheduleData.projectStartDate);
    anchor.setHours(0, 0, 0, 0);
    const unitsPerDay = scheduleData.unitsPerDay || 1;

    for (const s of scheduleData.schedule) {
      const startDays = s.computedStart / unitsPerDay;
      const endDays = s.computedEnd / unitsPerDay;
      const start = new Date(anchor);
      start.setDate(start.getDate() + Math.round(startDays));
      const end = new Date(anchor);
      // Ensure at least a 1-day visual footprint for zero-duration
      // milestones and unestimated leaves so they don't vanish.
      const visibleEndDays = Math.max(endDays, startDays + (s.duration === 0 ? 0 : 1));
      end.setDate(end.getDate() + Math.round(visibleEndDays));
      map.set(s.nodeId, { start, end });
    }
    return map;
  }, [scheduleData]);

  // ── Flatten nodes into rows ────────────────────────────────────
  //
  // Walks the tree directly rather than routing through the mindmap's
  // `getVisibleNodes()` — the Gantt has its own collapse state and must
  // not inherit mindmap depth/focus, otherwise collapsed branches in the
  // mindmap silently hide their children from the Gantt (the same bug
  // KanbanView had before v0.7.1).
  //
  // Version/cycle filters still apply, with ancestor inheritance: if a
  // parent is tagged V1, its untagged children inherit V1. A subtree is
  // shown only if the current node matches the active filter.
  const rows = useMemo(() => {
    if (!rootNodeId || !nodes[rootNodeId]) return [];

    const inScope = new Set<string>();
    if (activeVersionFilter || activeCycleFilter) {
      const walkScope = (nodeId: string, inheritedVersion: string | null, inheritedCycle: string | null) => {
        const node = nodes[nodeId];
        if (!node) return;
        const effVersion = node.versionId ?? inheritedVersion;
        const effCycle = node.cycleId ?? inheritedCycle;
        const matchesVersion = !activeVersionFilter || effVersion === activeVersionFilter;
        const matchesCycle = !activeCycleFilter || effCycle === activeCycleFilter;
        if (matchesVersion && matchesCycle) inScope.add(nodeId);
        for (const cid of node.childrenIds) walkScope(cid, effVersion, effCycle);
      };
      walkScope(rootNodeId, null, null);
    }

    const result: FlatRow[] = [];
    const walk = (nodeId: string, depth: number) => {
      const node = nodes[nodeId];
      if (!node) return;
      if ((activeVersionFilter || activeCycleFilter) && !inScope.has(nodeId)) {
        // Skip this node but still descend — a tagged leaf can live under
        // an untagged parent.
        for (const cid of node.childrenIds) walk(cid, depth);
        return;
      }
      const hasChildren = node.childrenIds.length > 0;
      const isExpanded = !collapsedSet.has(nodeId);
      result.push({
        node,
        depth,
        isExpanded: hasChildren ? isExpanded : false,
        hasChildren,
      });
      if (hasChildren && isExpanded) {
        for (const cid of node.childrenIds) walk(cid, depth + 1);
      }
    };
    walk(rootNodeId, 0);
    return result;
  }, [nodes, rootNodeId, collapsedSet, activeVersionFilter, activeCycleFilter]);

  // ── Build baseline lookup ───────────────────────────────────────

  const baselineData = useMemo(() => {
    const map = new Map<string, { startDate: string | null; dueDate: string | null }>();
    if (!selectedBaseline || !currentMap) return map;
    const bl = currentMap.baselines.find((b) => b.id === selectedBaseline);
    if (!bl) return map;
    for (const [nodeId, snap] of Object.entries(bl.nodes)) {
      map.set(nodeId, { startDate: snap.startDate, dueDate: snap.dueDate });
    }
    return map;
  }, [selectedBaseline, currentMap]);

  // ── Compute time range and columns ──────────────────────────────

  const colWidth = getColumnWidth(scale);
  const { rangeStart, columns } = useMemo(
    () => computeTimeRange(rows, scale, scheduleDates, baselineData),
    [rows, scale, scheduleDates, baselineData],
  );

  const totalTimelineWidth = columns.length * colWidth;

  // ── Critical path set ───────────────────────────────────────────

  const criticalSet = useMemo(() => {
    if (!criticalPath) return new Set<string>();
    return new Set(criticalPath.path);
  }, [criticalPath]);

  // ── Row index lookup (node ID -> row index) ─────────────────────

  const rowIndexMap = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.node.id, i));
    return m;
  }, [rows]);

  // ── Auto-scroll to today ────────────────────────────────────────

  useEffect(() => {
    if (hasAutoScrolled.current || !timelineRef.current) return;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayOffset = daysBetween(rangeStart, today);
    const pxPerDay = colWidth / getStepDays(scale);
    const todayX = dayOffset * pxPerDay;
    const viewWidth = timelineRef.current.clientWidth;
    timelineRef.current.scrollLeft = Math.max(0, todayX - viewWidth / 3);
    hasAutoScrolled.current = true;
  }, [rangeStart, colWidth, scale]);

  // Reset auto-scroll flag when scale or the active schedule changes
  useEffect(() => {
    hasAutoScrolled.current = false;
  }, [scale, sequentialMode, parallelism]);

  // ── Synchronized scrolling ──────────────────────────────────────

  const handleTaskScroll = useCallback(() => {
    if (taskListRef.current && timelineRef.current) {
      timelineRef.current.scrollTop = taskListRef.current.scrollTop;
    }
  }, []);

  const handleTimelineScroll = useCallback(() => {
    if (timelineRef.current) {
      if (taskListRef.current) {
        taskListRef.current.scrollTop = timelineRef.current.scrollTop;
      }
      if (timelineHeaderRef.current) {
        timelineHeaderRef.current.scrollLeft = timelineRef.current.scrollLeft;
      }
    }
  }, []);

  // ── Toggle collapse ─────────────────────────────────────────────

  const toggleCollapse = useCallback((nodeId: string) => {
    setCollapsedSet((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  // ── Drag to reschedule ──────────────────────────────────────────

  // Bar drag uses direct listener attachment rather than a
  // useEffect-on-state-change chain, so the first mousemove isn't
  // lost to React's render-then-effect timing and the whole gesture
  // owns a single pair of handlers. Same pattern as the task-list
  // row reorder above.
  const barDragRef = useRef<{
    nodeId: string;
    startX: number;
    origStart: Date;
    origDue: Date;
    pxPerDay: number;
  } | null>(null);
  const updateNodeRef = useRef(updateNode);
  updateNodeRef.current = updateNode;

  const handleBarMouseDown = useCallback(
    (e: React.MouseEvent, nodeId: string) => {
      e.preventDefault();
      e.stopPropagation();
      const node = nodes[nodeId];
      if (!node) return;
      // Parent bars are rolled up from their children's computed
      // positions, so pinning their start/due dates is a no-op —
      // nothing visible happens and the drag feels broken. Skip.
      if (node.childrenIds.length > 0) return;
      const toIso = (d: Date) => d.toISOString().slice(0, 10);
      const computed = scheduleDates.get(nodeId);
      const originalStart = node.startDate ?? (computed ? toIso(computed.start) : null);
      const originalDue = node.dueDate ?? (computed ? toIso(computed.end) : null);
      if (!originalStart || !originalDue) return;
      const origStart = parseDate(originalStart);
      const origDue = parseDate(originalDue);
      if (!origStart || !origDue) return;

      barDragRef.current = {
        nodeId,
        startX: e.clientX,
        origStart,
        origDue,
        pxPerDay: colWidth / getStepDays(scale),
      };
      setDragInfo({
        nodeId,
        startX: e.clientX,
        originalStart,
        originalDue,
      });

      const handleMouseMove = (me: MouseEvent) => {
        const drag = barDragRef.current;
        if (!drag) return;
        const dx = me.clientX - drag.startX;
        const daysDelta = Math.round(dx / drag.pxPerDay);
        if (daysDelta === 0) return;
        const newStart = addDays(drag.origStart, daysDelta);
        const newDue = addDays(drag.origDue, daysDelta);
        updateNodeRef.current(drag.nodeId, {
          startDate: newStart.toISOString().slice(0, 10),
          dueDate: newDue.toISOString().slice(0, 10),
        });
      };

      const handleMouseUp = () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
        barDragRef.current = null;
        setDragInfo(null);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [nodes, scheduleDates, colWidth, scale],
  );

  // ── Drag-reorder rows in the task list ─────────────────────────
  //
  // Users drag a row up/down within its sibling group to rewrite the
  // parent's childrenIds — the same sequencing key the sequential
  // scheduler reads. Gesture mechanics:
  //  - reorderDragRef holds the live gesture (updated per mousemove)
  //  - reorderSourceId mirrors it to state so React can dim the row
  //  - dropIndicatorY mirrors the drop slot for the horizontal line
  //  - Window listeners attach ONCE when drag starts, detach on mouseup
  // Only same-parent drops are accepted; reparenting stays a mindmap
  // gesture.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const reorderChildrenRef = useRef(reorderChildren);
  reorderChildrenRef.current = reorderChildren;

  const handleRowMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    const target = e.target as HTMLElement;
    if (target.closest('button')) return;
    const node = nodesRef.current[nodeId];
    if (!node || !node.parentId) return;
    e.preventDefault();
    e.stopPropagation();

    reorderDragRef.current = {
      sourceId: nodeId,
      sourceParentId: node.parentId,
      dropIdx: null,
    };
    setReorderSourceId(nodeId);
    setDropIndicatorY(null);

    const handleMouseMove = (me: MouseEvent) => {
      const drag = reorderDragRef.current;
      if (!drag || !taskListRef.current) return;
      const rect = taskListRef.current.getBoundingClientRect();
      const scrollTop = taskListRef.current.scrollTop;
      const contentY = me.clientY - rect.top + scrollTop;
      const rs = rowsRef.current;
      const rowIdx = Math.floor(contentY / ROW_HEIGHT);
      if (rowIdx < 0 || rowIdx >= rs.length) {
        drag.dropIdx = null;
        setDropIndicatorY(null);
        return;
      }
      const hoverRow = rs[rowIdx];
      if (hoverRow.node.parentId !== drag.sourceParentId) {
        drag.dropIdx = null;
        setDropIndicatorY(null);
        return;
      }
      const rowTop = rowIdx * ROW_HEIGHT;
      const above = contentY - rowTop < ROW_HEIGHT / 2;
      const parent = nodesRef.current[drag.sourceParentId];
      if (!parent) return;
      const hoverInsideParent = parent.childrenIds.indexOf(hoverRow.node.id);
      if (hoverInsideParent < 0) {
        drag.dropIdx = null;
        setDropIndicatorY(null);
        return;
      }
      drag.dropIdx = above ? hoverInsideParent : hoverInsideParent + 1;
      // Indicator Y is in content space (lives inside the scrolled
      // task-list inner div), so no scrollTop math needed.
      setDropIndicatorY(above ? rowTop : rowTop + ROW_HEIGHT);
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      const drag = reorderDragRef.current;
      reorderDragRef.current = null;
      setReorderSourceId(null);
      setDropIndicatorY(null);
      if (!drag || drag.dropIdx == null) return;

      const parent = nodesRef.current[drag.sourceParentId];
      if (!parent) return;
      const srcIdx = parent.childrenIds.indexOf(drag.sourceId);
      if (srcIdx < 0) return;
      let target = drag.dropIdx;
      if (target > srcIdx) target -= 1;
      if (target === srcIdx) return; // no-op
      const next = [...parent.childrenIds];
      next.splice(srcIdx, 1);
      next.splice(target, 0, drag.sourceId);
      reorderChildrenRef.current(drag.sourceParentId, next);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, []);

  // ── Drag-resize the task-list / timeline split ────────────────
  const splitRootRef = useRef<HTMLDivElement>(null);
  const handleSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const rootLeft = splitRootRef.current?.getBoundingClientRect().left ?? 0;
    const startWidth = taskListWidth;

    const handleMove = (me: MouseEvent) => {
      const delta = me.clientX - startX;
      const next = Math.max(
        MIN_TASK_LIST_WIDTH,
        Math.min(MAX_TASK_LIST_WIDTH, startWidth + delta),
      );
      // Also cap at "don't run off the right edge of the container".
      const containerWidth = splitRootRef.current?.clientWidth ?? next;
      setTaskListWidth(Math.min(next, containerWidth - 200));
      // rootLeft is captured just in case we later want absolute math.
      void rootLeft;
    };
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        window.localStorage.setItem('mindblown_gantt_task_width', String(taskListWidth));
      } catch {
        /* ignore */
      }
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [taskListWidth]);

  // Persist the new width after changes settle so the localStorage
  // value is always the latest.
  useEffect(() => {
    try {
      window.localStorage.setItem('mindblown_gantt_task_width', String(taskListWidth));
    } catch {
      /* ignore */
    }
  }, [taskListWidth]);

  // ── Position helpers ────────────────────────────────────────────

  const pxPerDay = colWidth / getStepDays(scale);

  const getBarX = useCallback(
    (startDate: Date): number => {
      return daysBetween(rangeStart, startDate) * pxPerDay;
    },
    [rangeStart, pxPerDay],
  );

  const getBarWidth = useCallback(
    (startDate: Date, dueDate: Date): number => {
      return Math.max(daysBetween(startDate, dueDate) * pxPerDay, 4);
    },
    [pxPerDay],
  );

  // ── Today line position ─────────────────────────────────────────

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayX = daysBetween(rangeStart, today) * pxPerDay;

  // ── Render ──────────────────────────────────────────────────────

  const totalHeight = rows.length * ROW_HEIGHT;
  const baselines = currentMap?.baselines ?? [];

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: '#ffffff',
        overflow: 'hidden',
        fontFamily: 'inherit',
      }}
    >
      {/* ── Toolbar ──────────────────────────────────────────────── */}
      <div
        style={{
          height: 40,
          minHeight: 40,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 16px',
          borderBottom: '1px solid #e2e8f0',
          background: '#f8fafc',
          fontSize: 12,
        }}
      >
        {/* Scale selector */}
        <span style={{ fontWeight: 600, color: '#64748b' }}>Zoom:</span>
        {(['day', 'week', 'month', 'quarter'] as TimeScale[]).map((s) => (
          <button
            key={s}
            onClick={() => setScale(s)}
            style={{
              padding: '3px 10px',
              borderRadius: 4,
              border: 'none',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: 'pointer',
              background: scale === s ? '#4f46e5' : 'transparent',
              color: scale === s ? '#fff' : '#64748b',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}

        <div style={{ width: 1, height: 20, background: '#e2e8f0' }} />

        {/* Scroll to today */}
        <button
          onClick={() => {
            if (!timelineRef.current) return;
            const viewWidth = timelineRef.current.clientWidth;
            timelineRef.current.scrollLeft = Math.max(0, todayX - viewWidth / 3);
          }}
          style={{
            padding: '3px 10px',
            borderRadius: 4,
            border: '1px solid #e2e8f0',
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: 'pointer',
            background: '#fff',
            color: '#ef4444',
          }}
        >
          Today
        </button>

        {/* Sequential what-if toggle */}
        <div style={{ width: 1, height: 20, background: '#e2e8f0' }} />
        <button
          onClick={() => setSequentialMode((v) => !v)}
          title="Preview what happens if siblings are done one after another. Doesn't mutate the map."
          style={{
            padding: '3px 10px',
            borderRadius: 4,
            border: '1px solid #e2e8f0',
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: 'pointer',
            background: sequentialMode ? '#4f46e5' : '#fff',
            color: sequentialMode ? '#fff' : '#475569',
          }}
        >
          Sequential
        </button>
        {sequentialMode && (
          <>
            <span style={{ fontWeight: 600, color: '#64748b' }}>People:</span>
            <input
              type="number"
              min={1}
              max={20}
              value={parallelism}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1) setParallelism(Math.min(20, v));
              }}
              style={{
                width: 48,
                fontSize: 11,
                fontFamily: 'inherit',
                border: '1px solid #e2e8f0',
                borderRadius: 4,
                padding: '2px 6px',
                color: '#475569',
                background: '#fff',
              }}
            />
            {sequentialResult && (
              <span
                style={{
                  fontSize: 11,
                  color: sequentialResult.error ? '#dc2626' : '#64748b',
                  fontStyle: 'italic',
                }}
                title={sequentialResult.error ?? 'Synthetic FS edges added between siblings. Unestimated leaves get a 1-day placeholder.'}
              >
                {sequentialResult.error
                  ? `error: ${sequentialResult.error}`
                  : `${sequentialResult.edges} edges, ${sequentialResult.doneLeaves} done, ${sequentialResult.activeLeaves} active, ${sequentialResult.skipped} skipped · recomputes: ${recomputeCount}`}
              </span>
            )}
          </>
        )}

        {/* Baseline selector */}
        {baselines.length > 0 && (
          <>
            <div style={{ width: 1, height: 20, background: '#e2e8f0' }} />
            <span style={{ fontWeight: 600, color: '#64748b' }}>Baseline:</span>
            <select
              value={selectedBaseline ?? ''}
              onChange={(e) => setSelectedBaseline(e.target.value || null)}
              style={{
                fontSize: 11,
                fontFamily: 'inherit',
                border: '1px solid #e2e8f0',
                borderRadius: 4,
                padding: '2px 6px',
                color: '#475569',
                background: '#fff',
              }}
            >
              <option value="">None</option>
              {baselines.map((bl) => (
                <option key={bl.id} value={bl.id}>
                  {bl.name}
                </option>
              ))}
            </select>
          </>
        )}

        {/* Critical path indicator */}
        {criticalPath && criticalPath.path.length > 0 && (
          <>
            <div style={{ width: 1, height: 20, background: '#e2e8f0' }} />
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: '#dc2626',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect width="10" height="10" rx="2" fill="#dc2626" opacity="0.2" />
                <rect x="1" y="1" width="8" height="8" rx="1.5" fill="none" stroke="#dc2626" strokeWidth="1.5" />
              </svg>
              Critical path ({criticalPath.path.length} tasks)
            </span>
          </>
        )}
      </div>

      {/* ── Main split pane ──────────────────────────────────────── */}
      <div ref={splitRootRef} style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* ── Left panel: Task list ──────────────────────────────── */}
        <div
          style={{
            width: taskListWidth,
            minWidth: taskListWidth,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            background: '#ffffff',
          }}
        >
          {/* Task list header */}
          <div
            style={{
              height: HEADER_HEIGHT,
              minHeight: HEADER_HEIGHT,
              display: 'flex',
              alignItems: 'center',
              borderBottom: '1px solid #e2e8f0',
              background: '#f8fafc',
              fontSize: 10,
              fontWeight: 700,
              color: '#64748b',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              padding: '0 8px',
            }}
          >
            <div style={{ flex: 1, paddingLeft: 8 }}>Task</div>
            <div style={{ width: 50, textAlign: 'center' }}>Effort</div>
            <div style={{ width: 40, textAlign: 'center' }}>%</div>
            <div style={{ width: 56, textAlign: 'center' }}>Status</div>
            <div style={{ width: 40, textAlign: 'center' }}>Health</div>
          </div>

          {/* Task rows */}
          <div
            ref={taskListRef}
            onScroll={handleTaskScroll}
            style={{
              flex: 1,
              overflowY: 'auto',
              overflowX: 'hidden',
            }}
          >
            <div style={{ height: totalHeight, position: 'relative' }}>
              {dropIndicatorY != null && (
                <div
                  style={{
                    position: 'absolute',
                    left: 4,
                    right: 4,
                    top: dropIndicatorY - 1,
                    height: 2,
                    background: '#4f46e5',
                    pointerEvents: 'none',
                    zIndex: 10,
                    borderRadius: 1,
                  }}
                />
              )}
              {rows.map((row, idx) => {
                const cv = computed.get(row.node.id);
                const health = cv?.healthSignal ?? 'on_track';
                const progress = cv?.computedProgress ?? row.node.percentComplete ?? 0;
                const effort = cv?.computedEffort ?? row.node.effortEstimate ?? 0;
                const isSelected = row.node.id === selectedNodeId;

                const isDragging = reorderSourceId === row.node.id;
                const canDrag = !!row.node.parentId;
                return (
                  <div
                    key={row.node.id}
                    onClick={() => selectNode(row.node.id)}
                    style={{
                      height: ROW_HEIGHT,
                      display: 'flex',
                      alignItems: 'center',
                      padding: '0 8px 0 0',
                      borderBottom: '1px solid #f1f5f9',
                      background: isSelected ? '#eef2ff' : idx % 2 === 0 ? '#fff' : '#fafbfc',
                      cursor: 'pointer',
                      opacity: isDragging ? 0.4 : 1,
                      transition: 'background 0.1s, opacity 0.1s',
                      fontSize: 12,
                      userSelect: 'none',
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected && !reorderSourceId) e.currentTarget.style.background = '#f8fafc';
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected && !reorderSourceId)
                        e.currentTarget.style.background = idx % 2 === 0 ? '#fff' : '#fafbfc';
                    }}
                  >
                    {/* Drag grip */}
                    <div
                      onMouseDown={canDrag ? (e) => handleRowMouseDown(e, row.node.id) : undefined}
                      onClick={(e) => e.stopPropagation()}
                      title={canDrag ? 'Drag to reorder' : 'Root node'}
                      style={{
                        width: 14,
                        height: ROW_HEIGHT,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: canDrag ? (reorderSourceId ? 'grabbing' : 'grab') : 'default',
                        color: '#cbd5e1',
                        flexShrink: 0,
                      }}
                    >
                      {canDrag && (
                        <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor">
                          <circle cx="2" cy="3" r="1" />
                          <circle cx="6" cy="3" r="1" />
                          <circle cx="2" cy="7" r="1" />
                          <circle cx="6" cy="7" r="1" />
                          <circle cx="2" cy="11" r="1" />
                          <circle cx="6" cy="11" r="1" />
                        </svg>
                      )}
                    </div>
                    {/* Name with indent + expand toggle */}
                    <div
                      style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        minWidth: 0,
                        paddingLeft: row.depth * 16,
                      }}
                    >
                      {row.hasChildren ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleCollapse(row.node.id);
                          }}
                          style={{
                            width: 16,
                            height: 16,
                            border: 'none',
                            background: 'none',
                            cursor: 'pointer',
                            padding: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: '#94a3b8',
                            flexShrink: 0,
                          }}
                        >
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 10 10"
                            fill="currentColor"
                            style={{
                              transform: row.isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                              transition: 'transform 0.15s',
                            }}
                          >
                            <path d="M3 1L8 5L3 9z" />
                          </svg>
                        </button>
                      ) : (
                        <div style={{ width: 16, flexShrink: 0 }} />
                      )}

                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontWeight: row.depth === 0 ? 700 : row.hasChildren ? 600 : 400,
                          color: '#1e293b',
                        }}
                        title={row.node.text}
                      >
                        {row.node.text}
                      </span>
                    </div>

                    {/* Effort */}
                    <div
                      style={{
                        width: 50,
                        textAlign: 'center',
                        color: '#64748b',
                        fontSize: 11,
                        flexShrink: 0,
                      }}
                    >
                      {effort > 0 ? `${effort}d` : '-'}
                    </div>

                    {/* Progress */}
                    <div
                      style={{
                        width: 40,
                        textAlign: 'center',
                        color: '#64748b',
                        fontSize: 11,
                        fontWeight: 500,
                        flexShrink: 0,
                      }}
                    >
                      {Math.round(progress)}%
                    </div>

                    {/* Status */}
                    <div
                      style={{
                        width: 56,
                        textAlign: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {row.node.status && (
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 600,
                            padding: '1px 5px',
                            borderRadius: 3,
                            background: '#f1f5f9',
                            color: '#475569',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {STATUS_LABELS[row.node.status] ?? row.node.status}
                        </span>
                      )}
                    </div>

                    {/* Health dot */}
                    <div
                      style={{
                        width: 40,
                        display: 'flex',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <div
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: HEALTH_COLORS[health] ?? HEALTH_COLORS.on_track,
                        }}
                        title={health.replace('_', ' ')}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── Resizer divider ────────────────────────────────────── */}
        <div
          onMouseDown={handleSplitMouseDown}
          title="Drag to resize"
          style={{
            width: 6,
            minWidth: 6,
            cursor: 'col-resize',
            background: '#e2e8f0',
            borderLeft: '1px solid #cbd5e1',
            borderRight: '1px solid #cbd5e1',
            flexShrink: 0,
            userSelect: 'none',
          }}
        />

        {/* ── Right panel: Timeline ──────────────────────────────── */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Timeline header */}
          <div
            ref={timelineHeaderRef}
            style={{
              height: HEADER_HEIGHT,
              minHeight: HEADER_HEIGHT,
              overflow: 'hidden',
              borderBottom: '1px solid #e2e8f0',
              background: '#f8fafc',
              position: 'relative',
            }}
          >
            <div style={{ width: totalTimelineWidth, height: '100%', position: 'relative' }}>
              {columns.map((col, i) => {
                const isToday =
                  col.getFullYear() === today.getFullYear() &&
                  col.getMonth() === today.getMonth() &&
                  col.getDate() === today.getDate();
                return (
                  <div
                    key={i}
                    style={{
                      position: 'absolute',
                      left: i * colWidth,
                      width: colWidth,
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 10,
                      fontWeight: isToday ? 700 : 500,
                      color: isToday ? '#ef4444' : '#64748b',
                      borderRight: '1px solid #e2e8f0',
                      userSelect: 'none',
                    }}
                  >
                    {formatDate(col, scale)}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Timeline body */}
          <div
            ref={timelineRef}
            onScroll={handleTimelineScroll}
            style={{
              flex: 1,
              overflow: 'auto',
              position: 'relative',
            }}
          >
            <div
              style={{
                width: totalTimelineWidth,
                height: totalHeight,
                position: 'relative',
              }}
            >
              {/* Grid lines (vertical) */}
              {columns.map((_, i) => (
                <div
                  key={`grid-${i}`}
                  style={{
                    position: 'absolute',
                    left: i * colWidth,
                    top: 0,
                    width: 1,
                    height: totalHeight,
                    background: '#f1f5f9',
                    pointerEvents: 'none',
                  }}
                />
              ))}

              {/* Row backgrounds (horizontal lines) */}
              {rows.map((row, idx) => (
                <div
                  key={`rowbg-${row.node.id}`}
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: idx * ROW_HEIGHT,
                    width: totalTimelineWidth,
                    height: ROW_HEIGHT,
                    borderBottom: '1px solid #f1f5f9',
                    background:
                      row.node.id === selectedNodeId
                        ? '#eef2ff'
                        : idx % 2 === 0
                          ? '#fff'
                          : '#fafbfc',
                  }}
                />
              ))}

              {/* Today line */}
              {todayX > 0 && todayX < totalTimelineWidth && (
                <div
                  style={{
                    position: 'absolute',
                    left: todayX,
                    top: 0,
                    width: 0,
                    height: totalHeight,
                    borderLeft: '2px dashed #ef4444',
                    pointerEvents: 'none',
                    zIndex: 5,
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      top: -2,
                      left: -10,
                      width: 20,
                      height: 4,
                      borderRadius: 2,
                      background: '#ef4444',
                    }}
                  />
                </div>
              )}

              {/* SVG overlay for bars, arrows, diamonds */}
              <svg
                width={totalTimelineWidth}
                height={totalHeight}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  pointerEvents: 'none',
                }}
              >
                <defs>
                  <marker
                    id={ARROW_MARKER_ID}
                    markerWidth="8"
                    markerHeight="6"
                    refX="8"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L8,3 L0,6 z" fill="#94a3b8" />
                  </marker>
                </defs>

                {/* ── Baseline bars (thin gray outlines) ──────────── */}
                {selectedBaseline &&
                  rows.map((row, idx) => {
                    const bl = baselineData.get(row.node.id);
                    if (!bl) return null;
                    const bs = parseDate(bl.startDate);
                    const bd = parseDate(bl.dueDate);
                    if (!bs || !bd) return null;

                    const x = getBarX(bs);
                    const w = getBarWidth(bs, bd);
                    const y = idx * ROW_HEIGHT + ROW_HEIGHT / 2 - 4;

                    return (
                      <rect
                        key={`bl-${row.node.id}`}
                        x={x}
                        y={y}
                        width={w}
                        height={8}
                        rx={2}
                        fill="none"
                        stroke="#cbd5e1"
                        strokeWidth={1.5}
                        strokeDasharray="4 2"
                        opacity={0.7}
                      />
                    );
                  })}

                {/* ── Task bars ──────────────────────────────────── */}
                {rows.map((row, idx) => {
                  // Bar positions come from the computed schedule (effort +
                  // dependencies + manual pins), NOT directly from
                  // node.startDate/dueDate. Manual dates are still honored,
                  // but only as pinning constraints that the scheduler
                  // incorporates server-side.
                  const dates = scheduleDates.get(row.node.id);
                  if (!dates) return null;
                  const startDate = dates.start;
                  const dueDate = dates.end;

                  const cv = computed.get(row.node.id);
                  const health = cv?.healthSignal ?? 'on_track';
                  const progress = cv?.computedProgress ?? row.node.percentComplete ?? 0;
                  const isCritical = criticalSet.has(row.node.id);
                  const isSelected = row.node.id === selectedNodeId;
                  const barColor = HEALTH_COLORS[health] ?? HEALTH_COLORS.on_track;

                  const centerY = idx * ROW_HEIGHT + ROW_HEIGHT / 2;

                  // Regular bar
                  const x = getBarX(startDate);
                  const w = getBarWidth(startDate, dueDate);
                  const barH = 16;
                  const y = centerY - barH / 2;
                  const fillW = w * (progress / 100);

                  const isLeafBar = row.node.childrenIds.length === 0;
                  return (
                    <g
                      key={`bar-${row.node.id}`}
                      style={{
                        pointerEvents: 'auto',
                        cursor: isLeafBar ? (dragInfo ? 'grabbing' : 'grab') : 'pointer',
                      }}
                      onMouseDown={(e) => handleBarMouseDown(e, row.node.id)}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectNode(row.node.id);
                      }}
                    >
                      {/* Background (track) */}
                      <rect
                        x={x}
                        y={y}
                        width={w}
                        height={barH}
                        rx={4}
                        fill={HEALTH_BG[health] ?? HEALTH_BG.on_track}
                        stroke={isCritical ? '#dc2626' : isSelected ? '#4f46e5' : barColor}
                        strokeWidth={isCritical ? 2.5 : isSelected ? 2 : 1}
                      />
                      {/* Progress fill */}
                      {fillW > 0 && (
                        <rect
                          x={x}
                          y={y}
                          width={Math.min(fillW, w)}
                          height={barH}
                          rx={4}
                          fill={barColor}
                          opacity={0.7}
                        />
                      )}
                      {/* Text label on bar */}
                      {w > 50 && (
                        <text
                          x={x + 6}
                          y={centerY + 4}
                          fontSize={10}
                          fontWeight={600}
                          fill={progress > 40 ? '#fff' : '#475569'}
                        >
                          {Math.round(progress)}%
                        </text>
                      )}
                    </g>
                  );
                })}

                {/* ── Dependency arrows ───────────────────────────── */}
                {rows.map((row, depIdx) => {
                  if (row.node.dependencies.length === 0) return null;
                  const successorDates = scheduleDates.get(row.node.id);
                  if (!successorDates) return null;
                  const toX = getBarX(successorDates.start);
                  const toY = depIdx * ROW_HEIGHT + ROW_HEIGHT / 2;

                  return row.node.dependencies.map((dep) => {
                    const predIdx = rowIndexMap.get(dep.targetNodeId);
                    if (predIdx === undefined) return null;
                    const pred = rows[predIdx];
                    const predDates = scheduleDates.get(pred.node.id);
                    if (!predDates) return null;

                    const fromX = getBarX(predDates.end);
                    const fromY = predIdx * ROW_HEIGHT + ROW_HEIGHT / 2;

                    return (
                      <path
                        key={`dep-${dep.targetNodeId}-${row.node.id}`}
                        d={computeArrowPath(fromX, fromY, toX, toY)}
                        fill="none"
                        stroke="#94a3b8"
                        strokeWidth={1.5}
                        markerEnd={`url(#${ARROW_MARKER_ID})`}
                        opacity={0.6}
                      />
                    );
                  });
                })}
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
