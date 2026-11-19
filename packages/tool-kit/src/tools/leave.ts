import { z } from 'zod';
import { formatLeaveRange, type LeaveRange } from '@mindblown/core';
import { defineTool } from '../spec.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a YYYY-MM-DD date');

function renderLeave(r: LeaveRange): string {
  const span = r.startDate === r.endDate ? r.startDate : `${r.startDate} – ${r.endDate}`;
  return `- ${span} (${formatLeaveRange(r)})${r.note ? ` — ${r.note}` : ''} [id: ${r.id}]`;
}

export const listLeaveTool = defineTool({
  name: 'list_leave',
  description:
    "Your personal leave (#664): the days you are away, as date ranges (both days inclusive). The schedule works around them on every map whose work you do — a map lists you in update_map `workers`, or a node is assigned to you: effort only moves forward on days you work. Fleet-built work ignores leave.",
  schema: {},
  handler: async (backend) => {
    const leave = await backend.listLeave();
    if (leave.length === 0) return 'No leave entered. add_leave adds a range.';
    return [`${leave.length} leave range(s):`, ...leave.map(renderLeave)].join('\n');
  },
});

export const addLeaveTool = defineTool({
  name: 'add_leave',
  description:
    "Add a stretch of your personal leave (#664): startDate to endDate, both inclusive, with an optional note (\"Christmas\"). Weekends and the map's holidays inside the range are not counted twice. The schedule of every map whose work you do (update_map `workers`, or nodes assigned to you) moves accordingly; get_schedule and export_markdown name the leave.",
  schema: {
    startDate: isoDate.describe('First day away (YYYY-MM-DD)'),
    endDate: isoDate.describe('Last day away (YYYY-MM-DD), the same as startDate for a single day'),
    note: z.string().max(200).optional().describe('Optional note, e.g. "Christmas"'),
  },
  handler: async (backend, { startDate, endDate, note }) => {
    if (endDate < startDate) return 'endDate must not be before startDate.';
    const r = await backend.addLeave({ startDate, endDate, note: note ?? null });
    return `Added leave:\n${renderLeave(r)}`;
  },
});

export const removeLeaveTool = defineTool({
  name: 'remove_leave',
  description: 'Remove one of your personal leave ranges (#664) by its id (list_leave shows the ids).',
  schema: {
    leaveId: z.string().describe('The leave range id from list_leave'),
  },
  handler: async (backend, { leaveId }) => {
    await backend.removeLeave(leaveId);
    return `Removed leave ${leaveId}.`;
  },
});

export const leaveTools = [listLeaveTool, addLeaveTool, removeLeaveTool];
