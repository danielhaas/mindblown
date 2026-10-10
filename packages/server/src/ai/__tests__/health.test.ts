/**
 * Local AI backends count only while they answer (#429): the probe keeps
 * their reachability, capabilities fold it in, and a dead embedder is not
 * called on every node edit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  models: vi.fn(),
  probeEmbedding: vi.fn(),
  embed: vi.fn(),
}));

vi.mock('../client.js', () => ({
  aiEnabled: true,
  embedEnabled: true,
  AI_MODEL_NAME: 'qwen/qwen3.8-27b',
  getClient: () => ({ models: { list: m.models } }),
  probeEmbedding: m.probeEmbedding,
  embed: m.embed,
}));
vi.mock('../providers/anthropic.js', () => ({ anthropicAvailable: false }));

import OpenAI from 'openai';
import { probeChat, probeEmbeddings, aiHealth, localChatUsable, embeddingsUsable, onEmbeddingsRecovered, _resetAiHealthForTests } from '../health.js';
import { aiCapabilities } from '../capabilities.js';
import { embedText } from '../embeddings.js';

beforeEach(() => {
  _resetAiHealthForTests();
  m.models.mockReset();
  m.probeEmbedding.mockReset();
  m.embed.mockReset();
});

describe('AI backend health (#429)', () => {
  it('unknown before the first probe counts as usable — a cold start must not hide AI', () => {
    expect(localChatUsable()).toBe(true);
    expect(embeddingsUsable()).toBe(true);
    expect(aiCapabilities()).toMatchObject({ chat: true, embeddings: true });
  });

  it('a server that answers is up; a model it does not list is only a warning (no false "down")', async () => {
    m.models.mockResolvedValue({ data: [{ id: 'qwen/qwen3.8-27b' }] });
    await probeChat();
    expect(aiHealth().chat).toMatchObject({ reachable: true, downSince: null, lastError: null, warning: null });

    m.models.mockResolvedValue({ data: [{ id: 'qwen/qwen3.8-27b:latest' }] });
    await probeChat();
    expect(aiHealth().chat.warning).toBeNull(); // Ollama-style tag still counts as listed

    m.models.mockResolvedValue({ data: [{ id: 'other-model' }] });
    await probeChat();
    expect(aiHealth().chat.reachable).toBe(true);
    expect(aiHealth().chat.warning).toMatch(/not in the server's list/);
    expect(aiCapabilities()).toMatchObject({ enabled: true, chat: true });
  });

  it('chat down: chat and structured off, but triage stays on (it fails visibly as triage_error instead of skipping)', async () => {
    m.models.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await probeChat();
    expect(aiCapabilities()).toMatchObject({ enabled: false, chat: false, structured: false, triage: true });
  });

  it('an unreachable host turns the capability off; recovery turns it back on and clears downSince', async () => {
    m.models.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await probeChat();
    const down = aiHealth().chat;
    expect(down.reachable).toBe(false);
    expect(down.downSince).not.toBeNull();
    // A second failing probe keeps the original downSince.
    await probeChat();
    expect(aiHealth().chat.downSince).toBe(down.downSince);
    m.models.mockResolvedValue({ data: [{ id: 'qwen/qwen3.8-27b' }] });
    await probeChat();
    expect(aiHealth().chat).toMatchObject({ reachable: true, downSince: null });
  });

  it('a 4xx for one input does not switch embeddings off for everyone', async () => {
    m.embed.mockRejectedValueOnce(new OpenAI.APIError(400, { error: 'too long' }, 'context overflow', new Headers()));
    await expect(embedText('a very long node')).rejects.toBeTruthy();
    expect(embeddingsUsable()).toBe(true);
  });

  it('the embedder coming back fires the recovery hook (the server re-embeds what changed)', async () => {
    const hook = vi.fn();
    onEmbeddingsRecovered(hook);
    m.probeEmbedding.mockRejectedValueOnce(new Error('down'));
    await probeEmbeddings();
    expect(hook).not.toHaveBeenCalled();
    m.probeEmbedding.mockResolvedValueOnce(undefined);
    await probeEmbeddings();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('a dead embedder: embedText stops calling it until the probe sees it back', async () => {
    m.embed.mockRejectedValueOnce(new OpenAI.APIError(502, { error: 'bad gateway' }, '502 Bad Gateway', new Headers()));
    await expect(embedText('node title')).rejects.toThrow(/502/);
    expect(embeddingsUsable()).toBe(false);
    expect(aiCapabilities().embeddings).toBe(false);

    expect(await embedText('another edit')).toBeNull();
    expect(m.embed).toHaveBeenCalledTimes(1); // no second call while down

    m.probeEmbedding.mockResolvedValue(undefined);
    await probeEmbeddings();
    m.embed.mockResolvedValue([[0.1, 0.2]]);
    expect(await embedText('after recovery')).toEqual([0.1, 0.2]);
  });
});
