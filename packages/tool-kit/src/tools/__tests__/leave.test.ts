/**
 * Personal leave tools (#664): list_leave / add_leave / remove_leave round
 * trip through the backend — the MCP surface for a person's days off.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { LeaveRange } from '@mindblown/core';
import { addLeaveTool, listLeaveTool, removeLeaveTool } from '../leave.js';
import { allTools } from '../../index.js';
import type { ToolBackend } from '../../backend.js';

function memoryBackend(): ToolBackend {
  const rows: LeaveRange[] = [];
  return {
    listLeave: async () => [...rows],
    addLeave: async (input: { startDate: string; endDate: string; note?: string | null }) => {
      const r: LeaveRange = { id: `l${rows.length + 1}`, userId: 'u1', startDate: input.startDate, endDate: input.endDate, note: input.note ?? null, createdAt: '2026-11-19T00:00:00Z' };
      rows.push(r);
      return r;
    },
    removeLeave: async (id: string) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) throw new Error(`Leave ${id} not found`);
      rows.splice(i, 1);
    },
  } as unknown as ToolBackend;
}

describe('leave tools', () => {
  it('are registered on the shared tool list', () => {
    const names = allTools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_leave', 'add_leave', 'remove_leave']));
  });

  it('add → list → remove round trip', async () => {
    const backend = memoryBackend();
    expect(await listLeaveTool.handler(backend, {} as never)).toContain('No leave');
    const added = await addLeaveTool.handler(backend, { startDate: '2026-12-21', endDate: '2027-01-04', note: 'Christmas' } as never);
    expect(added).toContain('21 Dec – 4 Jan');
    expect(added).toContain('Christmas');
    const listed = await listLeaveTool.handler(backend, {} as never);
    expect(listed).toContain('2026-12-21 – 2027-01-04');
    expect(listed).toContain('[id: l1]');
    expect(await removeLeaveTool.handler(backend, { leaveId: 'l1' } as never)).toContain('Removed');
    expect(await listLeaveTool.handler(backend, {} as never)).toContain('No leave');
  });

  it('rejects malformed dates and an end before the start', async () => {
    const schema = z.object(addLeaveTool.schema);
    expect(() => schema.parse({ startDate: '21.12.2026', endDate: '2027-01-04' })).toThrow();
    const out = await addLeaveTool.handler(memoryBackend(), { startDate: '2027-01-04', endDate: '2026-12-21' } as never);
    expect(out).toContain('must not be before');
  });
});
