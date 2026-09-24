/**
 * `completeJson()` on both chat providers (#365).
 *
 * The SDKs are stubbed at the module boundary; the tests pin the request
 * shape each backend sends (JSON mode + temperature 0 on the local side,
 * cache breakpoints on the Claude side) and the text that comes back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Local / OpenAI-compatible ─────────────────────────────────────
const openai = vi.hoisted(() => ({
  create: vi.fn(),
}));
vi.mock('../../client.js', () => ({
  getClient: () => ({ chat: { completions: { create: openai.create } } }),
  withAiSlot: <T,>(fn: () => Promise<T>) => fn(),
  aiEnabled: true,
}));

// ── Anthropic ─────────────────────────────────────────────────────
const anthropic = vi.hoisted(() => ({
  create: vi.fn(),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropic.create };
  },
}));

beforeEach(() => {
  openai.create.mockReset();
  anthropic.create.mockReset();
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
});

describe('ollamaProvider.completeJson', () => {
  it('asks for JSON mode at temperature 0 and returns the trimmed content', async () => {
    const { ollamaProvider } = await import('../ollama.js');
    openai.create.mockResolvedValue({
      choices: [{ message: { content: '  {"decision":"skip"}\n' } }],
    });
    const text = await ollamaProvider.completeJson({
      systemPrompt: 'SYS',
      parts: [{ text: 'CONTEXT', cacheable: true }, { text: 'ISSUE' }],
      model: 'qwen-test',
      maxTokens: 321,
    });
    expect(text).toBe('{"decision":"skip"}');
    const req = openai.create.mock.calls[0][0];
    expect(req.model).toBe('qwen-test');
    expect(req.temperature).toBe(0);
    expect(req.max_tokens).toBe(321);
    expect(req.response_format).toEqual({ type: 'json_object' });
    expect(req.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'CONTEXT\n\nISSUE' },
    ]);
  });

  it('returns an empty string when the backend sends no choice', async () => {
    const { ollamaProvider } = await import('../ollama.js');
    openai.create.mockResolvedValue({ choices: [] });
    expect(await ollamaProvider.completeJson({ systemPrompt: 's', parts: [{ text: 'x' }] })).toBe('');
  });
});

describe('anthropicProvider.completeJson', () => {
  it('places cache breakpoints on the system prompt and cacheable parts only', async () => {
    vi.resetModules();
    const { anthropicProvider } = await import('../anthropic.js');
    anthropic.create.mockResolvedValue({
      content: [
        { type: 'text', text: '{"decision":' },
        { type: 'text', text: '"place"}' },
      ],
    });
    const text = await anthropicProvider.completeJson({
      systemPrompt: 'SYS',
      parts: [{ text: 'CONTEXT', cacheable: true }, { text: 'ISSUE' }],
      model: 'claude-haiku-4-5',
    });
    expect(text).toBe('{"decision":"place"}');
    const req = anthropic.create.mock.calls[0][0];
    expect(req.model).toBe('claude-haiku-4-5');
    expect(req.max_tokens).toBe(1024);
    expect(req.system).toEqual([
      { type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } },
    ]);
    expect(req.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'CONTEXT', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'ISSUE' },
        ],
      },
    ]);
  });

  it('falls back to the provider default model', async () => {
    vi.resetModules();
    const { anthropicProvider } = await import('../anthropic.js');
    anthropic.create.mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });
    await anthropicProvider.completeJson({ systemPrompt: 's', parts: [{ text: 'x' }] });
    expect(anthropic.create.mock.calls[0][0].model).toBe(anthropicProvider.model);
  });
});
