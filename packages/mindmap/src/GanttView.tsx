import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Node, NodeId, CriticalPathResult } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import { fetchSchedule } from './api.js';

// ── Constants ─────────────────────────────────────────────────────

const TASK_LIST_WIDTH = 300;
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
  baselines: Map<string, { startDate: string | null; dueDate: string | null }>,
): { rangeStart: Date; rangeEnd: Date; columns: Date[] } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let minDate = today;
  let maxDate = today;

  for (const row of rows) {
    const s = parseDate(row.node.startDate);
    const d = parseDate(row.node.dueDate);
    if (s && s < minDate) minDate = s;
    if (d && d > maxDate) maxDate = d;

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
  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);
  const activeCycleFilter = useMindmapStore((s) => s.activeCycleFilter);

  // Local UI state
  const [scale, setScale] = useState<TimeScale>('week');
  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(() => new Set());
  const [criticalPath, setCriticalPath] = useState<CriticalPathResult | null>(null);
  const [selectedBaseline, setSelectedBaseline] = useState<string | null>(null);

  // Drag state
  const [dragInfo, setDragInfo] = useState<{
    nodeId: string;
    startX: number;
    originalStart: string;
    originalDue: string;
  } | null>(null);

  // Refs for synchronized scrolling
  const taskListRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const timelineHeaderRef = useRef<HTMLDivElement>(null);
  const hasAutoScrolled = useRef(false);

  // ── Fetch critical path / schedule ──────────────────────────────

  useEffect(() => {
    if (!currentMapId) return;
    fetchSchedule(currentMapId)
      .then((data: any) => {
        if (data && data.criticalPath) {
          setCriticalPath(data.criticalPath);
        }
      })
      .catch(() => {
        // Graceful fallback: no critical path highlighting
      });
  }, [currentMapId, nodes]);

  // ── Flatten nodes into rows ─────────────────────────────────────

  const allRows = useMemo(
    () => flattenTree(nodes, rootNodeId, collapsedSet),
    [nodes, rootNodeId, collapsedSet],
  );

  // Apply sprint filter
  const rows = useMemo(() => {
    if (!activeCycleFilter) return allRows;
    return allRows.filter((row) => row.node.cycleId === activeCycleFilter);
  }, [allRows, activeCycleFilter]);

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
    () => computeTimeRange(rows, scale, baselineData),
    [rows, scale, baselineData],
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

  // Reset auto-scroll flag when scale changes
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

  const handleBarMouseDown = useCallback(
    (e: React.MouseEvent, nodeId: string) => {
      e.preventDefault();
      e.stopPropagation();
      const node = nodes[nodeId];
      if (!node || !node.startDate || !node.dueDate) return;
      setDragInfo({
        nodeId,
        startX: e.clientX,
        originalStart: node.startDate,
        originalDue: node.dueDate,
      });
    },
    [nodes],
  );

  useEffect(() => {
    if (!dragInfo) return;

    const pxPerDay = colWidth / getStepDays(scale);

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - dragInfo.startX;
      const daysDelta = Math.round(dx / pxPerDay);
      if (daysDelta === 0) return;

      const origStart = parseDate(dragInfo.originalStart);
      const origDue = parseDate(dragInfo.originalDue);
      if (!origStart || !origDue) return;

      const newStart = addDays(origStart, daysDelta);
      const newDue = addDays(origDue, daysDelta);

      updateNode(dragInfo.nodeId, {
        startDate: newStart.toISOString().slice(0, 10),
        dueDate: newDue.toISOString().slice(0, 10),
      });
    };

    const handleMouseUp = () => {
      setDragInfo(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragInfo, colWidth, scale, updateNode]);

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
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* ── Left panel: Task list ──────────────────────────────── */}
        <div
          style={{
            width: TASK_LIST_WIDTH,
            minWidth: TASK_LIST_WIDTH,
            display: 'flex',
            flexDirection: 'column',
            borderRight: '2px solid #e2e8f0',
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
            <div style={{ height: totalHeight }}>
              {rows.map((row, idx) => {
                const cv = computed.get(row.node.id);
                const health = cv?.healthSignal ?? 'on_track';
                const progress = cv?.computedProgress ?? row.node.percentComplete ?? 0;
                const effort = cv?.computedEffort ?? row.node.effortEstimate ?? 0;
                const isSelected = row.node.id === selectedNodeId;

                return (
                  <div
                    key={row.node.id}
                    onClick={() => selectNode(row.node.id)}
                    style={{
                      height: ROW_HEIGHT,
                      display: 'flex',
                      alignItems: 'center',
                      padding: '0 8px',
                      borderBottom: '1px solid #f1f5f9',
                      background: isSelected ? '#eef2ff' : idx % 2 === 0 ? '#fff' : '#fafbfc',
                      cursor: 'pointer',
                      transition: 'background 0.1s',
                      fontSize: 12,
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.background = '#f8fafc';
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.background = idx % 2 === 0 ? '#fff' : '#fafbfc';
                    }}
                  >
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

                      {/* Milestone icon */}
                      {row.node.isMilestone && (
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 10 10"
                          style={{ marginRight: 4, flexShrink: 0 }}
                        >
                          <polygon points="5,0 10,5 5,10 0,5" fill="#8b5cf6" />
                        </svg>
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

                {/* ── Task bars / Milestone diamonds ──────────────── */}
                {rows.map((row, idx) => {
                  const startDate = parseDate(row.node.startDate);
                  const dueDate = parseDate(row.node.dueDate);
                  if (!startDate && !dueDate) return null;

                  const cv = computed.get(row.node.id);
                  const health = cv?.healthSignal ?? 'on_track';
                  const progress = cv?.computedProgress ?? row.node.percentComplete ?? 0;
                  const isCritical = criticalSet.has(row.node.id);
                  const isSelected = row.node.id === selectedNodeId;
                  const barColor = HEALTH_COLORS[health] ?? HEALTH_COLORS.on_track;

                  const centerY = idx * ROW_HEIGHT + ROW_HEIGHT / 2;

                  // Milestone diamond
                  if (row.node.isMilestone) {
                    const date = dueDate ?? startDate!;
                    const cx = getBarX(date);
                    const size = 7;
                    return (
                      <g
                        key={`bar-${row.node.id}`}
                        style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                        onClick={() => selectNode(row.node.id)}
                      >
                        <polygon
                          points={`${cx},${centerY - size} ${cx + size},${centerY} ${cx},${centerY + size} ${cx - size},${centerY}`}
                          fill={isCritical ? '#dc2626' : '#8b5cf6'}
                          stroke={isSelected ? '#4f46e5' : isCritical ? '#991b1b' : '#7c3aed'}
                          strokeWidth={isSelected ? 2 : isCritical ? 2.5 : 1}
                        />
                      </g>
                    );
                  }

                  // Regular bar
                  if (!startDate || !dueDate) return null;
                  const x = getBarX(startDate);
                  const w = getBarWidth(startDate, dueDate);
                  const barH = 16;
                  const y = centerY - barH / 2;
                  const fillW = w * (progress / 100);

                  return (
                    <g
                      key={`bar-${row.node.id}`}
                      style={{ pointerEvents: 'auto', cursor: dragInfo ? 'grabbing' : 'grab' }}
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
                  const depDueDate = parseDate(row.node.startDate);
                  if (!depDueDate) return null;
                  const toX = getBarX(depDueDate);
                  const toY = depIdx * ROW_HEIGHT + ROW_HEIGHT / 2;

                  return row.node.dependencies.map((dep) => {
                    const predIdx = rowIndexMap.get(dep.targetNodeId);
                    if (predIdx === undefined) return null;
                    const pred = rows[predIdx];
                    const predEnd = parseDate(pred.node.dueDate);
                    if (!predEnd) return null;

                    const fromX = getBarX(predEnd);
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
