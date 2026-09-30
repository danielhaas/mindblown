/**
 * AI_API_KEY plumbing: the OpenAI-compatible client sends the configured
 * bearer token (vLLM, LiteLLM and hosted endpoints refuse without one),
 * keeps the Ollama placeholder when none is set, and the embeddings
 * client inherits the key only when it shares the chat host.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ctorArgs: Array<Record<string, unknown>> = [];
vi.mock('openai', () => ({
  default: class FakeOpenAI {
    constructor(opts: Record<string, unknown>) {
      ctorArgs.push(opts);
    }
  },
}));

async function loadClient(env: Record<string, string | undefined>) {
  vi.resetModules();
  ctorArgs.length = 0;
  for (const k of ['AI_BASE_URL', 'AI_API_KEY', 'AI_EMBED_BASE_URL', 'AI_EMBED_API_KEY', 'AI_MODEL']) {
    if (env[k] === undefined) vi.stubEnv(k, '');
    else vi.stubEnv(k, env[k]!);
  }
  return import('../client.js');
}

beforeEach(() => ctorArgs.splice(0));
afterEach(() => vi.unstubAllEnvs());

describe('AI_API_KEY', () => {
  it('is sent as the bearer token and reported as configured (never echoed)', async () => {
    const c = await loadClient({ AI_BASE_URL: 'http://vllm:8100/v1', AI_API_KEY: 'sk-secret' });
    c.getClient();
    expect(ctorArgs[0]).toMatchObject({ baseURL: 'http://vllm:8100/v1', apiKey: 'sk-secret' });
    const cfg = c.aiConfig();
    expect(cfg.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(cfg)).not.toContain('sk-secret');
  });

  it('falls back to the Ollama placeholder when unset', async () => {
    const c = await loadClient({ AI_BASE_URL: 'http://ollama:11434/v1' });
    c.getClient();
    expect(ctorArgs[0]).toMatchObject({ apiKey: 'ollama' });
    expect(c.aiConfig().apiKeyConfigured).toBe(false);
  });

  it('embeddings on the same host share the key; on another host they get their own or none', async () => {
    const same = await loadClient({ AI_BASE_URL: 'http://vllm:8100/v1', AI_API_KEY: 'sk-secret' });
    same.getClient();
    await same.embed(['x']).catch(() => {}); // fake client has no embeddings API — only the ctor matters
    expect(ctorArgs).toHaveLength(1); // shared client, no second constructor

    const other = await loadClient({
      AI_BASE_URL: 'http://vllm:8100/v1',
      AI_API_KEY: 'sk-secret',
      AI_EMBED_BASE_URL: 'http://ollama:11434/v1',
    });
    other.getClient();
    await other.embed(['x']).catch(() => {});
    expect(ctorArgs[1]).toMatchObject({ baseURL: 'http://ollama:11434/v1', apiKey: 'ollama' });

    const own = await loadClient({
      AI_BASE_URL: 'http://vllm:8100/v1',
      AI_API_KEY: 'sk-secret',
      AI_EMBED_BASE_URL: 'http://embed:9000/v1',
      AI_EMBED_API_KEY: 'sk-embed',
    });
    own.getClient();
    await own.embed(['x']).catch(() => {});
    expect(ctorArgs[1]).toMatchObject({ baseURL: 'http://embed:9000/v1', apiKey: 'sk-embed' });
  });
});
