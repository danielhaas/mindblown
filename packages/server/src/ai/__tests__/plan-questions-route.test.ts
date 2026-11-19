/**
 * POST /api/ai/braindump/questions asks before a plan is drafted, and
 * POST /api/ai/braindump takes the answers into the prompt. Real routes,
 * the provider stubbed below them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { CompletionOptions } from '../providers/types.js';

vi.mock('../../db/permissions.js', () => ({ getPermission: async () => 'admin', hasPermission: () => true }));
vi.mock('../../ai/tools.js', () => ({
  getChatToolSpecs: vi.fn(() => []),
  executeTool: vi.fn(),
  renderTreeForPrompt: vi.fn(() => ''),
  renderFocusContext: vi.fn(() => ''),
  hasMiTools: vi.fn(() => false),
}));
vi.mock('../../ai/embeddings.js', () => ({ semanticSearch: vi.fn(async () => []), backfillMapEmbeddings: vi.fn(), scheduleEmbedNode: vi.fn() }));
vi.mock('../../db/nodes.js', () => ({}));
vi.mock('../../db/maps.js', () => ({
  getMap: async (id: string) =>
    id === 'm1'
      ? {
          map: { id: 'm1', name: 'Bakery', effortUnit: 'days' },
          nodes: [
            { id: 'root', parentId: null, text: 'Bakery' },
            { id: 'a', parentId: 'root', text: 'Ordering' },
          ],
        }
      : null,
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../db/settings.js', () => ({ getAiProviderSettings: vi.fn(async () => ({ preference: 'auto' })), setAiProviderSettings: vi.fn() }));
vi.mock('../../ai/client.js', () => ({
  aiEnabled: true,
  embedEnabled: true,
  aiConfig: () => ({ enabled: true, baseUrl: 'http://local', model: 'qwen', embedModel: 'e' }),
  chatCompletion: vi.fn(),
}));

const llm = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../../ai/policy.js', () => ({
  AiPolicyError: class extends Error {},
  getMapAiPolicy: async () => 'any',
  capabilitiesForMap: async () => ({ enabled: true, chat: true, structured: true, embeddings: true, triage: true }),
  resolveProviderForMap: async () => ({ name: 'ollama', model: 'qwen', complete: llm.complete, runTurn: vi.fn() }),
}));

import { aiRoutes } from '../../routes/ai.js';

async function post(url: string, payload: Record<string, unknown>) {
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    req.userId = 'user-1';
  });
  await app.register(aiRoutes);
  const res = await app.inject({ method: 'POST', url, payload });
  await app.close();
  return res;
}
const lastCall = () => llm.complete.mock.calls.at(-1)![0] as CompletionOptions;

beforeEach(() => llm.complete.mockReset());

describe('POST /api/ai/braindump/questions', () => {
  it('asks the model about the description and returns its cleaned questions', async () => {
    llm.complete.mockResolvedValue('```json\n{"questions":["1. Who orders?","Any deadline?"]}\n```');
    const res = await post('/api/ai/braindump/questions', { mapId: 'm1', prose: 'Bread to order online.' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ questions: ['Who orders?', 'Any deadline?'] });
    const call = lastCall();
    expect(call.systemPrompt).toContain('At most 3 questions');
    expect(call.parts[0].text).toContain('Bread to order online.');
    expect(call.parts[0].text).toContain('Areas already in the plan: Ordering');
  });

  it('returns no questions when the model has none', async () => {
    llm.complete.mockResolvedValue('{"questions":[]}');
    expect((await post('/api/ai/braindump/questions', { mapId: 'm1', prose: 'Complete spec.' })).json()).toEqual({ questions: [] });
  });

  it('400 without prose, 404 for an unknown map, 502 on a non-JSON reply', async () => {
    expect((await post('/api/ai/braindump/questions', { mapId: 'm1', prose: ' ' })).statusCode).toBe(400);
    expect((await post('/api/ai/braindump/questions', { mapId: 'nope', prose: 'x' })).statusCode).toBe(404);
    llm.complete.mockResolvedValue('Sure! Here are some questions');
    expect((await post('/api/ai/braindump/questions', { mapId: 'm1', prose: 'x' })).json().error.code).toBe('AI_BAD_RESPONSE');
  });
});

describe('POST /api/ai/braindump with answers', () => {
  it('drafts from the description plus the answered questions', async () => {
    llm.complete.mockResolvedValue('{"tree":[{"text":"Pickup slots","estimate":2,"children":[]}]}');
    const res = await post('/api/ai/braindump', {
      mapId: 'm1',
      parentId: 'root',
      prose: 'Bread to order online.',
      answers: [
        { question: 'Who orders?', answer: 'Regulars, mostly on phones.' },
        { question: 'Any deadline?', answer: '' },
        { question: 42, answer: 'ignored' },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tree[0].text).toBe('Pickup slots');
    const text = lastCall().parts[0].text;
    expect(text).toContain('Bread to order online.\n\nAnswers to planning questions:\n- Who orders? Regulars, mostly on phones.');
    expect(text).not.toContain('Any deadline?');
    expect(text).not.toContain('ignored');
  });
});
