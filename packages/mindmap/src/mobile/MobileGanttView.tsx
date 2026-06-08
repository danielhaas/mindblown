import { useEffect, useMemo, useRef, useState } from 'react';
import type { MindMap, StatusDef } from '@mindblown/core';
import * as api from '../api.js';
import type { NodeWithComputed, ScheduleResponse } from '../api.js';

interface Props {
  nodes: NodeWithComputed[];
  map: MindMap;
  onSelect: (nodeId: string) => void;
}

type Scale = 'day' | 'week' | 'month';

const PX_PER_DAY_BY_SCALE: Record<Scale, number> = {
  day: 24,
  week: 14,
  month: 6,
};

const LABEL_COL_WIDTH = 180;
const ROW_HEIGHT = 36;
const HEADER_HEIGHT = 22;
const HIDE_DONE_KEY = 'mindblown_gantt_hide_done';
const SCALE_KEY = 'mb_mobile_gantt_scale';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function nextMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

interface GanttRow {
  node: NodeWithComputed;
  startOffset: number;
  duration: number;
  status: StatusDef | null;
  isCritical: boolean;
}

function statusOf(node: NodeWithComputed, workflow: StatusDef[]): StatusDef | null {
  if (!node.status) return null;
  return workflow.find((s) => s.id === node.status) ?? null;
}

function flattenTreeIds(nodes: NodeWithComputed[], rootId: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const order: string[] = [];
  const walk = (id: string) => {
    const n = byId.get(id);
    if (!n) return;
    if (id !== rootId) order.push(id);
    for (const cid of n.childrenIds) walk(cid);
  };
  walk(rootId);
  return order;
}

function readHideDone(): boolean {
  try {
    return localStorage.getItem(HIDE_DONE_KEY) === '1';
  } catch {
    return false;
  }
}

function readScale(): Scale {
  try {
    const v = localStorage.getItem(SCALE_KEY);
    if (v === 'day' || v === 'week' || v === 'month') return v;
  } catch {}
  return 'week';
}

