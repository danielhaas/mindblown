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

import { probeChat, probeEmbeddings, aiHealth, localChatUsable, embeddingsUsable, _resetAiHealthForTests } from '../health.js';
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

  it('chat is reachable only when the server lists AI_MODEL', async () => {
    m.models.mockResolvedValue({ data: [{ id: 'qwen/qwen3.8-27b' }] });
    await probeChat();
    expect(aiHealth().chat).toMatchObject({ reachable: true, downSince: null, lastError: null });

    m.models.mockResolvedValue({ data: [{ id: 'other-model' }] });
    await probeChat();
    expect(aiHealth().chat.reachable).toBe(false);
    expect(aiHealth().chat.lastError).toMatch(/not served/);
    expect(aiCapabilities()).toMatchObject({ enabled: false, chat: false, triage: false });
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

  it('a dead embedder: embedText stops calling it until the probe sees it back', async () => {
    m.embed.mockRejectedValueOnce(new Error('502 Bad Gateway'));
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
