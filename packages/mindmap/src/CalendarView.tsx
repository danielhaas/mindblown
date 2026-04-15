import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMindmapStore } from './store.js';
import type {
  Node,
  HealthSignal,
  Priority,
  Version,
  Cycle,
  ScheduledNode,
  CriticalPathResult,
} from '@mindblown/core';
import * as api from './api.js';
import type { ReleaseForecastResponse, CalendarSubscribeUrls } from './api.js';

// Shape of GET /api/maps/:id/schedule — mirrors GanttView's local type.
interface ScheduleResponse {
  schedule: ScheduledNode[];
  criticalPath: CriticalPathResult;
  projectStartDate: string;
  effortUnit: 'hours' | 'days' | 'points';
  unitsPerDay: number;
}

// ── Constants ────────────────────────────────────────────────────

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const HEALTH_COLORS: Record<HealthSignal, string> = {
  on_track: '#10b981',
  at_risk: '#f59e0b',
  behind: '#ef4444',
};

const PRIORITY_COLORS: Record<Priority, string> = {
  P0: '#dc2626',
  P1: '#f97316',
  P2: '#3b82f6',
  P3: '#9ca3af',
};

// Cycle band tint per status. Alpha is applied on the cell background.
const CYCLE_TINT: Record<Cycle['status'], string> = {
  planned: '#64748b',
  active: '#3b82f6',
  completed: '#10b981',
};

type CalendarMode = 'month' | 'week';

// ── Date helpers ─────────────────────────────────────────────────

