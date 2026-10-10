/**
 * AI estimate drafts (#318): which leaves get a draft, and when the job
 * stays out entirely. The model, the db and the socket are stubbed; what is
 * under test is the selection (committed, unestimated, not done, live leaf,
 * capped per map) and the gates (local model only, per-map switch, AI
 * policy none, archived maps filtered by the query).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Node as CoreNode, StatusDef } from '@mindblown/core';

const s = vi.hoisted(() => ({
  aiEnabled: true,
  localUp: true,
  maps: [] as Array<{ id: string; aiEstimateDrafts: boolean }>,
  policy: {} as Record<string, string>,
  nodes: {} as Record<string, unknown[]>,
  versions: {} as Record<string, unknown[]>,
  writes: [] as Array<{ id: string; input: Record<string, unknown> }>,
  estimateCalls: [] as string[],
  failFor: new Set<string>(),
  /** Nodes a person estimated while the model was thinking — the conditional write finds no row. */
  takenMeanwhile: new Set<string>(),
  events: [] as Array<Record<string, unknown>>,
}));

// drizzle operators as plain data, so the stubbed UPDATE can read the node id.
vi.mock('drizzle-orm', () => ({
  and: (...a: unknown[]) => ({ and: a }),
  or: (...a: unknown[]) => ({ or: a }),
  eq: (_c: unknown, v: unknown) => ({ eq: v }),
  isNull: (c: unknown) => ({ isNull: c }),
  lt: (c: unknown, v: unknown) => ({ lt: [c, v] }),
}));

vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => s.maps }) }),
    update: () => ({
      set: (input: Record<string, unknown>) => ({
        where: (cond: { and: Array<{ eq?: string }> }) => ({
          returning: async () => {
            const id = cond.and[0].eq as string;
            if (s.takenMeanwhile.has(id)) return [];
            s.writes.push({ id, input: { effortEstimate: input.effortEstimate, estimateSource: input.estimateSource } });
            return [{ id, ...input }];
          },
        }),
      }),
    }),
  },
}));
vi.mock('../../db/schema.js', () => ({
  maps: { id: 'id', aiEstimateDrafts: 'd', archivedAt: 'a' },
  nodes: { id: 'n.id', effortEstimate: 'n.est', deletedAt: 'n.del', percentComplete: 'n.pct' },
}));
vi.mock('../../db/helpers.js', () => ({ dbNodeToCore: (r: unknown) => r }));
vi.mock('../../db/events.js', () => ({
  recordEvent: async (e: Record<string, unknown>) => {
    s.events.push(e);
  },
}));
vi.mock('../../ai/client.js', () => ({
  get aiEnabled() {
    return s.aiEnabled;
  },
}));
vi.mock('../../ai/health.js', () => ({ localChatUsable: () => s.localUp }));
vi.mock('../../ai/policy.js', () => ({ getMapAiPolicy: async (id: string) => s.policy[id] ?? 'any' }));
vi.mock('../../ai/providers/ollama.js', () => ({ ollamaProvider: { name: 'ollama' } }));
vi.mock('../../ai/estimate.js', () => ({
  estimateEffort: async (_p: unknown, _d: unknown, t: { text: string }) => {
    s.estimateCalls.push(t.text);
    if (s.failFor.has(t.text)) throw new Error('model said no');
    return { estimate: 2 };
  },
}));
vi.mock('../../db/maps.js', () => ({
  getMap: async (id: string) => ({ map: { id, statusWorkflow: WORKFLOW }, nodes: s.nodes[id] ?? [] }),
}));
vi.mock('../../db/versions.js', () => ({ listVersions: async (id: string) => s.versions[id] ?? [] }));
vi.mock('../../ws.js', () => ({ broadcast: () => {} }));

const WORKFLOW: StatusDef[] = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '', position: 0 },
  { id: 'in_progress', name: 'In Progress', category: 'in_progress', color: '', position: 1 },
  { id: 'done', name: 'Done', category: 'done', color: '', position: 2 },
];

import { runEstimateDrafts, _resetEstimateDraftFailures, DRAFTS_PER_MAP } from '../estimateDrafts.js';

let seq = 0;
function leaf(text: string, over: Partial<CoreNode> = {}): CoreNode {
  seq += 1;
  return {
    id: text,
    parentId: 'root',
    text,
    description: null,
    effortEstimate: null,
    percentComplete: null,
    status: 'todo',
    versionId: null,
    deletedAt: null,
    updatedAt: new Date(Date.UTC(2026, 9, 1, 0, seq)).toISOString(),
    ...over,
  } as CoreNode;
}
const root = { id: 'root', parentId: null, text: 'Root', effortEstimate: null, status: null, updatedAt: '2026-01-01T00:00:00Z' } as unknown as CoreNode;

