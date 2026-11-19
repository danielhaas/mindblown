/**
 * AI brief drafts (services/briefDrafts.ts): a ticket the pull refuses for
 * want of a brief gets one from the map's AI, marked as an AI draft, and
 * becomes dispatchable; a vague title gets the AI's question instead of a
 * draft; a ticket held for a person (needs-dan) and a map whose AI policy
 * is none get nothing. The model, the db and the socket are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchQueueSnapshot, type Node as CoreNode } from '@mindblown/core';

const s = vi.hoisted(() => ({
  maps: [] as Array<{ id: string }>,
  map: {} as Record<string, unknown>,
  nodes: [] as CoreNode[],
  structured: true,
  /** The model's raw reply per ticket title. */
  replies: {} as Record<string, string>,
  prompts: [] as string[],
  stored: [] as Array<{ nodeId: string; textHash: string; outcome: string; question: string | null; provider: string | null }>,
  updates: [] as Array<{ id: string; input: Record<string, unknown> }>,
  events: [] as unknown[],
}));

vi.mock('../../db/connection.js', () => ({ db: { select: () => ({ from: () => ({ where: async () => s.maps }) }) } }));
vi.mock('../../db/schema.js', () => ({ maps: { id: 'id', archivedAt: 'a' } }));
vi.mock('drizzle-orm', () => ({ isNull: (c: unknown) => ({ isNull: c }) }));
vi.mock('../../db/maps.js', () => ({ getMap: async (id: string) => ({ map: { ...s.map, id }, nodes: s.nodes }) }));
vi.mock('../../db/nodes.js', () => ({
  getNode: async (id: string) => s.nodes.find((n) => n.id === id) ?? null,
  updateNode: async (id: string, input: Record<string, unknown>) => {
    s.updates.push({ id, input });
    const n = s.nodes.find((x) => x.id === id)!;
    Object.assign(n, { description: input.description, descriptionSource: input.descriptionSource });
    if (Array.isArray(input.tagsRemove)) n.tags = n.tags.filter((t) => !(input.tagsRemove as string[]).includes(t));
    return n;
  },
}));
vi.mock('../../db/briefDrafts.js', () => ({
  listBriefDrafts: async (ids: string[]) => s.stored.filter((r) => ids.includes(r.nodeId)),
  saveBriefDraft: async (row: (typeof s.stored)[number]) => {
    s.stored = [...s.stored.filter((r) => r.nodeId !== row.nodeId), row];
  },
}));
vi.mock('../../db/events.js', () => ({ recordEvent: async (e: unknown) => void s.events.push(e) }));
vi.mock('../../ai/policy.js', () => ({
  capabilitiesForMap: async () => ({ structured: s.structured }),
  resolveProviderForMap: async () => ({
    name: 'local',
    complete: async (o: { parts: Array<{ text: string }> }) => {
      const prompt = o.parts[0].text;
      s.prompts.push(prompt);
      const title = /Ticket title: (.*)$/.exec(prompt)![1];
      return s.replies[title] ?? '{"brief": "Do the thing."}';
    },
  }),
}));
vi.mock('../../ai/providers/fallback.js', () => ({
  withProviderFallback: async (resolve: () => Promise<unknown>, run: (p: unknown) => Promise<unknown>) => run(await resolve()),
}));
vi.mock('../repoDocs.js', () => ({ readRepoDoc: async () => ({ text: '# Avatar\nA chat app with characters.' }) }));
vi.mock('../../ws.js', () => ({ broadcast: () => {} }));

import { briefDraftCandidates, briefRowState, briefTextHash, parseBriefReply, runBriefDrafts, __resetBriefDraftFailures, MAX_ATTEMPTS } from '../briefDrafts.js';

const WORKFLOW = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '', position: 0 },
  { id: 'done', name: 'Done', category: 'done', color: '', position: 1 },
];
const APPROVED = { state: 'approved', merge: 'auto', by: null, at: '2026-11-19T00:00:00.000Z' } as const;

let seq = 0;
function leaf(id: string, text: string, over: Partial<CoreNode> = {}): CoreNode {
  seq++;
  return {
    id,
    mapId: 'm1',
    parentId: 'epic',
    childrenIds: [],
    text,
    description: null,
    tags: [],
    status: 'todo',
    claimedBySession: null,
    blockedReason: null,
    dependencies: [],
    externalLinks: [],
    approval: APPROVED,
    deletedAt: null,
    updatedAt: new Date(Date.UTC(2026, 10, 1, 0, seq)).toISOString(),
    ...over,
  } as unknown as CoreNode;
}

function plan(...leaves: CoreNode[]): CoreNode[] {
  const root = { ...leaf('root', 'Avatar'), parentId: null, childrenIds: ['epic'] } as CoreNode;
  const epic = { ...leaf('epic', 'Characters'), parentId: 'root', description: 'Each character has its own voice.', childrenIds: leaves.map((l) => l.id) } as CoreNode;
  return [root, epic, ...leaves];
}

beforeEach(() => {
  s.maps = [{ id: 'm1' }];
  s.map = { name: 'Avatar', statusWorkflow: WORKFLOW, maxActiveClaims: 2, dispatchGate: [], aiBriefDrafts: true, githubRepoOwner: 'o', githubRepoName: 'avatar' };
  s.structured = true;
  s.replies = {};
  s.prompts = [];
  s.stored = [];
  s.updates = [];
  s.events = [];
  __resetBriefDraftFailures();
});