/** Return a date-only string YYYY-MM-DD from Date (local timezone). */
function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse YYYY-MM-DD or ISO string into a local-midnight Date. */
function parseDate(iso: string): Date {
  // Take only the date portion to avoid timezone shifts
  const parts = iso.slice(0, 10).split('-');
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

/** Monday-based day of week: 0=Mon ... 6=Sun */
function mondayDow(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/** Get all dates for the calendar grid (month view). Starts on Monday. */
function getMonthGrid(year: number, month: number): Date[] {
  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth = new Date(year, month + 1, 0);

  // Start from Monday of the week containing the 1st
  const startOffset = mondayDow(firstOfMonth);
  const gridStart = new Date(year, month, 1 - startOffset);

  // End on Sunday of the week containing the last day
  const endOffset = 6 - mondayDow(lastOfMonth);
  const gridEnd = new Date(year, month + 1, endOffset);

  const dates: Date[] = [];
  const current = new Date(gridStart);
  while (current <= gridEnd) {
    dates.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

/** Get all dates for a week view starting from a Monday. */
function getWeekGrid(weekStart: Date): Date[] {
  const dates: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    dates.push(d);
  }
  return dates;
}

/** Get the Monday of the week containing `d`. */
function getMondayOfWeek(d: Date): Date {
  const result = new Date(d);
  const offset = mondayDow(result);
  result.setDate(result.getDate() - offset);
  return result;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function getInitials(userId: string): string {
  return userId.slice(0, 2).toUpperCase();
}

// ── Types ────────────────────────────────────────────────────────

interface CalendarTask {
  node: Node;
  healthSignal: HealthSignal;
  dueDate: Date;
  startDate: Date | null;
  isOverdue: boolean;
  breadcrumb: string;
  // Projected tasks come from the critical-path scheduler as a fallback
  // when a node has no manually set dueDate. They render with a dashed
  // outline so managers can tell computed dates from authored ones.
  isProjected: boolean;
}

// Top-of-cell badges derived from version forecasts.
interface VersionMarker {
  versionId: string;
  name: string;
  kind: 'target' | 'projected';
  dateKey: string;
  color: string;
}

// ── Task Pill (Month View) ──────────────────────────────────────

function TaskPill({
  task,
  selected,
  onClick,
  onDragStart,
}: {
  task: CalendarTask;
  selected: boolean;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
}) {
  const color = HEALTH_COLORS[task.healthSignal];
  const dim = task.isProjected;
  const baseOpacity = dim ? 0.55 : 0.85;

  return (
    <div
      draggable={!dim}
      onDragStart={onDragStart}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={
        `${task.node.text}${task.isProjected ? ' · projected (no manual due date)' : ''}` +
        (task.breadcrumb ? `\n${task.breadcrumb}` : '')
      }
      style={{
        fontSize: 11,
        fontWeight: 500,
        color: dim ? color : '#fff',
        background: dim ? 'transparent' : color,
        border: dim ? `1px dashed ${color}` : 'none',
        borderRadius: 4,
        padding: '1px 6px',
        marginBottom: 2,
        cursor: dim ? 'pointer' : 'grab',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        opacity: selected ? 1 : baseOpacity,
        outline: selected ? '2px solid #4f46e5' : 'none',
        outlineOffset: 1,
        transition: 'opacity 0.1s',
        lineHeight: '18px',
      }}
      onMouseOver={(e) => { e.currentTarget.style.opacity = '1'; }}
      onMouseOut={(e) => { if (!selected) e.currentTarget.style.opacity = String(baseOpacity); }}
    >
      {task.node.text}
    </div>
  );
}

// ── Spanning bar (Month View) ───────────────────────────────────

function SpanBar({
  task,
  selected,
  onClick,
  onDragStart,
  dayWidth,
  spanDays,
}: {
  task: CalendarTask;
  selected: boolean;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  dayWidth: number;
  spanDays: number;
}) {
  const color = HEALTH_COLORS[task.healthSignal];

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={`${task.node.text}${task.breadcrumb ? `\n${task.breadcrumb}` : ''}`}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        height: 18,
        fontSize: 10,
        fontWeight: 500,
        color: '#fff',
        background: color,
        borderRadius: 4,
        padding: '1px 6px',
        cursor: 'grab',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        opacity: selected ? 1 : 0.8,
        outline: selected ? '2px solid #4f46e5' : 'none',
        outlineOffset: 1,
        width: `calc(${spanDays * 100}% + ${(spanDays - 1) * 1}px)`,
        zIndex: 2,
        lineHeight: '16px',
      }}
    >
      {task.node.text}
    </div>
  );
}

// ── Task Card (Week View) ───────────────────────────────────────

function TaskCard({
  task,
  effortUnit,
  selected,
  onClick,
  onDragStart,
}: {
  task: CalendarTask;
  effortUnit: string;
  selected: boolean;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
}) {
  const color = HEALTH_COLORS[task.healthSignal];
  const abbrev = effortUnit === 'hours' ? 'h' : effortUnit === 'days' ? 'd' : 'pts';
  const dim = task.isProjected;

  return (
    <div
      draggable={!dim}
      onDragStart={onDragStart}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={
        (task.breadcrumb || task.node.text) +
        (dim ? '\n(projected — no manual due date)' : '')
      }
      style={{
        fontSize: 12,
        background: dim ? '#f8fafc' : '#fff',
        border: dim ? `1px dashed ${color}` : `1px solid #e2e8f0`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 6,
        padding: '6px 8px',
        marginBottom: 4,
        cursor: dim ? 'pointer' : 'grab',
        outline: selected ? '2px solid #4f46e5' : 'none',
        outlineOffset: 1,
        opacity: dim ? 0.75 : 1,
        transition: 'box-shadow 0.1s',
      }}
      onMouseOver={(e) => { e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)'; }}
      onMouseOut={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
    >
      {/* Title */}
      <div
        style={{
          fontWeight: 600,
          color: '#1e293b',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          marginBottom: 4,
        }}
      >
        {task.node.text}
      </div>

      {/* Meta row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#94a3b8' }}>
        {/* Priority dot */}
        {task.node.priority && (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: PRIORITY_COLORS[task.node.priority],
              display: 'inline-block',
              flexShrink: 0,
            }}
            title={task.node.priority}
          />
        )}

        {/* Effort */}
        {task.node.effortEstimate != null && (
          <span style={{ fontWeight: 500 }}>
            {task.node.effortEstimate}{abbrev}
          </span>
        )}

        {/* Assignee initials */}
        {task.node.assigneeIds.length > 0 && (
          <div style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
            {task.node.assigneeIds.slice(0, 3).map((uid) => (
              <span
                key={uid}
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  background: '#e2e8f0',
                  color: '#475569',
                  fontSize: 8,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {getInitials(uid)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Calendar View ──────────────────────────────────────────

export function CalendarView() {
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const nodes = useMindmapStore((s) => s.nodes);
  const computed = useMindmapStore((s) => s.computed);
  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const updateNode = useMindmapStore((s) => s.updateNode);
  const currentMap = useMindmapStore((s) => s.currentMap);
  const getNodeBreadcrumb = useMindmapStore((s) => s.getNodeBreadcrumb);
  const getVisibleNodes = useMindmapStore((s) => s.getVisibleNodes);
  const focusNodeId = useMindmapStore((s) => s.focusNodeId);
  const maxDepth = useMindmapStore((s) => s.maxDepth);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);
  const activeVersionFilter = useMindmapStore((s) => s.activeVersionFilter);
  const activeCycleFilter = useMindmapStore((s) => s.activeCycleFilter);
  const versions = useMindmapStore((s) => s.versions);
  const cycles = useMindmapStore((s) => s.cycles);

  const effortUnit = currentMap?.effortUnit ?? 'days';

  const [mode, setMode] = useState<CalendarMode>('month');
  const [viewDate, setViewDate] = useState(() => new Date());

  // Scheduler output (per-node start/end) and release forecast (per-version
  // targetDate + velocity-adjusted finish). Both are fetched lazily and
  // refetched when the map or node graph changes, so the calendar reflects
  // the same numbers the Gantt and Releases views show.
  const [scheduleData, setScheduleData] = useState<ScheduleResponse | null>(null);
  const [forecast, setForecast] = useState<ReleaseForecastResponse | null>(null);

  // Subscribe modal — lazy-fetched so we don't hit the server just
  // because the calendar was opened.
  const [subscribeUrls, setSubscribeUrls] = useState<CalendarSubscribeUrls | null>(null);
  const [subscribeOpen, setSubscribeOpen] = useState(false);
  const [subscribeError, setSubscribeError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const openSubscribe = useCallback(async () => {
    if (!currentMapId) return;
    setSubscribeOpen(true);
    setSubscribeError(null);
    setCopied(false);
    if (subscribeUrls) return;
    try {
      const urls = await api.fetchCalendarSubscribeUrl(currentMapId);
      setSubscribeUrls(urls);
    } catch (e) {
      setSubscribeError(e instanceof Error ? e.message : 'Failed to load subscribe URL');
    }
  }, [currentMapId, subscribeUrls]);

  const copyUrl = useCallback(async () => {
    if (!subscribeUrls) return;
    try {
      await navigator.clipboard.writeText(subscribeUrls.webcalUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setSubscribeError('Clipboard copy blocked — select the URL and copy manually.');
    }
  }, [subscribeUrls]);

  useEffect(() => {
    // Drop cached subscribe URL on map switch so the modal fetches a
    // fresh one for the new map.
    setSubscribeUrls(null);
  }, [currentMapId]);

  useEffect(() => {
    let cancelled = false;
    if (!currentMapId) {
      setScheduleData(null);
      setForecast(null);
      return;
    }
    (async () => {
      try {
        const [sched, fc] = await Promise.all([
          api.fetchSchedule(currentMapId) as Promise<ScheduleResponse>,
          api.fetchReleaseForecast(currentMapId).catch(() => null),
        ]);
        if (cancelled) return;
        setScheduleData(sched);
        setForecast(fc);
      } catch {
        if (!cancelled) {
          setScheduleData(null);
          setForecast(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Depend on the node graph + versions so adding/moving/estimating a
    // leaf reflows the projected dates, and editing a version's target
    // date or status re-draws the release markers. Cycles are already
    // reactive through the direct store subscription above — no
    // separate fetch needed for sprint bands.
  }, [currentMapId, nodes, versions]);

  const today = useMemo(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }, []);

  // ── Schedule offsets → calendar dates per node ───────────────
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
      const visibleEndDays = Math.max(endDays, startDays + (s.duration === 0 ? 0 : 1));
      end.setDate(end.getDate() + Math.round(visibleEndDays));
      map.set(s.nodeId, { start, end });
    }
    return map;
  }, [scheduleData]);

  // ── Build calendar tasks ────────────────────────────────────

  const tasks = useMemo<CalendarTask[]>(() => {
    const todayKey = toDateKey(today);
    // Filter to only visible nodes
    const visibleNodes = getVisibleNodes();
    const visibleIds = new Set(visibleNodes.filter((v) => !v.isDimmed).map((v) => v.node.id));
    const doneOf = (n: Node) =>
      n.status != null &&
      (currentMap?.statusWorkflow ?? []).some(
        (s) => s.id === n.status && s.category === 'done',
      );

    const result: CalendarTask[] = [];
    for (const n of Object.values(nodes)) {
      if (!visibleIds.has(n.id)) continue;
      const cv = computed.get(n.id);
      const isDone = doneOf(n);

      if (n.dueDate) {
        // Authored — use as-is.
        const dueDate = parseDate(n.dueDate);
        const startDate = n.startDate ? parseDate(n.startDate) : null;
        result.push({
          node: n,
          healthSignal: (cv?.healthSignal ?? 'on_track') as HealthSignal,
          dueDate,
          startDate,
          isOverdue: !isDone && toDateKey(dueDate) < todayKey,
          breadcrumb: getNodeBreadcrumb(n.id),
          isProjected: false,
        });
        continue;
      }

      // Projected fallback: only leaves with some duration, so parents
      // don't double-render over their own children and zero-effort
      // placeholders don't litter the grid.
      const isLeaf = (n.childrenIds?.length ?? 0) === 0;
      if (!isLeaf) continue;
      const proj = scheduleDates.get(n.id);
      if (!proj) continue;
      if (isDone) continue;

      result.push({
        node: n,
        healthSignal: (cv?.healthSignal ?? 'on_track') as HealthSignal,
        dueDate: proj.end,
        startDate: proj.start,
        isOverdue: toDateKey(proj.end) < todayKey,
        breadcrumb: getNodeBreadcrumb(n.id),
        isProjected: true,
      });
    }
    return result;
  }, [nodes, computed, today, currentMap, getNodeBreadcrumb, getVisibleNodes, scheduleDates, focusNodeId, maxDepth, rootNodeId, activeVersionFilter, activeCycleFilter]);

  // ── Group tasks by date key ─────────────────────────────────

  const tasksByDate = useMemo(() => {
    const map = new Map<string, CalendarTask[]>();
    for (const task of tasks) {
      const key = toDateKey(task.dueDate);
      const arr = map.get(key) ?? [];
      arr.push(task);
      map.set(key, arr);
    }
    return map;
  }, [tasks]);

  // ── Dates with overdue incomplete tasks ─────────────────────

  const overdueDates = useMemo(() => {
    const set = new Set<string>();
    for (const task of tasks) {
      if (task.isOverdue) {
        set.add(toDateKey(task.dueDate));
      }
    }
    return set;
  }, [tasks]);

  // ── Spanning tasks (startDate + dueDate) ────────────────────

  const spanningTasks = useMemo(() => {
    return tasks.filter((t) => t.startDate && toDateKey(t.startDate) !== toDateKey(t.dueDate));
  }, [tasks]);

  // ── Version markers indexed by date key ─────────────────────
  // A version drops up to two badges: its authored targetDate and
  // the velocity-adjusted finish from the release forecast. The
  // badge color signals slip (green = ahead, red = late, amber =
  // on target, gray = no target).
  const versionMarkersByDate = useMemo(() => {
    const map = new Map<string, VersionMarker[]>();
    if (!forecast) return map;

    const push = (dateKey: string, marker: VersionMarker) => {
      const arr = map.get(dateKey) ?? [];
      arr.push(marker);
      map.set(dateKey, arr);
    };

    for (const row of forecast.releases) {
      if (row.versionStatus === 'archived') continue;
      const slipColor = (days: number | null): string => {
        if (days == null) return '#64748b';
        if (days === 0) return '#f59e0b';
        if (days < 0) return '#10b981';
        return '#ef4444';
      };
      if (row.targetDate) {
        push(row.targetDate.slice(0, 10), {
          versionId: row.versionId,
          name: row.versionName,
          kind: 'target',
          dateKey: row.targetDate.slice(0, 10),
          color: '#6366f1',
        });
      }
      if (row.velocityAdjustedFinishDate) {
        push(row.velocityAdjustedFinishDate.slice(0, 10), {
          versionId: row.versionId,
          name: row.versionName,
          kind: 'projected',
          dateKey: row.velocityAdjustedFinishDate.slice(0, 10),
          color: slipColor(row.slipVelocityDays ?? row.slipPlannedDays),
        });
      }
    }
    return map;
  }, [forecast]);

  // ── Cycle info per date: active cycle for background tinting,
  // plus a flag on the first covered day for the label pill ─────
  const cyclesByDate = useMemo(() => {
    // key → { cycle, isFirst }
    const map = new Map<string, { cycle: Cycle; isFirst: boolean }>();
    for (const c of cycles) {
      if (!c.startDate || !c.endDate) continue;
      const start = parseDate(c.startDate);
      const end = parseDate(c.endDate);
      if (end.getTime() < start.getTime()) continue;
      const cursor = new Date(start);
      let first = true;
      while (cursor.getTime() <= end.getTime()) {
        const key = toDateKey(cursor);
        // First write wins — earlier/active cycle takes precedence
        // so overlapping cycles don't paint over each other.
        if (!map.has(key)) {
          map.set(key, { cycle: c, isFirst: first });
        }
        first = false;
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    return map;
  }, [cycles]);

  // ── Navigation ──────────────────────────────────────────────

  const goToday = useCallback(() => setViewDate(new Date()), []);

  const goPrev = useCallback(() => {
    setViewDate((d) => {
      if (mode === 'month') return new Date(d.getFullYear(), d.getMonth() - 1, 1);
      const prev = new Date(d);
      prev.setDate(prev.getDate() - 7);
      return prev;
    });
  }, [mode]);

  const goNext = useCallback(() => {
    setViewDate((d) => {
      if (mode === 'month') return new Date(d.getFullYear(), d.getMonth() + 1, 1);
      const next = new Date(d);
      next.setDate(next.getDate() + 7);
      return next;
    });
  }, [mode]);

  // ── Drag & drop ─────────────────────────────────────────────

  const handleDragStart = useCallback((e: React.DragEvent, nodeId: string) => {
    e.dataTransfer.setData('text/plain', nodeId);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, dateKey: string) => {
      e.preventDefault();
      const nodeId = e.dataTransfer.getData('text/plain');
      if (!nodeId) return;
      const node = nodes[nodeId];
      if (!node) return;

      // Calculate new dueDate
      const newDue = dateKey; // YYYY-MM-DD

      // If node has start+due spanning, maintain the duration
      if (node.startDate && node.dueDate) {
        const oldStart = parseDate(node.startDate);
        const oldDue = parseDate(node.dueDate);
        const durationMs = oldDue.getTime() - oldStart.getTime();
        const newDueDate = parseDate(newDue);
        const newStartDate = new Date(newDueDate.getTime() - durationMs);
        updateNode(nodeId, {
          dueDate: newDue,
          startDate: toDateKey(newStartDate),
        });
      } else {
        updateNode(nodeId, { dueDate: newDue });
      }
    },
    [nodes, updateNode],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  // ── Grid computation ────────────────────────────────────────

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const gridDates = useMemo(() => {
    if (mode === 'month') {
      return getMonthGrid(year, month);
    }
    return getWeekGrid(getMondayOfWeek(viewDate));
  }, [mode, year, month, viewDate]);

  // ── Header label ────────────────────────────────────────────

  const headerLabel = useMemo(() => {
    if (mode === 'month') {
      return `${MONTH_NAMES[month]} ${year}`;
    }
    const start = gridDates[0];
    const end = gridDates[6];
    const startMonth = MONTH_NAMES[start.getMonth()].slice(0, 3);
    const endMonth = MONTH_NAMES[end.getMonth()].slice(0, 3);
    if (start.getMonth() === end.getMonth()) {
      return `${startMonth} ${start.getDate()} - ${end.getDate()}, ${year}`;
    }
    return `${startMonth} ${start.getDate()} - ${endMonth} ${end.getDate()}, ${start.getFullYear() !== end.getFullYear() ? `${start.getFullYear()}/${end.getFullYear()}` : year}`;
  }, [mode, gridDates, month, year]);

  // ── Render ──────────────────────────────────────────────────

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: '#fff',
        overflow: 'hidden',
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 20px',
          borderBottom: '1px solid #e2e8f0',
          flexShrink: 0,
        }}
      >
        {/* Left: navigation */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={goPrev} style={navBtnStyle} title="Previous">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M10.3 12.3a1 1 0 0 1-1.4 0l-3.6-3.6a1 1 0 0 1 0-1.4l3.6-3.6a1 1 0 0 1 1.4 1.4L7.4 8l2.9 2.9a1 1 0 0 1 0 1.4z" />
            </svg>
          </button>
          <button onClick={goToday} style={todayBtnStyle}>
            Today
          </button>
          <button onClick={goNext} style={navBtnStyle} title="Next">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M5.7 3.7a1 1 0 0 1 1.4 0l3.6 3.6a1 1 0 0 1 0 1.4l-3.6 3.6a1 1 0 0 1-1.4-1.4L8.6 8 5.7 5.1a1 1 0 0 1 0-1.4z" />
            </svg>
          </button>

          <span
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: '#1e293b',
              marginLeft: 8,
              letterSpacing: '-0.01em',
            }}
          >
            {headerLabel}
          </span>
        </div>

        {/* Right: subscribe + mode toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={openSubscribe}
            title="Subscribe to this calendar from Google/Apple/Outlook"
            style={{
              background: '#fff',
              border: '1px solid #e2e8f0',
              borderRadius: 6,
              padding: '5px 10px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 12,
              fontWeight: 600,
              color: '#4f46e5',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M3.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-6h-3A1.5 1.5 0 0 1 8 4.5v-1H3.5zm5.5.707V4.5a.5.5 0 0 0 .5.5h.793L9 3.707zM2 3.5A1.5 1.5 0 0 1 3.5 2H9l4 4v6.5A1.5 1.5 0 0 1 11.5 14h-8A1.5 1.5 0 0 1 2 12.5v-9z" />
            </svg>
            Subscribe
          </button>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            background: '#f1f5f9',
            borderRadius: 6,
            padding: 2,
            gap: 1,
          }}
        >
          {(['month', 'week'] as CalendarMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                fontSize: 12,
                fontWeight: mode === m ? 600 : 500,
                color: mode === m ? '#1e293b' : '#64748b',
                background: mode === m ? '#fff' : 'transparent',
                border: 'none',
                borderRadius: 4,
                padding: '4px 12px',
                cursor: 'pointer',
                fontFamily: 'inherit',
                transition: 'all 0.15s',
                boxShadow: mode === m ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                textTransform: 'capitalize',
              }}
            >
              {m}
            </button>
          ))}
        </div>
        </div>
      </div>

      {/* Day-of-week header */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          borderBottom: '1px solid #e2e8f0',
          flexShrink: 0,
        }}
      >
        {DAY_NAMES.map((d) => (
          <div
            key={d}
            style={{
              padding: '6px 8px',
              fontSize: 11,
              fontWeight: 600,
              color: '#94a3b8',
              textAlign: 'center',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gridAutoRows: mode === 'month' ? '1fr' : undefined,
          overflow: 'auto',
        }}
      >
        {gridDates.map((date, idx) => {
          const key = toDateKey(date);
          const dayTasks = tasksByDate.get(key) ?? [];
          const isCurrentMonth = date.getMonth() === month;
          const isToday = sameDay(date, today);
          const hasOverdue = overdueDates.has(key);
          const versionMarkers = versionMarkersByDate.get(key) ?? [];
          const cycleHit = cyclesByDate.get(key) ?? null;

          // For month view, determine spanning tasks starting on this day
          const spansStarting = mode === 'month'
            ? spanningTasks.filter((t) => t.startDate && sameDay(t.startDate, date))
            : [];

          // In month view, exclude spanning tasks from the pill list (they are rendered as bars)
          const spanIds = new Set(spanningTasks.map((t) => t.node.id));
          const pillTasks = mode === 'month'
            ? dayTasks.filter((t) => !spanIds.has(t.node.id))
            : dayTasks;

          // Layer a cycle tint on top of the base cell color so the
          // today/overdue cues still show through. Base first, then
          // the cycle overlay via linear-gradient for consistency.
          const baseBg = isToday
            ? '#eff6ff'
            : hasOverdue
              ? '#fef2f2'
              : !isCurrentMonth && mode === 'month'
                ? '#fafafa'
                : '#fff';
          const background = cycleHit
            ? `linear-gradient(${CYCLE_TINT[cycleHit.cycle.status]}14, ${CYCLE_TINT[cycleHit.cycle.status]}14), ${baseBg}`
            : baseBg;

          return (
            <div
              key={key}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, key)}
              style={{
                borderRight: (idx + 1) % 7 !== 0 ? '1px solid #f1f5f9' : undefined,
                borderBottom: '1px solid #f1f5f9',
                borderTop: cycleHit ? `2px solid ${CYCLE_TINT[cycleHit.cycle.status]}` : undefined,
                padding: mode === 'month' ? '4px 4px 2px' : '8px',
                background,
                minHeight: mode === 'week' ? 200 : undefined,
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              {/* Cycle label — only on the first covered day so the
                  band reads as one continuous marker, not a flood. */}
              {cycleHit?.isFirst && (
                <div
                  title={`Sprint: ${cycleHit.cycle.name} · ${cycleHit.cycle.status}`}
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    color: CYCLE_TINT[cycleHit.cycle.status],
                    textTransform: 'uppercase',
                    letterSpacing: 0.3,
                    marginBottom: 2,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  ▸ {cycleHit.cycle.name}
                </div>
              )}

              {/* Version markers — target and projected finish. */}
              {versionMarkers.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 3,
                    marginBottom: 3,
                  }}
                >
                  {versionMarkers.map((vm) => {
                    const isTarget = vm.kind === 'target';
                    return (
                      <span
                        key={`${vm.versionId}-${vm.kind}`}
                        title={
                          isTarget
                            ? `${vm.name} target date`
                            : `${vm.name} projected finish (velocity-adjusted)`
                        }
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          padding: '1px 5px',
                          borderRadius: 3,
                          color: isTarget ? '#fff' : vm.color,
                          background: isTarget ? vm.color : `${vm.color}20`,
                          border: isTarget ? 'none' : `1px dashed ${vm.color}`,
                          whiteSpace: 'nowrap',
                          textTransform: 'uppercase',
                          letterSpacing: 0.3,
                        }}
                      >
                        {isTarget ? 'Tgt' : 'Proj'} · {vm.name}
                      </span>
                    );
                  })}
                </div>
              )}

              {/* Day number */}
              <div
                style={{
                  fontSize: mode === 'month' ? 12 : 13,
                  fontWeight: isToday ? 700 : 500,
                  color: isToday
                    ? '#4f46e5'
                    : !isCurrentMonth && mode === 'month'
                      ? '#cbd5e1'
                      : '#64748b',
                  marginBottom: mode === 'month' ? 2 : 6,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                }}
              >
                {isToday ? (
                  <span
                    style={{
                      background: '#4f46e5',
                      color: '#fff',
                      borderRadius: '50%',
                      width: 22,
                      height: 22,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                      fontWeight: 700,
                    }}
                  >
                    {date.getDate()}
                  </span>
                ) : (
                  date.getDate()
                )}
              </div>

              {/* Spanning bars (month view only) */}
              {mode === 'month' && spansStarting.map((task) => {
                const startD = task.startDate!;
                const endD = task.dueDate;
                const diffMs = endD.getTime() - startD.getTime();
                const spanDays = Math.min(
                  Math.ceil(diffMs / (1000 * 60 * 60 * 24)) + 1,
                  7 - (idx % 7), // Don't overflow past end of row
                );
                return (
                  <div key={task.node.id} style={{ position: 'relative', height: 20, marginBottom: 2 }}>
                    <SpanBar
                      task={task}
                      selected={selectedNodeId === task.node.id}
                      onClick={() => selectNode(task.node.id)}
                      onDragStart={(e) => handleDragStart(e, task.node.id)}
                      dayWidth={0}
                      spanDays={spanDays}
                    />
                  </div>
                );
              })}

              {/* Task pills/cards */}
              {mode === 'month' ? (
                <>
                  {pillTasks.slice(0, 3).map((task) => (
                    <TaskPill
                      key={task.node.id}
                      task={task}
                      selected={selectedNodeId === task.node.id}
                      onClick={() => selectNode(task.node.id)}
                      onDragStart={(e) => handleDragStart(e, task.node.id)}
                    />
                  ))}
                  {pillTasks.length > 3 && (
                    <div
                      style={{
                        fontSize: 10,
                        color: '#94a3b8',
                        fontWeight: 600,
                        padding: '0 4px',
                      }}
                    >
                      +{pillTasks.length - 3} more
                    </div>
                  )}
                </>
              ) : (
                dayTasks.map((task) => (
                  <TaskCard
                    key={task.node.id}
                    task={task}
                    effortUnit={effortUnit}
                    selected={selectedNodeId === task.node.id}
                    onClick={() => selectNode(task.node.id)}
                    onDragStart={(e) => handleDragStart(e, task.node.id)}
                  />
                ))
              )}
            </div>
          );
        })}
      </div>

      {subscribeOpen && (
        <SubscribeModal
          urls={subscribeUrls}
          error={subscribeError}
          copied={copied}
          onCopy={copyUrl}
          onClose={() => setSubscribeOpen(false)}
        />
      )}
    </div>
  );
}

// ── Subscribe modal ─────────────────────────────────────────────

function SubscribeModal({
  urls,
  error,
  copied,
  onCopy,
  onClose,
}: {
  urls: CalendarSubscribeUrls | null;
  error: string | null;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 10,
          padding: 24,
          width: 520,
          maxWidth: '90vw',
          boxShadow: '0 20px 40px rgba(15, 23, 42, 0.25)',
          fontFamily: 'inherit',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: '#1e293b', marginBottom: 4 }}>
          Subscribe to this calendar
        </div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 16 }}>
          Add this URL to Google Calendar, Apple Calendar, or Outlook. The feed updates
          automatically — your calendar client will re-fetch it every few hours.
        </div>

        {error ? (
          <div style={{ fontSize: 12, color: '#991b1b', marginBottom: 12 }}>{error}</div>
        ) : null}

        {urls ? (
          <>
            <label
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: '#94a3b8',
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              Webcal URL (click to copy)
            </label>
            <input
              readOnly
              value={urls.webcalUrl}
              onFocus={(e) => e.currentTarget.select()}
              style={{
                width: '100%',
                marginTop: 4,
                marginBottom: 12,
                padding: '8px 10px',
                fontFamily: 'ui-monospace, monospace',
                fontSize: 11,
                color: '#1e293b',
                border: '1px solid #e2e8f0',
                borderRadius: 6,
                background: '#f8fafc',
              }}
            />

            <details style={{ fontSize: 11, color: '#64748b', marginBottom: 16 }}>
              <summary style={{ cursor: 'pointer' }}>Prefer the https:// version?</summary>
              <input
                readOnly
                value={urls.httpsUrl}
                onFocus={(e) => e.currentTarget.select()}
                style={{
                  width: '100%',
                  marginTop: 8,
                  padding: '8px 10px',
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: 11,
                  color: '#1e293b',
                  border: '1px solid #e2e8f0',
                  borderRadius: 6,
                  background: '#f8fafc',
                }}
              />
            </details>

            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 16, lineHeight: 1.5 }}>
              Anyone with this link can read the map's dates. The URL is stable per map —
              if you need to revoke it, rotate the server's JWT secret.
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 16 }}>Loading…</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onClose}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 500,
              fontFamily: 'inherit',
              color: '#475569',
              background: '#fff',
              border: '1px solid #e2e8f0',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
          <button
            onClick={onCopy}
            disabled={!urls}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 600,
              fontFamily: 'inherit',
              color: '#fff',
              background: urls ? '#4f46e5' : '#cbd5e1',
              border: 'none',
              borderRadius: 6,
              cursor: urls ? 'pointer' : 'default',
            }}
          >
            {copied ? 'Copied!' : 'Copy URL'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Shared button styles ────────────────────────────────────────

const navBtnStyle: React.CSSProperties = {
  background: 'none',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  padding: '4px 8px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#64748b',
  fontFamily: 'inherit',
  transition: 'background 0.15s',
};

const todayBtnStyle: React.CSSProperties = {
  background: 'none',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  padding: '4px 12px',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  color: '#4f46e5',
  fontFamily: 'inherit',
  transition: 'background 0.15s',
};
