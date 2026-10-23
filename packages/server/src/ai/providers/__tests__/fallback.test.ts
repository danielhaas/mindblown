/**
 * The local model behind Claude (fallback.ts): an outage-type refusal
 * (credit, key, rate limit, overload, network) redoes the work with the
 * provider resolved anew — the local one, under its own name — and skips
 * Claude for a while; a malformed request or an aborted call is not
 * retried; pickProvider hands out the local model during an outage.
 * Errors are built from the real SDK classes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';

const fake = vi.hoisted(() => {
  const make = (name: 'anthropic' | 'ollama') => ({ name, model: `${name}-model`, complete: vi.fn(), runTurn: vi.fn() });
  return { claude: make('anthropic'), local: make('ollama'), aiEnabled: true };
});
vi.mock('../anthropic.js', () => ({ anthropicProvider: fake.claude, anthropicAvailable: true }));
vi.mock('../ollama.js', () => ({ ollamaProvider: fake.local }));
vi.mock('../../client.js', () => ({
  get aiEnabled() {
    return fake.aiEnabled;
  },
}));
vi.mock('../../../db/settings.js', () => ({ getAiProviderSettings: async () => ({ preference: 'auto' }) }));

import { classifyClaudeError, claudeOutage, withProviderFallback, providerAfterFailure, __resetClaudeOutage } from '../fallback.js';
import { pickProvider, providerStatus, resolveProvider } from '../index.js';

const apiError = (status: number, type: string, message: string) =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, undefined, new Headers());
const CREDIT = apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.');
/** An `error` event inside the stream: no status, only the body. */
const STREAM_OVERLOADED = new Anthropic.APIError(undefined, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'Overloaded', undefined);

beforeEach(() => {
  __resetClaudeOutage();
  fake.aiEnabled = true;
  for (const p of [fake.claude, fake.local]) {
    p.complete.mockReset();
    p.runTurn.mockReset();
  }
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe('classifyClaudeError', () => {
  it('falls back on credit, key, access, rate limit, overload, server and connection errors', () => {
    expect(classifyClaudeError(CREDIT)?.reason).toBe('Claude: credit balance too low');
    expect(classifyClaudeError(apiError(401, 'authentication_error', 'invalid x-api-key'))?.reason).toBe('Claude: API key rejected');
    expect(classifyClaudeError(apiError(403, 'permission_error', 'no'))?.reason).toBe('Claude: access refused');
    expect(classifyClaudeError(apiError(429, 'rate_limit_error', 'slow down'))?.pauseMs).toBe(60_000);
    expect(classifyClaudeError(apiError(529, 'overloaded_error', 'Overloaded'))?.reason).toBe('Claude: overloaded');
    expect(classifyClaudeError(apiError(500, 'api_error', 'oops'))?.reason).toBe('Claude: server error 500');
    expect(classifyClaudeError(STREAM_OVERLOADED)?.reason).toBe('Claude: overloaded');
    expect(classifyClaudeError(new Anthropic.APIConnectionError({ message: 'Connection error.' }))?.reason).toBe('Claude: not reachable');
    expect(classifyClaudeError(new Anthropic.APIConnectionTimeoutError())?.reason).toBe('Claude: not reachable');
  });

  it('does not fall back on a malformed request or an abort', () => {
    expect(classifyClaudeError(apiError(400, 'invalid_request_error', 'messages: field required'))).toBeNull();
    expect(classifyClaudeError(new Anthropic.APIUserAbortError())).toBeNull();
    expect(classifyClaudeError(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))).toBeNull();
  });
});

describe('withProviderFallback', () => {
  it('redoes the work with the local provider — under its own name — when Claude has no credit', async () => {
    fake.claude.complete.mockRejectedValue(CREDIT);
    fake.local.complete.mockResolvedValue('{"ok":true}');
    const seen: string[] = [];
    const out = await withProviderFallback(resolveProvider, async (p) => {
      seen.push(p.name);
      return { name: p.name, text: await p.complete({ systemPrompt: 'S', parts: [] }) };
    });
    expect(seen).toEqual(['anthropic', 'ollama']);
    expect(out).toEqual({ name: 'ollama', text: '{"ok":true}' });
    expect(claudeOutage()?.reason).toBe('Claude: credit balance too low');
  });

  it('leaves Claude alone when it answers, and rethrows a malformed-request 400', async () => {
    fake.claude.complete.mockResolvedValueOnce('fine');
    expect(await withProviderFallback(resolveProvider, (p) => p.complete({ systemPrompt: 'S', parts: [] }))).toBe('fine');
    fake.claude.complete.mockRejectedValueOnce(apiError(400, 'invalid_request_error', 'messages: field required'));
    await expect(withProviderFallback(resolveProvider, (p) => p.complete({ systemPrompt: 'S', parts: [] }))).rejects.toThrow('field required');
    expect(fake.local.complete).not.toHaveBeenCalled();
    expect(claudeOutage()).toBeNull();
  });

  it('says plainly when the local model fails too, without its host detail', async () => {
    fake.claude.complete.mockRejectedValue(CREDIT);
    fake.local.complete.mockRejectedValue(new Error('connect ECONNREFUSED 100.64.0.1:8000'));
    await expect(withProviderFallback(resolveProvider, (p) => p.complete({ systemPrompt: 'S', parts: [] }))).rejects.toThrow(
      'AI is unavailable right now: Claude: credit balance too low, and the local model did not answer either.',
    );
  });

  it('keeps a typed error from the local run (e.g. a bad JSON reply) as it is', async () => {
    class BadReply extends Error {}
    fake.claude.complete.mockRejectedValue(CREDIT);
    fake.local.complete.mockResolvedValue('not json');
    await expect(
      withProviderFallback(resolveProvider, async (p) => {
        const raw = await p.complete({ systemPrompt: 'S', parts: [] });
        if (raw === 'not json') throw new BadReply('bad');
        return raw;
      }),
    ).rejects.toBeInstanceOf(BadReply);
  });

  it('without a local model there is nothing to fall back to', async () => {
    fake.aiEnabled = false;
    fake.claude.complete.mockRejectedValue(CREDIT);
    await expect(withProviderFallback(resolveProvider, (p) => p.complete({ systemPrompt: 'S', parts: [] }))).rejects.toBe(CREDIT);
    expect(fake.local.complete).not.toHaveBeenCalled();
  });
});

describe('providerAfterFailure', () => {
  it('only reacts to Claude failing', async () => {
    expect(await providerAfterFailure(CREDIT, fake.local, resolveProvider)).toBeNull();
    expect(await providerAfterFailure(CREDIT, fake.claude, resolveProvider)).toBe(fake.local);
  });
});

describe('pickProvider during an outage', () => {
  it('Claude normally, the local model while Claude is out, Claude again after', async () => {
    vi.useFakeTimers();
    expect(pickProvider('auto')).toBe(fake.claude);
    await providerAfterFailure(apiError(529, 'overloaded_error', 'Overloaded'), fake.claude, resolveProvider);
    expect(pickProvider('auto')).toBe(fake.local);
    expect(pickProvider('anthropic')).toBe(fake.local);
    const status = await providerStatus();
    expect(status.active?.name).toBe('ollama');
    expect(status.claudeOutage?.reason).toBe('Claude: overloaded');
    vi.advanceTimersByTime(61_000);
    expect(pickProvider('auto')).toBe(fake.claude);
    expect((await providerStatus()).claudeOutage).toBeNull();
  });
});
