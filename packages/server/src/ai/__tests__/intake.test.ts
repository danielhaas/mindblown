/**
 * The intake turn loop against a scripted provider: what reaches the model
 * (duplicate note, tree, versions), how terminal tools end the loop, and
 * how a draft is sanitised against the map before the client sees it.
 * No LLM, no DB — every side effect is injected.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Node as CoreNode, MindMap, Version } from '@mindblown/core';
import type { ChatProvider, ProviderEvent, RunTurnOptions } from '../providers/types.js';
import {
  runIntakeTurn,
  sanitizeDraft,
  sanitizeQuestions,
  createIntakeSession,
  getIntakeSession,
  recordAccepted,
  resetIntakeSessions,
  buildIntakeSystemPrompt,
  INTAKE_MAX_STEPS,
  type IntakeContext,
  type IntakeIo,
} from '../intake.js';

// ── Fixtures ──────────────────────────────────────────────────────

function node(id: string, text: string, parentId: string | null, childrenIds: string[] = []): CoreNode {
  return {
    id,
    mapId: 'm1',
    parentId,
    childrenIds,
    text,
    description: null,
    updatedAt: '2026-09-01T00:00:00Z',
  } as unknown as CoreNode;
}

const map = {
  id: 'm1',
  name: 'Test map',
  effortUnit: 'days',
  phases: [{ id: 'ph1', name: 'MVP', position: 0 }],
} as unknown as MindMap;

const nodes = [
  node('r1', 'Root', null, ['a1']),
  node('a1', 'Sync', 'r1', ['l1']),
  node('l1', 'Close issue on merge', 'a1'),
];

const versions = [{ id: 'v1', name: 'V1', status: 'active' }] as unknown as Version[];

function ctx(overrides: Partial<IntakeContext> = {}): IntakeContext {
  return { map, nodes, versions, parentHintId: 'a1', accepted: [], ...overrides };
}

/** A provider that plays back one scripted turn per runTurn call. */
function scriptedProvider(turns: ProviderEvent[][]): ChatProvider & { calls: RunTurnOptions[] } {
  const calls: RunTurnOptions[] = [];
  let i = 0;
  return {
    name: 'anthropic',
    model: 'claude-test',
    calls,
    async *runTurn(opts) {
      calls.push(opts);
      const turn = turns[Math.min(i, turns.length - 1)];
      i++;
      for (const ev of turn) yield ev;
      yield { type: 'turn_end', reason: 'stop' };
    },
    async complete() {
      return '{}';
    },
  };
}

const call = (id: string, name: string, args: Record<string, unknown>): ProviderEvent => ({
  type: 'tool_call',
  toolCall: { id, name, args },
});

function io(overrides: Partial<IntakeIo> = {}): Partial<IntakeIo> {
  return {
    semanticSearch: async () => [{ nodeId: 'l1', text: 'Close issue on merge', score: 0.71 }],
    executeTool: async (name) => `result of ${name}`,
    estimateEffort: async () => ({
      estimate: 2,
      rawEstimate: 2,
      confidence: 'medium' as const,
      samplesUsed: 4,
      fudgeFactor: null,
      calibrationNote: null,
      effortUnit: 'days',
    }),
    ...overrides,
  };
}

const goodDraft = {
  title: 'Close the issue only when no PR is still open',
  description: '## Why\nx\n## What\ny\n## Acceptance criteria\n- z\n## Out of scope\n- w',
  parentId: 'a1',
  parentReason: 'It is sync behaviour.',
  versionId: 'v1',
  phaseId: 'ph1',
  tags: ['sync'],
  dependencies: [{ nodeId: 'l1', reason: 'builds on it' }],
  duplicates: [],
};

beforeEach(() => resetIntakeSessions());

// ── The turn ──────────────────────────────────────────────────────