export function MobileGanttView({ nodes, map, onSelect }: Props) {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [hideDone, setHideDone] = useState<boolean>(readHideDone);
  const [scale, setScale] = useState<Scale>(readScale);

  const pxPerDay = PX_PER_DAY_BY_SCALE[scale];

  useEffect(() => {
    try {
      localStorage.setItem(HIDE_DONE_KEY, hideDone ? '1' : '0');
    } catch {}
  }, [hideDone]);

  useEffect(() => {
    try {
      localStorage.setItem(SCALE_KEY, scale);
    } catch {}
  }, [scale]);

  useEffect(() => {
    let cancelled = false;
    setSchedule(null);
    setScheduleError(null);
    api
      .fetchSchedule(map.id)
      .then((s) => {
        if (!cancelled) setSchedule(s);
      })
      .catch((e: Error) => {
        if (!cancelled) setScheduleError(e.message ?? 'Failed to load schedule');
      });
    return () => {
      cancelled = true;
    };
  }, [map.id]);

  const { rows, totalDays, monthMarkers, todayOffset } = useMemo(() => {
    if (!schedule) {
      return {
        rows: [] as GanttRow[],
        totalDays: 0,
        monthMarkers: [] as { offset: number; label: string }[],
        todayOffset: 0,
      };
    }
    const anchor = new Date(schedule.projectStartDate);
    anchor.setUTCHours(0, 0, 0, 0);
    const unitsPerDay = schedule.unitsPerDay || 1;

    const dateById = new Map<string, { start: Date; end: Date }>();
    for (const s of schedule.schedule) {
      const startDays = s.computedStart / unitsPerDay;
      const endDays = s.computedEnd / unitsPerDay;
      const visibleEnd = Math.max(endDays, startDays + (s.duration === 0 ? 0 : 1));
      dateById.set(s.nodeId, {
        start: addDays(anchor, Math.round(startDays)),
        end: addDays(anchor, Math.round(visibleEnd)),
      });
    }

    const critical = new Set(schedule.criticalPath.path);
    const treeOrder = flattenTreeIds(nodes, map.rootNodeId);

    const dated: { node: NodeWithComputed; start: Date; end: Date }[] = [];
    for (const id of treeOrder) {
      const d = dateById.get(id);
      if (!d) continue;
      const node = nodes.find((n) => n.id === id);
      if (!node) continue;
      if (d.end <= d.start) continue;
      if (hideDone && (node.percentComplete ?? 0) >= 100) continue;
      dated.push({ node, start: d.start, end: d.end });
    }

    if (dated.length === 0) {
      return {
        rows: [] as GanttRow[],
        totalDays: 0,
        monthMarkers: [] as { offset: number; label: string }[],
        todayOffset: 0,
      };
    }

    let minStart = dated[0].start;
    let maxEnd = dated[0].end;
    for (const d of dated) {
      if (d.start < minStart) minStart = d.start;
      if (d.end > maxEnd) maxEnd = d.end;
    }
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (today < minStart) minStart = today;
    if (today > maxEnd) maxEnd = today;
    const padded = addDays(minStart, -3);
    const totalDays = daysBetween(padded, addDays(maxEnd, 3));

    const rows: GanttRow[] = dated.map((d) => ({
      node: d.node,
      startOffset: daysBetween(padded, d.start),
      duration: Math.max(1, daysBetween(d.start, d.end)),
      status: statusOf(d.node, map.statusWorkflow),
      isCritical: critical.has(d.node.id),
    }));

    const monthMarkers: { offset: number; label: string }[] = [];
    let cursor = startOfMonth(padded);
    if (cursor < padded) cursor = nextMonth(cursor);
    while (daysBetween(padded, cursor) < totalDays) {
      monthMarkers.push({
        offset: daysBetween(padded, cursor),
        label: `${MONTH_NAMES[cursor.getUTCMonth()]} ${cursor.getUTCFullYear()}`,
      });
      cursor = nextMonth(cursor);
    }

    return {
      rows,
      totalDays,
      monthMarkers,
      todayOffset: daysBetween(padded, today),
    };
  }, [schedule, nodes, map.rootNodeId, map.statusWorkflow, hideDone]);

  useEffect(() => {
    if (!timelineRef.current || totalDays === 0) return;
    const x = todayOffset * pxPerDay;
    const w = timelineRef.current.clientWidth;
    timelineRef.current.scrollLeft = Math.max(0, x - w / 2);
  }, [todayOffset, totalDays, schedule, pxPerDay]);

  const workflow = [...map.statusWorkflow].sort((a, b) => a.position - b.position);

  const controlBar = (
    <div className="mb-gantt-controls">
      <button
        className={`mb-gantt-toggle${hideDone ? ' mb-gantt-toggle-on' : ''}`}
        onClick={() => setHideDone((v) => !v)}
        aria-pressed={hideDone}
      >
        {hideDone ? 'Hide done ✓' : 'Hide done'}
      </button>
      <div className="mb-gantt-scale-group" role="group" aria-label="Time scale">
        {(['day', 'week', 'month'] as const).map((sc) => (
          <button
            key={sc}
            className="mb-gantt-scale-btn"
            aria-pressed={scale === sc}
            onClick={() => setScale(sc)}
          >
            {sc === 'day' ? 'D' : sc === 'week' ? 'W' : 'M'}
          </button>
        ))}
      </div>
      <div className="mb-gantt-legend">
        {workflow.map((s) => (
          <span key={s.id} className="mb-gantt-legend-item">
            <span className="mb-gantt-legend-swatch" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );

  if (scheduleError) {
    return (
      <div className="mb-body">
        <div className="mb-error">Schedule unavailable: {scheduleError}</div>
      </div>
    );
  }

  if (!schedule) {
    return (
      <div className="mb-body">
        <div style={{ color: '#64748b', textAlign: 'center', padding: 24 }}>
          Computing schedule…
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <>
        {controlBar}
        <div className="mb-body">
          <div style={{ color: '#64748b', textAlign: 'center', padding: 24 }}>
            {hideDone
              ? 'No open tasks. Toggle "Hide done" off to see completed ones.'
              : 'No tasks with computed duration. Add effort estimates on the desktop to see them here.'}
          </div>
        </div>
      </>
    );
  }

  const timelineWidth = totalDays * pxPerDay;
  const trackHeight = rows.length * ROW_HEIGHT;
  const monthColWidth = pxPerDay * 30;

  return (
    <>
      {controlBar}
      <div
        className="mb-gantt-scroll-wrap"
        style={{ maxHeight: 'calc(100dvh - 220px)' }}
      >
        <div className="mb-gantt-rows-col" style={{ width: LABEL_COL_WIDTH }}>
          <div className="mb-gantt-rows-header" />
          {rows.map((r) => (
            <div
              key={r.node.id}
              className="mb-gantt-row-label"
              onClick={() => onSelect(r.node.id)}
            >
              <span className="mb-gantt-row-label-text">
                {r.isCritical && (
                  <span style={{ color: '#dc2626', marginRight: 4, fontWeight: 700 }}>!</span>
                )}
                {r.node.text}
              </span>
            </div>
          ))}
        </div>

        <div className="mb-gantt-timeline-col" ref={timelineRef}>
          <div
            className="mb-gantt-timeline-inner"
            style={{ width: timelineWidth, minHeight: HEADER_HEIGHT + trackHeight }}
          >
            <div className="mb-gantt-month-header" style={{ width: timelineWidth }}>
              {monthMarkers.map((m) => (
                <div
                  key={m.offset}
                  className="mb-gantt-month"
                  style={{ left: m.offset * pxPerDay, width: monthColWidth }}
                >
                  {m.label}
                </div>
              ))}
            </div>

            {todayOffset >= 0 && todayOffset <= totalDays && (
              <div
                className="mb-gantt-today"
                style={{
                  left: todayOffset * pxPerDay,
                  top: HEADER_HEIGHT,
                  height: trackHeight,
                  pointerEvents: 'none',
                }}
              />
            )}

            {rows.map((r) => {
              const pct = Math.round(r.node.computedProgress ?? 0);
              const barColor = r.status?.color ?? (r.isCritical ? '#dc2626' : '#4f46e5');
              const barWidthPx = r.duration * pxPerDay;
              return (
                <div key={r.node.id} className="mb-gantt-row-track">
                  <div
                    className="mb-gantt-bar"
                    style={{
                      left: r.startOffset * pxPerDay,
                      width: barWidthPx,
                      background: `${barColor}33`,
                      borderLeft: r.isCritical ? `2px solid ${barColor}` : 'none',
                    }}
                    onClick={() => onSelect(r.node.id)}
                  >
                    <div
                      className="mb-gantt-bar-fill"
                      style={{ width: `${pct}%`, background: barColor }}
                    />
                    {barWidthPx > 90 && (
                      <div
                        style={{
                          position: 'absolute',
                          left: 6,
                          top: 0,
                          bottom: 0,
                          display: 'flex',
                          alignItems: 'center',
                          fontSize: 11,
                          color: '#0f172a',
                          fontWeight: 500,
                          pointerEvents: 'none',
                          maxWidth: barWidthPx - 12,
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {r.node.text}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
