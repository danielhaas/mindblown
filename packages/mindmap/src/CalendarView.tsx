import { useCallback, useMemo, useRef, useState } from 'react';
import { useMindmapStore } from './store.js';
import type { Node, HealthSignal, Priority } from '@mindblown/core';

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

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={`${task.node.text}${task.breadcrumb ? `\n${task.breadcrumb}` : ''}`}
      style={{
        fontSize: 11,
        fontWeight: 500,
        color: '#fff',
        background: color,
        borderRadius: 4,
        padding: '1px 6px',
        marginBottom: 2,
        cursor: 'grab',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        opacity: selected ? 1 : 0.85,
        outline: selected ? '2px solid #4f46e5' : 'none',
        outlineOffset: 1,
        transition: 'opacity 0.1s',
        lineHeight: '18px',
      }}
      onMouseOver={(e) => { e.currentTarget.style.opacity = '1'; }}
      onMouseOut={(e) => { if (!selected) e.currentTarget.style.opacity = '0.85'; }}
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

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={task.breadcrumb || task.node.text}
      style={{
        fontSize: 12,
        background: '#fff',
        border: `1px solid #e2e8f0`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 6,
        padding: '6px 8px',
        marginBottom: 4,
        cursor: 'grab',
        outline: selected ? '2px solid #4f46e5' : 'none',
        outlineOffset: 1,
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

  const effortUnit = currentMap?.effortUnit ?? 'days';

  const [mode, setMode] = useState<CalendarMode>('month');
  const [viewDate, setViewDate] = useState(() => new Date());

  const today = useMemo(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }, []);

  // ── Build calendar tasks ────────────────────────────────────

  const tasks = useMemo<CalendarTask[]>(() => {
    const todayKey = toDateKey(today);
    // Filter to only visible nodes
    const visibleNodes = getVisibleNodes();
    const visibleIds = new Set(visibleNodes.filter((v) => !v.isDimmed).map((v) => v.node.id));

    return Object.values(nodes)
      .filter((n) => n.dueDate && visibleIds.has(n.id))
      .map((n) => {
        const cv = computed.get(n.id);
        const dueDate = parseDate(n.dueDate!);
        const startDate = n.startDate ? parseDate(n.startDate) : null;
        const isDone = n.status != null &&
          (currentMap?.statusWorkflow ?? []).some(
            (s) => s.id === n.status && s.category === 'done',
          );
        const isOverdue = !isDone && toDateKey(dueDate) < todayKey;
        return {
          node: n,
          healthSignal: (cv?.healthSignal ?? 'on_track') as HealthSignal,
          dueDate,
          startDate,
          isOverdue,
          breadcrumb: getNodeBreadcrumb(n.id),
        };
      });
  }, [nodes, computed, today, currentMap, getNodeBreadcrumb, getVisibleNodes, focusNodeId, maxDepth, rootNodeId]);

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

        {/* Right: mode toggle */}
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

          // For month view, determine spanning tasks starting on this day
          const spansStarting = mode === 'month'
            ? spanningTasks.filter((t) => t.startDate && sameDay(t.startDate, date))
            : [];

          // In month view, exclude spanning tasks from the pill list (they are rendered as bars)
          const spanIds = new Set(spanningTasks.map((t) => t.node.id));
          const pillTasks = mode === 'month'
            ? dayTasks.filter((t) => !spanIds.has(t.node.id))
            : dayTasks;

          return (
            <div
              key={key}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, key)}
              style={{
                borderRight: (idx + 1) % 7 !== 0 ? '1px solid #f1f5f9' : undefined,
                borderBottom: '1px solid #f1f5f9',
                padding: mode === 'month' ? '4px 4px 2px' : '8px',
                background: isToday
                  ? '#eff6ff'
                  : hasOverdue
                    ? '#fef2f2'
                    : !isCurrentMonth && mode === 'month'
                      ? '#fafafa'
                      : '#fff',
                minHeight: mode === 'week' ? 200 : undefined,
                overflow: 'hidden',
                position: 'relative',
              }}
            >
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