describe('runIntakeTurn', () => {
  it('searches, then drafts and asks in one turn; estimate is attached server-side', async () => {
    const provider = scriptedProvider([
      [call('c1', 'search_nodes', { query: 'issue' })],
      [
        { type: 'text_delta', text: 'Looks like sync work.' },
        call('c2', 'propose_ticket', goodDraft),
        call('c3', 'ask_user', {
          questions: [
            { id: 'scope', question: 'Also for Gitea?', options: ['yes', 'no'], why: 'decides the forge path' },
          ],
        }),
      ],
    ]);
    const session = createIntakeSession('m1', 'u1');
    const r = await runIntakeTurn({ provider, session, ctx: ctx(), message: 'close issue on merge', io: io() });

    expect(r.text).toBe('Looks like sync work.');
    expect(r.stepLimit).toBe(false);
    expect(r.draft).toMatchObject({
      title: goodDraft.title,
      parentId: 'a1',
      parentText: 'Sync',
      versionName: 'V1',
      phaseName: 'MVP',
      tags: ['sync'],
      dependencies: [{ nodeId: 'l1', text: 'Close issue on merge' }],
      estimate: { estimate: 2, confidence: 'medium' },
    });
    expect(r.questions).toEqual([
      { id: 'scope', question: 'Also for Gitea?', options: ['yes', 'no'], why: 'decides the forge path' },
    ]);

    // Two provider calls: the search turn and the drafting turn — no third
    // turn after the terminal tools.
    expect(provider.calls).toHaveLength(2);

    // The duplicate pre-check reached the model inside the user message.
    const first = session.messages[0];
    expect(first.role).toBe('user');
    expect((first as { content: string }).content).toContain('[l1] score 0.71');

    // The search result came from executeTool and was replayed as a tool message.
    const toolMsgs = session.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs[0]).toMatchObject({ toolName: 'search_nodes', content: 'result of search_nodes' });
    expect(toolMsgs.map((m) => (m as { toolName: string }).toolName)).toEqual([
      'search_nodes',
      'propose_ticket',
      'ask_user',
    ]);

    // Prompt carries the plan context.
    const sys = provider.calls[1].systemPrompt;
    expect(sys).toContain('- V1 [v1] (active)');
    expect(sys).toContain('- MVP [ph1]');
    expect(sys).toContain('Parent hint: "Sync" [a1]');
    expect(sys).toContain('- Close issue on merge [l1]');
    expect(provider.calls[1].tools.map((t) => t.name).sort()).toEqual(
      ['ask_user', 'propose_ticket', 'search_nodes', 'semantic_search'].sort(),
    );
  });

  it('a prose-only reply ends the turn with no draft and no questions', async () => {
    const provider = scriptedProvider([[{ type: 'text_delta', text: 'Which map area?' }]]);
    const session = createIntakeSession('m1', 'u1');
    const r = await runIntakeTurn({ provider, session, ctx: ctx(), message: 'hm', io: io() });
    expect(r).toMatchObject({ text: 'Which map area?', draft: null, questions: [], stepLimit: false });
  });

  it('stops at the step limit when the model never hands back a draft', async () => {
    const provider = scriptedProvider([[call('c', 'search_nodes', { query: 'again' })]]);
    const session = createIntakeSession('m1', 'u1');
    const r = await runIntakeTurn({ provider, session, ctx: ctx(), message: 'loop', io: io() });
    expect(r.stepLimit).toBe(true);
    expect(r.draft).toBeNull();
    expect(provider.calls).toHaveLength(INTAKE_MAX_STEPS);
  });

  it('a write tool is refused during intake', async () => {
    const provider = scriptedProvider([
      [call('c1', 'create_node', { text: 'sneaky' })],
      [call('c2', 'propose_ticket', goodDraft)],
    ]);
    const session = createIntakeSession('m1', 'u1');
    let executed = 0;
    await runIntakeTurn({
      provider,
      session,
      ctx: ctx(),
      message: 'x',
      io: io({ executeTool: async () => { executed++; return 'no'; } }),
    });
    expect(executed).toBe(0);
    const refusal = session.messages.find((m) => m.role === 'tool') as { content: string };
    expect(refusal.content).toContain('not available during ticket intake');
  });

  it('survives a failing estimator and a failing pre-search', async () => {
    const provider = scriptedProvider([[call('c', 'propose_ticket', goodDraft)]]);
    const session = createIntakeSession('m1', 'u1');
    const r = await runIntakeTurn({
      provider,
      session,
      ctx: ctx(),
      message: 'x',
      io: io({
        semanticSearch: async () => { throw new Error('no embeddings'); },
        estimateEffort: async () => { throw new Error('model down'); },
      }),
    });
    expect(r.draft?.estimate).toBeNull();
    expect((session.messages[0] as { content: string }).content).not.toContain('Server note');
  });
});

