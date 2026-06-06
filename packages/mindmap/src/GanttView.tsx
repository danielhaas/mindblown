import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Node, NodeId, CriticalPathResult, ScheduledNode, ScheduleConstraint } from '@mindblown/core';
import {
  schedule as computeSchedule,
  criticalPath as computeCriticalPath,
  addBusinessDays,
  businessDaysBetween,
} from '@mindblown/core';
import { useMindmapStore } from './store.js';
import { fetchSchedule, updateMap as updateMapApi } from './api.js';

// ── Schedule response shape (from GET /api/maps/:id/schedule) ────

interface ScheduleResponse {
  schedule: ScheduledNode[];
  criticalPath: CriticalPathResult;
  projectStartDate: string; // ISO YYYY-MM-DD
  effortUnit: 'hours' | 'days' | 'points';
  unitsPerDay: number;
  workerCount: number;
}

// ── Constants ─────────────────────────────────────────────────────

const DEFAULT_TASK_LIST_WIDTH = 600;
const MIN_TASK_LIST_WIDTH = 180;
const MAX_TASK_LIST_WIDTH = 1200;
// Bumped whenever the default changes so users with cached widths
// pick up the new default on next load.
const TASK_WIDTH_STORAGE_KEY = 'mindblown_gantt_task_width_v3';
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

