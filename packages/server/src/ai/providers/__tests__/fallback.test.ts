/**
 * Claude with the local model behind it (fallback.ts): an outage-type
 * refusal (credit, key, rate limit, overload, network) moves the call to
 * the local model and skips Claude for a while; a malformed request or an
 * aborted call is not retried; a turn Claude already started streaming is
 * not switched mid-way. pickProvider hands out the local model during an
 * outage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatProvider, ProviderEvent } from '../types.js';

const fake = vi.hoisted(() => {
  const make = (name: 'anthropic' | 'ollama') => ({
    name,
    model: `${name}-model`,
    complete: vi.fn(),
    runTurn: vi.fn(),
  });
  return { claude: make('anthropic'), local: make('ollama') };
});
vi.mock('../anthropic.js', () => ({ anthropicProvider: fake.claude, anthropicAvailable: true }));
vi.mock('../ollama.js', () => ({ ollamaProvider: fake.local }));
vi.mock('../../client.js', () => ({ aiEnabled: true }));
vi.mock('../../../db/settings.js', () => ({ getAiProviderSettings: async () => ({ preference: 'auto' }) }));

import { withLocalFallback, classifyClaudeError, claudeOutage, __resetClaudeOutage } from '../fallback.js';
import { pickProvider, providerStatus } from '../index.js';

const apiError = (status: number | undefined, message: string, name = 'APIError') =>
  Object.assign(new Error(message), { status, name });
const CREDIT = apiError(400, '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}');

async function* events(list: ProviderEvent[], failAfter?: Error): AsyncIterable<ProviderEvent> {
  for (const e of list) yield e;
  if (failAfter) throw failAfter;
}
async function collect(it: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const OPTS = { systemPrompt: 'S', parts: [{ text: 'P' }] };
const provider = () => withLocalFallback(fake.claude as unknown as ChatProvider, fake.local as unknown as ChatProvider);

beforeEach(() => {
  __resetClaudeOutage();
  for (const p of [fake.claude, fake.local]) {
    p.complete.mockReset();
    p.runTurn.mockReset();
  }
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe('classifyClaudeError', () => {
  it('falls back on credit, key, access, rate limit, overload, server and network errors', () => {
    expect(classifyClaudeError(CREDIT)?.reason).toBe('Claude: credit balance too low');
    expect(classifyClaudeError(apiError(401, 'invalid x-api-key'))?.reason).toBe('Claude: API key rejected');
    expect(classifyClaudeError(apiError(403, 'forbidden'))).not.toBeNull();
    expect(classifyClaudeError(apiError(429, 'rate'))?.pauseMs).toBe(60_000);
    expect(classifyClaudeError(apiError(529, 'overloaded'))?.reason).toBe('Claude: overloaded');
    expect(classifyClaudeError(apiError(500, 'oops'))).not.toBeNull();
    expect(classifyClaudeError(apiError(undefined, 'Connection error.', 'APIConnectionError'))?.reason).toBe('Claude: not reachable');
  });

  it('does not fall back on a malformed request or an abort', () => {
    expect(classifyClaudeError(apiError(400, 'messages: field required'))).toBeNull();
    expect(classifyClaudeError(apiError(undefined, 'Request was aborted.', 'APIUserAbortError'))).toBeNull();
    expect(classifyClaudeError(apiError(undefined, 'This operation was aborted', 'AbortError'))).toBeNull();
  });
});

describe('withLocalFallback.complete', () => {
  it('answers from the local model when Claude has no credit, without the Claude model override', async () => {
    fake.claude.complete.mockRejectedValue(CREDIT);
    fake.local.complete.mockResolvedValue('{"ok":true}');
    expect(await provider().complete({ ...OPTS, model: 'claude-haiku' })).toBe('{"ok":true}');
    expect(fake.local.complete.mock.calls[0][0]).toMatchObject({ systemPrompt: 'S', model: undefined });
    expect(claudeOutage()?.reason).toBe('Claude: credit balance too low');
  });

  it('passes Claude through untouched when it answers', async () => {
    fake.claude.complete.mockResolvedValue('fine');
    expect(await provider().complete(OPTS)).toBe('fine');
    expect(fake.local.complete).not.toHaveBeenCalled();
    expect(claudeOutage()).toBeNull();
  });

  it('rethrows a malformed-request 400 without trying the local model', async () => {
    fake.claude.complete.mockRejectedValue(apiError(400, 'messages: field required'));
    await expect(provider().complete(OPTS)).rejects.toThrow('field required');
    expect(fake.local.complete).not.toHaveBeenCalled();
  });

  it('says plainly when both fail', async () => {
    fake.claude.complete.mockRejectedValue(CREDIT);
    fake.local.complete.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(provider().complete(OPTS)).rejects.toThrow(
      'AI is unavailable right now. Claude: credit balance too low, and the local model failed too (connect ECONNREFUSED).',
    );
  });
});

describe('withLocalFallback.runTurn', () => {
  it('moves a chat turn to the local model when Claude refuses before streaming', async () => {
    fake.claude.runTurn.mockImplementation(() => events([], CREDIT));
    fake.local.runTurn.mockImplementation(() => events([{ type: 'text_delta', text: 'hi' }, { type: 'turn_end', reason: 'stop' }]));
    const out = await collect(provider().runTurn({ systemPrompt: 'S', messages: [], tools: [] }));
    expect(out).toEqual([{ type: 'text_delta', text: 'hi' }, { type: 'turn_end', reason: 'stop' }]);
  });

  it('does not switch models after Claude started streaming', async () => {
    fake.claude.runTurn.mockImplementation(() => events([{ type: 'text_delta', text: 'par' }], apiError(529, 'overloaded')));
    await expect(collect(provider().runTurn({ systemPrompt: 'S', messages: [], tools: [] }))).rejects.toThrow('overloaded');
    expect(fake.local.runTurn).not.toHaveBeenCalled();
  });
});

describe('pickProvider during an outage', () => {
  it('hands out Claude-with-fallback normally, the local model while Claude is out, Claude again after', async () => {
    vi.useFakeTimers();
    expect(pickProvider('auto')?.name).toBe('anthropic');
    fake.claude.complete.mockRejectedValue(apiError(529, 'overloaded'));
    fake.local.complete.mockResolvedValue('x');
    await pickProvider('auto')!.complete(OPTS);
    expect(pickProvider('auto')).toBe(fake.local);
    expect(pickProvider('anthropic')).toBe(fake.local);
    const status = await providerStatus();
    expect(status.active?.name).toBe('ollama');
    expect(status.claudeOutage?.reason).toBe('Claude: overloaded');
    vi.advanceTimersByTime(61_000);
    expect(pickProvider('auto')?.name).toBe('anthropic');
    expect((await providerStatus()).claudeOutage).toBeNull();
  });
});