describe('runBriefDrafts', () => {
  it('a briefless leaf gets a draft, marked AI, and becomes dispatchable', async () => {
    s.nodes = plan(leaf('persona', 'Per-character persona files', { tags: ['needs-brief'] }), leaf('sib', 'Voice per character', { description: 'TTS voice id per character.' }));
    s.replies['Per-character persona files'] = '{"brief": "Give each character a persona file.\\n\\nDone when:\\n- each character loads its file"}';
    const before = dispatchQueueSnapshot(s.nodes, { workflow: WORKFLOW as never, cap: 2, gate: [] });
    expect(before.needsBriefIds).toEqual(['persona']);

    const r = await runBriefDrafts();

    expect(r).toMatchObject({ drafted: 1, asked: 0, errors: [] });
    expect(s.updates).toEqual([
      { id: 'persona', input: { description: 'Give each character a persona file.\n\nDone when:\n- each character loads its file', descriptionSource: 'ai', tagsRemove: ['needs-brief'] } },
    ]);
    // The context: path, parent and sibling descriptions, README.
    expect(s.prompts[0]).toContain('Filed under: Characters');
    expect(s.prompts[0]).toContain('Each character has its own voice.');
    expect(s.prompts[0]).toContain('Voice per character: TTS voice id per character.');
    expect(s.prompts[0]).toContain('A chat app with characters.');
    const after = dispatchQueueSnapshot(s.nodes, { workflow: WORKFLOW as never, cap: 2, gate: [] });
    expect(after.inGateIds).toContain('persona');
    expect(after.needsBriefIds).toEqual([]);
    expect(s.stored).toMatchObject([{ nodeId: 'persona', outcome: 'drafted', textHash: briefTextHash('Per-character persona files') }]);
    // Asked once per title.
    await runBriefDrafts();
    expect(s.prompts).toHaveLength(1);
  });

  it('a vague title: no draft, the AI\'s question goes to the brief row', async () => {
    s.nodes = plan(leaf('vague', 'Fix it'));
    s.replies['Fix it'] = '{"question": "What is broken, and where?"}';
    const r = await runBriefDrafts();
    expect(r).toMatchObject({ drafted: 0, asked: 1 });
    expect(s.updates).toEqual([]);
    expect(s.nodes.find((n) => n.id === 'vague')!.description).toBeNull();
    const rows = await briefRowState(s.map as never, [s.nodes.find((n) => n.id === 'vague')!]);
    expect(rows.get('vague')).toEqual({ ask: true, question: 'What is broken, and where?' });
    // A retitled ticket is tried again — and until then the row is not asked.
    s.nodes.find((n) => n.id === 'vague')!.text = 'Fix the login button on mobile';
    expect((await briefRowState(s.map as never, [s.nodes.find((n) => n.id === 'vague')!])).get('vague')).toEqual({ ask: false });
  });

  it('a needs-dan leaf is held for Dan — no draft', async () => {
    s.nodes = plan(leaf('live', 'Test live: login', { tags: ['needs-dan'] }));
    expect(briefDraftCandidates(s.nodes, s.map as never)).toEqual([]);
    const r = await runBriefDrafts();
    expect(r).toMatchObject({ drafted: 0, asked: 0 });
    expect(s.prompts).toEqual([]);
  });

  it('AI policy none (no structured AI for the map) or the switch off: nothing drafted, the person gets the plain row', async () => {
    s.nodes = plan(leaf('bare', 'Persona files'));
    s.structured = false;
    expect(await runBriefDrafts()).toMatchObject({ drafted: 0, asked: 0 });
    expect(s.prompts).toEqual([]);
    expect((await briefRowState(s.map as never, [s.nodes[2]])).get('bare')).toEqual({ ask: true, question: null });

    s.structured = true;
    s.map.aiBriefDrafts = false;
    expect(await runBriefDrafts()).toMatchObject({ drafted: 0, asked: 0 });
    expect(s.prompts).toEqual([]);
  });

  it('unapproved, blocked and on-hold maps are left alone', async () => {
    s.nodes = plan(leaf('prop', 'Persona files', { approval: { state: 'proposed' } as never }), leaf('blk', 'Voices', { blockedReason: 'waiting on Rita' }));
    expect(briefDraftCandidates(s.nodes, s.map as never)).toEqual([]);
    s.nodes = plan(leaf('bare', 'Persona files'));
    expect(briefDraftCandidates(s.nodes, { ...(s.map as object), maxActiveClaims: 0 } as never)).toEqual([]);
  });

  it(`a model that keeps failing hands the ticket to a person after ${MAX_ATTEMPTS} tries`, async () => {
    s.nodes = plan(leaf('bare', 'Persona files'));
    s.replies['Persona files'] = 'not json';
    const r = await runBriefDrafts(new Date(0));
    expect(r.errors).toHaveLength(1);
    expect((await briefRowState(s.map as never, [s.nodes[2]])).get('bare')).toEqual({ ask: false });
    for (let i = 1; i < MAX_ATTEMPTS; i++) await runBriefDrafts(new Date(i * 3_600_000));
    expect((await briefRowState(s.map as never, [s.nodes[2]])).get('bare')).toEqual({ ask: true, question: null });
  });
});

describe('parseBriefReply', () => {
  it('reads a brief, a question, fences and a brief that is only a question', () => {
    expect(parseBriefReply('```json\n{"brief": "Do X."}\n```')).toEqual({ brief: 'Do X.' });
    expect(parseBriefReply('{"question": "Which screen?"}')).toEqual({ question: 'Which screen?' });
    expect(parseBriefReply('{"brief": "Which screen do you mean?"}')).toEqual({ question: 'Which screen do you mean?' });
    expect(parseBriefReply('nothing')).toBeNull();
    expect(parseBriefReply('{"brief": ""}')).toBeNull();
  });
});
