/**
 * POST /api/ai/chat during a Claude outage: a turn Claude refuses before
 * saying anything is redone on the local model, with the local model's own
 * prompt; a later turn of the same request goes straight to the local
 * model; a turn Claude already started streaming is not switched.
 * Real route, providers stubbed below it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import type { ProviderEvent, RunTurnOptions } from '../providers/types.js';

vi.mock('../../db/permissions.js', () => ({ getPermission: async () => 'admin', hasPermission: () => true }));
vi.mock('../../ai/tools.js', () => ({
  getChatToolSpecs: vi.fn(() => []),
  executeTool: vi.fn(async () => 'tool ok'),
  renderTreeForPrompt: vi.fn(() => ''),
  renderFocusContext: vi.fn(() => ''),
  hasMiTools: vi.fn(() => false),
}));
vi.mock('../../ai/embeddings.js', () => ({ semanticSearch: vi.fn(async () => []), backfillMapEmbeddings: vi.fn(), scheduleEmbedNode: vi.fn() }));
vi.mock('../../db/nodes.js', () => ({}));
vi.mock('../../db/maps.js', () => ({
  getMap: async () => ({ map: { id: 'm1', name: 'M' }, nodes: [{ id: 'root', parentId: null, text: 'Root' }] }),
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../db/settings.js', () => ({ getAiProviderSettings: vi.fn(async () => ({ preference: 'auto' })), setAiProviderSettings: vi.fn() }));
vi.mock('../../ai/client.js', () => ({
  aiEnabled: true,
  embedEnabled: true,
  aiConfig: () => ({ enabled: true, baseUrl: 'http://local', model: 'qwen', embedModel: 'e' }),
  chatCompletion: vi.fn(),
}));

const fake = vi.hoisted(() => ({
  claudeTurn: vi.fn(),
  localTurn: vi.fn(),
}));
vi.mock('../../ai/providers/anthropic.js', () => ({
  anthropicAvailable: true,
  anthropicProvider: { name: 'anthropic', model: 'claude-test', runTurn: (o: unknown) => fake.claudeTurn(o), complete: vi.fn() },
}));
vi.mock('../../ai/providers/ollama.js', () => ({
  ollamaProvider: { name: 'ollama', model: 'qwen', runTurn: (o: unknown) => fake.localTurn(o), complete: vi.fn() },
}));
vi.mock('../../ai/policy.js', async () => {
  const { pickProvider } = await import('../providers/index.js');
  return {
    AiPolicyError: class extends Error {},
    getMapAiPolicy: async () => 'any',
    capabilitiesForMap: async () => ({ enabled: true, chat: true, structured: true, embeddings: true, triage: true }),
    resolveProviderForMap: async () => pickProvider('auto'),
  };
});

import { aiRoutes } from '../../routes/ai.js';
import { __resetClaudeOutage, claudeOutage } from '../providers/fallback.js';
import { executeTool } from '../../ai/tools.js';

const CREDIT = Anthropic.APIError.generate(
  400,
  { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } },
  undefined,
  new Headers(),
);

async function* turn(events: ProviderEvent[], failWith?: Error): AsyncIterable<ProviderEvent> {
  for (const e of events) yield e;
  if (failWith) throw failWith;
}
const say = (text: string): ProviderEvent[] => [{ type: 'text_delta', text }, { type: 'turn_end', reason: 'stop' }];
const callTool = (): ProviderEvent[] => [
  { type: 'tool_call', toolCall: { id: 'toolu_1', name: 'search_nodes', args: { q: 'x' } } },
  { type: 'turn_end', reason: 'tool_use' },
];

async function chat(): Promise<string> {
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    req.userId = 'user-1';
  });
  await app.register(aiRoutes);
  const res = await app.inject({ method: 'POST', url: '/api/ai/chat', payload: { mapId: 'm1', messages: [{ role: 'user', content: 'hi' }] } });
  await app.close();
  return res.body;
}

beforeEach(() => {
  __resetClaudeOutage();
  fake.claudeTurn.mockReset();
  fake.localTurn.mockReset();
  vi.mocked(executeTool).mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('POST /api/ai/chat — Claude outage', () => {
  it('redoes a refused turn on the local model, with the local prompt', async () => {
    fake.claudeTurn.mockImplementation(() => turn([], CREDIT));
    fake.localTurn.mockImplementation(() => turn(say('hello from local')));
    const body = await chat();
    expect(body).toContain('hello from local');
    expect(body).not.toContain('credit balance');
    expect(claudeOutage()?.reason).toBe('Claude: credit balance too low');
    const localPrompt = (fake.localTurn.mock.calls[0][0] as RunTurnOptions).systemPrompt;
    expect(localPrompt).toContain('One tool call per message.');
    expect(localPrompt).not.toContain('Keep calling tools until');
  });

  it('a later turn in the same request goes straight to the local model', async () => {
    // Turn 1: Claude calls a tool. Then Claude goes out (another request noted it).
    fake.claudeTurn.mockImplementationOnce(() => turn(callTool())).mockImplementation(() => turn([], CREDIT));
    vi.mocked(executeTool).mockImplementationOnce(async () => {
      const { providerAfterFailure } = await import('../providers/fallback.js');
      const { resolveProvider } = await import('../providers/index.js');
      await providerAfterFailure(CREDIT, { name: 'anthropic' }, resolveProvider);
      return 'tool ok';
    });
    fake.localTurn.mockImplementation(() => turn(say('done locally')));
    const body = await chat();
    expect(body).toContain('done locally');
    expect(fake.claudeTurn).toHaveBeenCalledTimes(1);
  });

  it('does not switch models once Claude has started answering', async () => {
    fake.claudeTurn.mockImplementation(() => turn([{ type: 'text_delta', text: 'partial' }], CREDIT));
    const body = await chat();
    expect(body).toContain('partial');
    expect(body).toContain('event: error');
    expect(fake.localTurn).not.toHaveBeenCalled();
  });
});