// ── Sanitising ────────────────────────────────────────────────────

describe('sanitizeDraft', () => {
  it('falls back to the parent hint when the proposed parent is not on the map', () => {
    const d = sanitizeDraft({ ...goodDraft, parentId: 'invented' }, ctx());
    expect(d?.parentId).toBe('a1');
    expect(d?.parentReason).toContain('placed under Sync instead');
  });

  it('falls back to the root without a hint', () => {
    const d = sanitizeDraft({ ...goodDraft, parentId: 'invented' }, ctx({ parentHintId: null }));
    expect(d?.parentId).toBe('r1');
  });

  it('drops unknown version, phase and priority instead of forwarding them', () => {
    const d = sanitizeDraft(
      { ...goodDraft, versionId: 'v9', phaseId: 'ph9', priority: 'urgent' },
      ctx(),
    );
    expect(d).toMatchObject({ versionId: null, versionName: null, phaseId: null, phaseName: null, priority: null });
  });

  it('keeps dependencies on tree nodes and on tickets accepted this session, drops invented ids', () => {
    const d = sanitizeDraft(
      {
        ...goodDraft,
        dependencies: [
          { nodeId: 'l1', reason: 'a' },
          { nodeId: 'acc1', reason: 'b' },
          { nodeId: 'nope', reason: 'c' },
          { nodeId: 'l1', reason: 'dup' },
        ],
      },
      ctx({ accepted: [{ nodeId: 'acc1', title: 'Earlier ticket' }] }),
    );
    expect(d?.dependencies).toEqual([
      { nodeId: 'l1', text: 'Close issue on merge', reason: 'a' },
      { nodeId: 'acc1', text: 'Earlier ticket', reason: 'b' },
    ]);
  });

  it('returns null without a title or description', () => {
    expect(sanitizeDraft({ ...goodDraft, title: ' ' }, ctx())).toBeNull();
    expect(sanitizeDraft({ ...goodDraft, description: '' }, ctx())).toBeNull();
  });
});

describe('sanitizeQuestions', () => {
  it('caps at three, four options each, and fills missing ids', () => {
    const qs = sanitizeQuestions({
      questions: [
        { question: 'a', options: ['1', '2', '3', '4', '5'] },
        { id: 'b', question: 'b' },
        { question: '' },
        { question: 'c' },
        { question: 'd' },
      ],
    });
    expect(qs.map((q) => q.id)).toEqual(['q1', 'b', 'q3']);
    expect(qs[0].options).toEqual(['1', '2', '3', '4']);
    expect(qs[1].why).toBeNull();
  });
});

// ── Sessions ──────────────────────────────────────────────────────

describe('sessions', () => {
  it('are bound to their map and remember accepted tickets for the next prompt', () => {
    const s = createIntakeSession('m1', 'u1');
    expect(getIntakeSession(s.id, 'm2')).toBeNull();
    expect(getIntakeSession(s.id, 'm1')).toBe(s);
    expect(getIntakeSession('nope', 'm1')).toBeNull();

    recordAccepted(s, 'n-new', 'First ticket');
    expect(s.accepted).toEqual([{ nodeId: 'n-new', title: 'First ticket' }]);
    const prompt = buildIntakeSystemPrompt(ctx({ accepted: s.accepted }));
    expect(prompt).toContain('- "First ticket" [n-new]');
    const last = s.messages[s.messages.length - 1] as { role: string; content: string };
    expect(last.role).toBe('user');
    expect(last.content).toContain('[n-new]');
  });
});