// Working-day helpers live in @mindblown/core (addBusinessDays,
// businessDaysBetween) so the scheduler and the Gantt renderer share one
// implementation. Public holidays will be threaded through their optional
// `holidays?: Set<string>` parameter when #110 lands.

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
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  // Workers value the user is editing in the toolbar. Defaults to the
  // server-returned schedule's workerCount; on change we call
  // updateMap({workerCount}) and the schedule refetches.
  const [workersInput, setWorkersInput] = useState<number>(1);
  const [savingWorkers, setSavingWorkers] = useState(false);
  const [showBehindOnly, setShowBehindOnly] = useState(false);
  const [taskListWidth, setTaskListWidth] = useState<number>(() => {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(TASK_WIDTH_STORAGE_KEY) : null;
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

  const scheduleData: ScheduleResponse | null = serverScheduleData;
  const criticalPath = scheduleData?.criticalPath ?? null;

  // Sync the visible Workers input to whatever the server says.
  useEffect(() => {
    if (scheduleData?.workerCount !== undefined) {
      setWorkersInput(Math.max(1, Math.floor(scheduleData.workerCount)));
    }
  }, [scheduleData?.workerCount]);

  // Auto-save the Workers value on change with a small debounce — fires
  // ~300ms after the user stops typing, so a single quick edit "3 → 30"
  // doesn't kick off two competing requests, but the user doesn't have to
  // blur the input to see the timeline rescale.
  useEffect(() => {
    if (!currentMapId) return;
    const current = scheduleData?.workerCount ?? 1;
    if (workersInput === current) return;
    if (savingWorkers) return; // a save is already in flight
    const timer = window.setTimeout(async () => {
      setSavingWorkers(true);
      try {
        await updateMapApi(currentMapId, { workerCount: workersInput });
        const refreshed = (await fetchSchedule(currentMapId)) as ScheduleResponse;
        setServerScheduleData(refreshed);
        setSavedFlash(`Workers: ${workersInput}`);
        window.setTimeout(() => setSavedFlash(null), 2000);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[gantt] failed to update workerCount:', err);
        setWorkersInput(current); // revert the visible value
      } finally {
        setSavingWorkers(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [workersInput, currentMapId, scheduleData?.workerCount, savingWorkers]);

  // ── Map computed offsets → calendar dates ──────────────────────
  //
  // The backend returns schedule entries in effort-unit space relative to
  // a projectStartDate. Convert each to a real { start, end } Date pair so
  // the rest of the Gantt (bar rendering, time range, dependency arrows)
  // can work in familiar calendar units.
  const scheduleDates = useMemo(() => {
    const map = new Map<string, { start: Date; end: Date }>();
    if (!scheduleData) return map;

    const anchorLocal = new Date(scheduleData.projectStartDate);
    anchorLocal.setHours(0, 0, 0, 0);
    const unitsPerDay = scheduleData.unitsPerDay || 1;

    // Server schedule is in straight calendar days from the project anchor.
    for (const s of scheduleData.schedule) {
      const startDays = s.computedStart / unitsPerDay;
      const endDays = s.computedEnd / unitsPerDay;
      const visibleEndDays = Math.max(endDays, startDays + (s.duration === 0 ? 0 : 1));
      const start = new Date(anchorLocal);
      start.setDate(start.getDate() + Math.round(startDays));
      const end = new Date(anchorLocal);
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

    // "Behind only" filter keeps any leaf flagged behind (via computed
    // health) plus every ancestor up to the root, so the tree shape
    // still holds in the task list.
    const behindKeep = new Set<string>();
    if (showBehindOnly) {
      const parentOf = new Map<string, string>();
      for (const n of Object.values(nodes)) {
        for (const cid of n.childrenIds) parentOf.set(cid, n.id);
      }
      for (const n of Object.values(nodes)) {
        if (n.childrenIds.length > 0) continue;
        const cv = computed.get(n.id);
        if (cv?.healthSignal !== 'behind') continue;
        let cur: string | undefined = n.id;
        while (cur && !behindKeep.has(cur)) {
          behindKeep.add(cur);
          cur = parentOf.get(cur);
        }
      }
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
      if (showBehindOnly && !behindKeep.has(nodeId)) {
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
  }, [
    nodes,
    rootNodeId,
    collapsedSet,
    activeVersionFilter,
    activeCycleFilter,
    showBehindOnly,
    computed,
  ]);

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
  }, [scale]);

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

      // ── Write priorityRank for the dropped node ─────────────────
      // Use midpoint insertion: new rank = (predecessor.rank + successor.rank) / 2.
      // If dropping at the start/end, use successor.rank - 1 / predecessor.rank + 1.
      // Fallback: assign sequential integers if siblings lack ranks.
      const siblings = next
        .filter((cid) => cid !== drag.sourceId)
        .map((cid) => nodesRef.current[cid]);
      const dropInFinal = next.indexOf(drag.sourceId);
      const before = dropInFinal > 0 ? nodesRef.current[next[dropInFinal - 1]] : null;
      const after = dropInFinal < next.length - 1 ? nodesRef.current[next[dropInFinal + 1]] : null;

      let newRank: number;
      const RANK_STEP = 65536; // initial gap between ranks for new lists

      if (before === undefined && after === undefined) {
        // Only node — use 0
        newRank = 0;
      } else if (before == null && after != null) {
        // Dropped at start
        const afterRank = after.priorityRank ?? (siblings.indexOf(after) + 1) * RANK_STEP;
        newRank = afterRank - RANK_STEP;
      } else if (before != null && after == null) {
        // Dropped at end
        const beforeRank = before.priorityRank ?? (siblings.indexOf(before) + 1) * RANK_STEP;
        newRank = beforeRank + RANK_STEP;
      } else if (before != null && after != null) {
        // Dropped between two nodes — midpoint
        const br = before.priorityRank ?? (siblings.indexOf(before) + 1) * RANK_STEP;
        const ar = after.priorityRank ?? (siblings.indexOf(after) + 1) * RANK_STEP;
        newRank = (br + ar) / 2;
      } else {
        newRank = 0;
      }

      // Renumber if midpoint collapsed within epsilon (float precision guard)
      const EPSILON = 1e-9;
      const beforeRankFinal = before?.priorityRank ?? null;
      const afterRankFinal = after?.priorityRank ?? null;
      const collapsed =
        (beforeRankFinal !== null && Math.abs(newRank - beforeRankFinal) < EPSILON) ||
        (afterRankFinal !== null && Math.abs(newRank - afterRankFinal) < EPSILON);

      if (collapsed) {
        // Renumber all siblings with fresh sequential ranks
        next.forEach((cid, idx) => {
          updateNodeRef.current(cid, { priorityRank: (idx + 1) * RANK_STEP });
        });
      } else {
        updateNodeRef.current(drag.sourceId, { priorityRank: newRank });
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, []);

  // ── Save the sequential what-if plan to real start/due dates ──
  //
  // Iterates the currently-visible rows, picks out todo leaves (done
  // and in-progress leaves have special "today-relative" pins that
  // aren't meaningful to persist), and writes each one's scheduleDates
  // position as startDate / dueDate via updateNode.
  //
  // The store's updateNode is optimistic + fires one API call per
  // node. For the typical sprint scope that's a few dozen writes;
  // we run them in parallel.
  // Push every visible behind leaf forward so nothing is overdue.
  // Preserves relative spacing by shifting all behind leaves by the
  // SAME delta (the maximum overdue amount plus a 1-day buffer), so
  // the plan keeps its shape; only the zero point moves to the future.
  const handlePushBehind = useCallback(() => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayMs = today.getTime();

    const behind: Node[] = [];
    for (const row of rows) {
      const node = row.node;
      if (node.childrenIds.length > 0) continue;
      const cv = computed.get(node.id);
      if (cv?.healthSignal !== 'behind') continue;
      behind.push(node);
    }
    if (behind.length === 0) {
      setSavedFlash('Nothing is behind');
      window.setTimeout(() => setSavedFlash(null), 3000);
      return;
    }

    let maxOverdueDays = 0;
    for (const n of behind) {
      if (!n.dueDate) continue;
      const due = new Date(n.dueDate);
      due.setUTCHours(0, 0, 0, 0);
      const days = Math.ceil((todayMs - due.getTime()) / 86400000);
      if (days > maxOverdueDays) maxOverdueDays = days;
    }
    const shiftDays = Math.max(1, maxOverdueDays + 1);

    const addIso = (iso: string, days: number) => {
      const d = new Date(iso);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };

    for (const n of behind) {
      const updates: Partial<Node> = {};
      if (n.dueDate) updates.dueDate = addIso(n.dueDate, shiftDays);
      if (n.startDate) updates.startDate = addIso(n.startDate, shiftDays);
      if (Object.keys(updates).length > 0) updateNode(n.id, updates);
    }

    setSavedFlash(
      `Shifted ${behind.length} behind task${behind.length === 1 ? '' : 's'} +${shiftDays}d`,
    );
    window.setTimeout(() => setSavedFlash(null), 3000);
  }, [rows, computed, updateNode]);

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
        window.localStorage.setItem(TASK_WIDTH_STORAGE_KEY, String(taskListWidth));
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
      window.localStorage.setItem(TASK_WIDTH_STORAGE_KEY, String(taskListWidth));
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

        {/* Behind filter + push overdue */}
        <div style={{ width: 1, height: 20, background: '#e2e8f0' }} />
        <button
          onClick={() => setShowBehindOnly((v) => !v)}
          title="Show only leaves that are overdue (dueDate past, not 100%) and their ancestors"
          style={{
            padding: '3px 10px',
            borderRadius: 4,
            border: '1px solid #fecaca',
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: 'pointer',
            background: showBehindOnly ? '#ef4444' : '#fff',
            color: showBehindOnly ? '#fff' : '#dc2626',
          }}
        >
          Behind only
        </button>
        <button
          onClick={handlePushBehind}
          title="Shift every visible behind leaf's startDate and dueDate forward by the maximum overdue amount + 1 day, so nothing stays overdue but the relative spacing is preserved."
          style={{
            padding: '3px 10px',
            borderRadius: 4,
            border: '1px solid #f59e0b',
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: 'pointer',
            background: '#fff',
            color: '#b45309',
          }}
        >
          Push overdue
        </button>

        {/* Workers: how many parallel tracks the schedule projects onto */}
        <div style={{ width: 1, height: 20, background: '#e2e8f0' }} />
        <span style={{ fontWeight: 600, color: '#64748b' }}>Workers:</span>
        <input
          type="number"
          min={1}
          max={100}
          value={workersInput}
          disabled={savingWorkers}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v) && v >= 1) setWorkersInput(Math.min(100, v));
          }}
          title="Number of parallel work tracks. View knob — the underlying plan (priorities + estimates + deps) is unchanged. Higher = more parallelism shrinks the timeline."
          style={{
            width: 48,
            fontSize: 11,
            fontFamily: 'inherit',
            border: '1px solid #e2e8f0',
            borderRadius: 4,
            padding: '2px 6px',
            color: '#475569',
            background: savingWorkers ? '#f1f5f9' : '#fff',
          }}
        />
        {savedFlash && (
          <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 600 }}>
            ✓ {savedFlash}
          </span>
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
                  const fmt = (d: Date) =>
                    d.toLocaleDateString(undefined, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    });
                  const durDays = Math.max(1, Math.round(daysBetween(startDate, dueDate)));
                  const statusLabel =
                    row.node.status
                      ? (STATUS_LABELS[row.node.status] ?? row.node.status)
                      : 'no status';
                  const tooltip = `${row.node.text}\n${fmt(startDate)} → ${fmt(dueDate)}  (${durDays}d)\n${Math.round(progress)}% · ${statusLabel}`;
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
                      <title>{tooltip}</title>
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
