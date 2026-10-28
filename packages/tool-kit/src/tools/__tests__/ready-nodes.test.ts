import { describe, it, expect } from 'vitest';
import { readyNodesTool } from '../orchestration.js';
import type { ToolBackend, ReadyNodesResult } from '../../backend.js';

const backendWith = (result: ReadyNodesResult, seen: unknown[] = []) =>
  ({ readyNodes: async (_m: string, opts: unknown) => (seen.push(opts), result) }) as unknown as ToolBackend;

const n = (p: Partial<ReadyNodesResult['ready'][number]>) => ({
  id: 'a', text: 'Fix login', status: null, priority: 'P0', priorityRank: null, scopes: [],
  claimedBySession: null, claimedAt: null, parentId: 'e', ...p,
});

describe('ready_nodes output (#323)', () => {
  it('names the sprint scope and shows where each leaf sits and what waits on it', async () => {
    const seen: unknown[] = [];
    const out = await readyNodesTool.handler(
      backendWith({
        mapId: 'm', total: 1, returned: 1, ready: [n({ breadcrumb: ['Portal', 'Auth'], dependents: 2 })],
        sprintScope: { mode: 'active', cycles: [{ id: 'c1', name: 'Sprint 7' }] },
        awaitingApproval: [],
      }, seen),
      { mapId: 'm' } as never,
    );
    expect(out).toContain('sprint "Sprint 7"');
    expect(out).toContain('"Fix login" [P0] — in Portal › Auth · 2 waiting on it');
    expect(seen[0]).toMatchObject({ sprint: undefined });
  });

  it('an empty sprint points at sprint: "all"; the no-sprint fallback is stated', async () => {
    const empty = await readyNodesTool.handler(
      backendWith({ mapId: 'm', total: 0, returned: 0, ready: [], sprintScope: { mode: 'active', cycles: [{ id: 'c1', name: 'S7' }] }, awaitingApproval: [] }),
      { mapId: 'm' } as never,
    );
    expect(empty).toContain('Pass sprint: "all"');
    const fallback = await readyNodesTool.handler(
      backendWith({
        mapId: 'm', total: 1, returned: 1, ready: [n({})],
        sprintScope: { mode: 'active', cycles: [], note: 'No active sprint on this map — showing the whole map.' },
        awaitingApproval: [],
      }),
      { mapId: 'm' } as never,
    );
    expect(fallback).toContain('whole map');
    expect(fallback).toContain('No active sprint');
  });

  it('lists what awaits approval apart, also when nothing is ready (#492)', async () => {
    const out = await readyNodesTool.handler(
      backendWith({
        mapId: 'm', total: 0, returned: 0, ready: [], sprintScope: { mode: 'all', cycles: [] },
        awaitingApproval: [
          { id: 'x', text: 'From a stranger', approval: 'proposed', heldBy: null },
          { id: 'y', text: 'Follow-up', approval: 'rejected', heldBy: { id: 'e', text: 'Epic' } },
        ],
      }),
      { mapId: 'm' } as never,
    );
    expect(out).toContain('No ready leaves');
    expect(out).toContain('Awaiting approval (2)');
    expect(out).toContain('x "From a stranger" [proposed]');
    expect(out).toContain('y "Follow-up" [rejected — via parent e "Epic"]');
  });
});
