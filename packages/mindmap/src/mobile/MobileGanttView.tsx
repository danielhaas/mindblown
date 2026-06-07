import { useMemo, useRef, useEffect } from 'react';
import type { MindMap } from '@mindblown/core';
import type { NodeWithComputed } from '../api.js';

interface Props {
  nodes: NodeWithComputed[];
  map: MindMap;
  onSelect: (nodeId: string) => void;
}

const PX_PER_DAY = 24;
const ROW_HEIGHT = 36;
const MONTH_HEADER_HEIGHT = 22;

function parseDate(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return Math.round(ms / 86_400_000);
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

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface GanttRow {
  node: NodeWithComputed;
  startOffset: number;
  duration: number;
}

export function MobileGanttView({ nodes, map, onSelect }: Props) {
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const { rows, startDate, totalDays, monthMarkers, todayOffset } = useMemo(() => {
    const dated: { node: NodeWithComputed; start: Date; end: Date }[] = [];
    for (const n of nodes) {
      if (n.id === map.rootNodeId) continue;
      const start = parseDate(n.startDate);
      const end = parseDate(n.dueDate);
      if (!start || !end) continue;
      if (end < start) continue;
      dated.push({ node: n, start, end });
    }

    if (dated.length === 0) {
      return { rows: [], startDate: new Date(), totalDays: 0, monthMarkers: [], todayOffset: 0 };
    }

    const today = new Date();
    let minStart = dated[0].start;
    let maxEnd = dated[0].end;
    for (const d of dated) {
      if (d.start < minStart) minStart = d.start;
      if (d.end > maxEnd) maxEnd = d.end;
    }
    if (today < minStart) minStart = today;
    if (today > maxEnd) maxEnd = today;
    // Pad 7 days each side for breathing room.
    const startDate = addDays(minStart, -7);
    const totalDays = daysBetween(startDate, addDays(maxEnd, 7));

    const rows: GanttRow[] = dated
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((d) => ({
        node: d.node,
        startOffset: daysBetween(startDate, d.start),
        duration: Math.max(1, daysBetween(d.start, d.end) + 1),
      }));

    const monthMarkers: { offset: number; label: string }[] = [];
    let cursor = startOfMonth(startDate);
    if (cursor < startDate) cursor = nextMonth(cursor);
    while (daysBetween(startDate, cursor) < totalDays) {
      monthMarkers.push({
        offset: daysBetween(startDate, cursor),
        label: `${MONTH_NAMES[cursor.getUTCMonth()]} ${cursor.getUTCFullYear()}`,
      });
      cursor = nextMonth(cursor);
    }

    return {
      rows,
      startDate,
      totalDays,
      monthMarkers,
      todayOffset: daysBetween(startDate, today),
    };
  }, [nodes, map.rootNodeId]);

  useEffect(() => {
    if (!timelineRef.current || totalDays === 0) return;
    const x = todayOffset * PX_PER_DAY;
    const w = timelineRef.current.clientWidth;
    timelineRef.current.scrollLeft = Math.max(0, x - w / 2);
  }, [todayOffset, totalDays]);

  if (rows.length === 0) {
    return (
      <div className="mb-body">
        <div style={{ color: '#64748b', textAlign: 'center', padding: 24 }}>
          No nodes with both start and due dates. Set dates on the desktop to see them here.
        </div>
      </div>
    );
  }

  const timelineWidth = totalDays * PX_PER_DAY;
  const trackHeight = rows.length * ROW_HEIGHT;
  const fullHeight = MONTH_HEADER_HEIGHT + trackHeight;

  return (
    <div className="mb-gantt-wrap" style={{ height: Math.min(fullHeight, window.innerHeight - 160) }}>
      <div className="mb-gantt-rows-col">
        <div style={{ height: MONTH_HEADER_HEIGHT, borderBottom: '1px solid #e2e8f0' }} />
        {rows.map((r) => (
          <div key={r.node.id} className="mb-gantt-row-label" onClick={() => onSelect(r.node.id)}>
            {r.node.text}
          </div>
        ))}
      </div>
      <div className="mb-gantt-timeline-col" ref={timelineRef}>
        <div className="mb-gantt-scroll" style={{ width: timelineWidth, position: 'relative' }}>
          <div style={{ height: MONTH_HEADER_HEIGHT, position: 'relative', borderBottom: '1px solid #e2e8f0', background: '#fff' }}>
            {monthMarkers.map((m) => (
              <div
                key={m.offset}
                className="mb-gantt-month"
                style={{ left: m.offset * PX_PER_DAY, width: PX_PER_DAY * 30 }}
              >
                {m.label}
              </div>
            ))}
          </div>
          <div style={{ position: 'relative' }}>
            {todayOffset >= 0 && todayOffset <= totalDays && (
              <div
                className="mb-gantt-today"
                style={{ left: todayOffset * PX_PER_DAY, height: trackHeight }}
              />
            )}
            {rows.map((r) => {
              const pct = Math.round((r.node.computedProgress ?? 0) * 100);
              return (
                <div key={r.node.id} className="mb-gantt-row-track">
                  <div
                    className="mb-gantt-bar"
                    style={{
                      left: r.startOffset * PX_PER_DAY,
                      width: r.duration * PX_PER_DAY,
                    }}
                    onClick={() => onSelect(r.node.id)}
                  >
                    <div className="mb-gantt-bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
