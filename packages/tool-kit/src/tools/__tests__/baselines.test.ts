/**
 * freeze_baseline / list_baselines (#113): the optional name reaches the
 * backend, and the list reads each baseline's committed finish from its
 * projected bars (older baselines have none).
 */
import { describe, it, expect, vi } from 'vitest';
import { freezeBaselineTool, listBaselinesTool } from '../map.js';
import type { ToolBackend } from '../../backend.js';

describe('freeze_baseline', () => {
  it('passes the name through and reports what was frozen', async () => {
    const freezeBaseline = vi.fn(async () => ({ id: 'b1', name: 'Q4 kickoff', createdAt: '2026-10-10T08:00:00.000Z', nodeCount: 42 }));
    const out = await freezeBaselineTool.handler({ freezeBaseline } as unknown as ToolBackend, { mapId: 'm1', name: 'Q4 kickoff' });
    expect(freezeBaseline).toHaveBeenCalledWith('m1', 'Q4 kickoff');
    expect(out).toContain('"Q4 kickoff" (b1)');
    expect(out).toContain('42 projected bars');
  });

  it('says which old baselines made room', async () => {
    const freezeBaseline = vi.fn(async () => ({ id: 'b3', name: 'New', createdAt: '2026-10-10T08:00:00.000Z', nodeCount: 1, dropped: ['July'] }));
    const out = await freezeBaselineTool.handler({ freezeBaseline } as unknown as ToolBackend, { mapId: 'm1' });
    expect(out).toContain('Dropped the oldest to stay at 10: "July"');
  });

  it('works without a name — the server picks one', async () => {
    const freezeBaseline = vi.fn(async () => ({ id: 'b2', name: 'Baseline 2026-10-10', createdAt: '2026-10-10T08:00:00.000Z', nodeCount: 1 }));
    await freezeBaselineTool.handler({ freezeBaseline } as unknown as ToolBackend, { mapId: 'm1' });
    expect(freezeBaseline).toHaveBeenCalledWith('m1', undefined);
  });
});

describe('list_baselines', () => {
  it('shows each baseline with its planned finish, or says it predates projected baselines', async () => {
    const getMap = vi.fn(async () => ({
      map: {
        baselines: [
          { id: 'old', name: 'July', createdAt: '2026-07-01T00:00:00Z', nodes: { a: { startDate: null } } },
          { id: 'new', name: 'Q4', createdAt: '2026-10-10T00:00:00Z', nodes: { a: { plannedEnd: '2026-11-03' }, b: { plannedEnd: '2026-12-01' } } },
        ],
      },
      nodes: [],
    }));
    const out = await listBaselinesTool.handler({ getMap } as unknown as ToolBackend, { mapId: 'm1' });
    expect(out).toContain('"July" (old) — 2026-07-01, hand-set dates only');
    expect(out).toContain('"Q4" (new) — 2026-10-10, planned finish 2026-12-01');
  });

  it('says so when there are none', async () => {
    const getMap = vi.fn(async () => ({ map: { baselines: [] }, nodes: [] }));
    expect(await listBaselinesTool.handler({ getMap } as unknown as ToolBackend, { mapId: 'm1' })).toMatch(/No baselines yet/);
  });
});