beforeEach(() => {
  Object.assign(s, { aiEnabled: true, localUp: true, maps: [{ id: 'm1', aiEstimateDrafts: true }], policy: {}, nodes: {}, versions: {} });
  s.writes.length = 0;
  s.estimateCalls.length = 0;
  s.failFor.clear();
  s.takenMeanwhile.clear();
  s.events.length = 0;
  _resetEstimateDraftFailures();
});

describe('runEstimateDrafts (#318)', () => {
  it('drafts committed, unestimated, open leaves — and nothing else', async () => {
    s.versions.m1 = [{ id: 'lane', status: 'active', sortOrder: 0 }];
    s.nodes.m1 = [
      root,
      leaf('todo-leaf'),
      leaf('doing-leaf', { status: 'in_progress' }),
      leaf('lane-leaf', { status: null, versionId: 'lane' }),
      leaf('backlog-leaf', { status: null }),
      leaf('done-leaf', { status: 'done' }),
      leaf('full-leaf', { percentComplete: 100 }),
      leaf('estimated-leaf', { effortEstimate: 3 }),
      leaf('deleted-leaf', { deletedAt: '2026-10-01T00:00:00Z' } as Partial<CoreNode>),
      leaf('parent', {}),
      leaf('child-of-parent', { parentId: 'parent', status: null }),
    ];
    const r = await runEstimateDrafts();
    expect(s.estimateCalls.sort()).toEqual(['doing-leaf', 'lane-leaf', 'todo-leaf']);
    expect(s.writes).toContainEqual({ id: 'todo-leaf', input: { effortEstimate: 2, estimateSource: 'ai' } });
    expect(r).toMatchObject({ drafted: 3, maps: 1, errors: [] });
  });

  it(`caps each map at ${DRAFTS_PER_MAP} per run, oldest first`, async () => {
    s.nodes.m1 = [root, ...Array.from({ length: DRAFTS_PER_MAP + 3 }, (_, i) => leaf(`t${i}`))];
    await runEstimateDrafts();
    expect(s.estimateCalls).toEqual(['t0', 't1', 't2', 't3', 't4']);
  });

  it('stays out of maps with drafts off or AI policy none', async () => {
    s.maps = [
      { id: 'off', aiEstimateDrafts: false },
      { id: 'none', aiEstimateDrafts: true },
    ];
    s.policy.none = 'none';
    s.nodes.off = [root, leaf('a')];
    s.nodes.none = [root, leaf('b')];
    const r = await runEstimateDrafts();
    expect(s.estimateCalls).toEqual([]);
    expect(r.maps).toBe(0);
  });

  it('never runs without a reachable local model — no cloud fallback', async () => {
    s.nodes.m1 = [root, leaf('a')];
    s.localUp = false;
    expect(await runEstimateDrafts()).toMatchObject({ drafted: 0, skipped: 'no-local-model' });
    s.localUp = true;
    s.aiEnabled = false;
    expect(await runEstimateDrafts()).toMatchObject({ drafted: 0, skipped: 'no-local-model' });
    expect(s.estimateCalls).toEqual([]);
  });

  it('a person who estimates while the model thinks wins; a draft lands in the history under no person', async () => {
    s.nodes.m1 = [root, leaf('raced'), leaf('free')];
    s.takenMeanwhile.add('raced');
    const r = await runEstimateDrafts();
    expect(s.estimateCalls).toEqual(['raced', 'free']); // both asked …
    expect(s.writes.map((w) => w.id)).toEqual(['free']); // … only the untouched one written
    expect(r.drafted).toBe(1);
    expect(s.events).toEqual([
      { mapId: 'm1', nodeId: 'free', userId: null, eventType: 'node.field_changed', fieldName: 'effortEstimate', oldValue: null, newValue: 2 },
    ]);
  });

  it('a failed draft is reported and not retried on the next run', async () => {
    s.nodes.m1 = [root, leaf('flaky'), leaf('fine')];
    s.failFor.add('flaky');
    const first = await runEstimateDrafts();
    expect(first.errors).toHaveLength(1);
    expect(first.drafted).toBe(1);
    s.estimateCalls.length = 0;
    await runEstimateDrafts();
    expect(s.estimateCalls).not.toContain('flaky');
  });
});
