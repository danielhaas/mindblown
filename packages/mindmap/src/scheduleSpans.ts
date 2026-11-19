import { makeDayMapper } from '@mindblown/core';

/** The slice of GET /api/maps/:id/schedule this helper reads. */
export interface ScheduleSpanInput {
  schedule: { nodeId: string; computedStart: number; computedEnd: number; duration: number }[];
  projectStartDate: string;
  unitsPerDay: number;
  workingCalendar?: { holidays: string[] } | null;
}

/**
 * Each scheduled node's bar as a person reads it: first day and LAST day,
 * both inclusive, as YYYY-MM-DD. The server's one rounding rule
 * (mapSchedule `barSpan`): whole days, a non-empty bar at least one day
 * wide, offsets walked on the map's working calendar when it has one.
 */
export function scheduleSpans(data: ScheduleSpanInput | null): Map<string, { start: string; end: string }> {
  const spans = new Map<string, { start: string; end: string }>();
  if (!data || !Array.isArray(data.schedule)) return spans;
  const unitsPerDay = data.unitsPerDay || 1;
  const holidays = data.workingCalendar ? new Set(data.workingCalendar.holidays) : null;
  const mapper = makeDayMapper(data.projectStartDate, holidays);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  for (const s of data.schedule) {
    const startDays = s.computedStart / unitsPerDay;
    const start = Math.round(startDays);
    const end = Math.round(Math.max(s.computedEnd / unitsPerDay, startDays + (s.duration === 0 ? 0 : 1)));
    spans.set(s.nodeId, { start: iso(mapper.toDate(start)), end: iso(mapper.lastDay(Math.max(end, start + 1))) });
  }
  return spans;
}
