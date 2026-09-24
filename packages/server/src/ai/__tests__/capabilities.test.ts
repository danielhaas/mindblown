/**
 * No-LLM mode (#364).
 *
 * The capability flags are the one place every surface asks "is this AI
 * feature offered here?". These tests pin the derivation per backend and
 * the two route-level guarantees a private install depends on:
 *
 *   1. `GET /api/ai/config` answers 200 with `capabilities` even when no
 *      LLM is configured — the frontend needs it to hide affordances.
 *   2. Every other `/api/ai/*` route answers 503 AI_NOT_CONFIGURED with
 *      the operator-facing message (surfaced verbatim by MCP tool errors).
 *
 * Backends are toggled by re-mocking the env-derived constants and
 * re-importing the modules, since both flags are computed at import time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// Heavy transitive imports of routes/ai.ts that the tests never reach.
vi.mock('../../ai/tools.js', () => ({
  getChatToolSpecs: vi.fn(() => []),
  executeTool: vi.fn(),
  renderTreeForPrompt: vi.fn(() => ''),
  renderFocusContext: vi.fn(() => ''),
}));
vi.mock('../../ai/embeddings.js', () => ({
  semanticSearch: vi.fn(async () => []),
  backfillMapEmbeddings: vi.fn(),
  scheduleEmbedNode: vi.fn(),
}));
vi.mock('../../db/nodes.js', () => ({}));
vi.mock('../../db/maps.js', () => ({}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../db/settings.js', () => ({
  getAiProviderSettings: vi.fn(async () => ({ preference: 'auto' })),
  setAiProviderSettings: vi.fn(async (s: unknown) => s),
}));
// Per-map policy (#375): a DB read in the real module. The route test only
// needs "map-none reads all-false, map-any reads the server flags".
const policyMocks = vi.hoisted(() => ({ policy: 'any' as 'any' | 'local' | 'none' }));
vi.mock('../../ai/policy.js', async () => {
  const NONE = { enabled: false, chat: false, structured: false, embeddings: false, triage: false };
  return {
    AiPolicyError: class extends Error { code = 'AI_POLICY'; policy = 'none'; },
    getMapAiPolicy: async () => policyMocks.policy,
    capabilitiesForMap: async () => {
      if (policyMocks.policy === 'none') return NONE;
      const caps = await import('../capabilities.js');
      return caps.aiCapabilities();
    },
    resolveProviderForMap: async () => { throw new Error('not used'); },
  };
});

interface Backends {
  ollama: boolean;
  anthropic: boolean;
}

async function load(backends: Backends) {
  vi.resetModules();
  vi.doMock('../../ai/client.js', () => ({
    aiEnabled: backends.ollama,
    embedEnabled: backends.ollama,
    aiConfig: () => ({
      enabled: backends.ollama,
      baseUrl: backends.ollama ? 'http://ollama' : '(not set)',
      model: 'qwen2.5:14b',
      embedModel: 'nomic-embed-text',
    }),
    chatCompletion: vi.fn(),
  }));
  vi.doMock('../../ai/providers/anthropic.js', () => ({
    anthropicAvailable: backends.anthropic,
    anthropicProvider: { name: 'anthropic', model: 'claude-test' },
  }));
  vi.doMock('../../ai/providers/ollama.js', () => ({
    ollamaProvider: { name: 'ollama', model: 'qwen2.5:14b' },
  }));
  const caps = await import('../capabilities.js');
  const routes = await import('../../routes/ai.js');
  return { caps, routes };
}

async function buildApp(backends: Backends) {
  const { routes } = await load(backends);
  const app = Fastify();
  await app.register(routes.aiRoutes);
  await app.ready();
  return app;
}

describe('aiCapabilities()', () => {
  beforeEach(() => vi.resetModules());

  it('is all-false with no backend configured', async () => {
    const { caps } = await load({ ollama: false, anthropic: false });
    expect(caps.aiCapabilities()).toEqual({
      enabled: false,
      chat: false,
      structured: false,
      embeddings: false,
      triage: false,
    });
  });

  it('local backend alone offers chat/structured/embeddings/triage', async () => {
    const { caps } = await load({ ollama: true, anthropic: false });
    expect(caps.aiCapabilities()).toEqual({
      enabled: true,
      chat: true,
      structured: true,
      embeddings: true,
      triage: true,
    });
  });

  it('Anthropic alone offers everything except embeddings (no embeddings API)', async () => {
    const { caps } = await load({ ollama: false, anthropic: true });
    expect(caps.aiCapabilities()).toEqual({
      enabled: true,
      chat: true,
      structured: true,
      embeddings: false,
      triage: true,
    });
  });
});

describe('aiRoutes in no-LLM mode', () => {
  it('serves /api/ai/config with capabilities all false', async () => {
    const app = await buildApp({ ollama: false, anthropic: false });
    const res = await app.inject({ method: 'GET', url: '/api/ai/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(false);
    expect(body.capabilities).toEqual({
      enabled: false,
      chat: false,
      structured: false,
      embeddings: false,
      triage: false,
    });
    expect(body.active).toBeNull();
    await app.close();
  });

  it('answers every feature route with 503 AI_NOT_CONFIGURED and the operator message', async () => {
    const app = await buildApp({ ollama: false, anthropic: false });
    for (const [method, url] of [
      ['POST', '/api/ai/chat'],
      ['POST', '/api/ai/breakdown'],
      ['POST', '/api/ai/estimate'],
      ['POST', '/api/ai/standup'],
      ['GET', '/api/ai/search?q=x'],
    ] as const) {
      const res = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(503);
      const body = res.json();
      expect(body.error.code).toBe('AI_NOT_CONFIGURED');
      expect(body.error.message).toMatch(/disabled on this server/);
      expect(body.error.message).toMatch(/AI_BASE_URL/);
    }
    await app.close();
  });

  it('serves per-map flags with ?mapId= — a none map reads all-false on a configured server', async () => {
    const app = await buildApp({ ollama: true, anthropic: true });
    policyMocks.policy = 'none';
    const res = await app.inject({ method: 'GET', url: '/api/ai/config?mapId=m1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true); // server-wide answer unchanged
    expect(body.policy).toBe('none');
    expect(body.capabilities).toEqual({
      enabled: false, chat: false, structured: false, embeddings: false, triage: false,
    });
    policyMocks.policy = 'any';
    const res2 = await app.inject({ method: 'GET', url: '/api/ai/config?mapId=m1' });
    expect(res2.json().capabilities.chat).toBe(true);
    expect(res2.json().policy).toBe('any');
    await app.close();
  });

  it('serves /api/ai/config with the real flags when a backend exists', async () => {
    const app = await buildApp({ ollama: true, anthropic: false });
    const res = await app.inject({ method: 'GET', url: '/api/ai/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.capabilities.structured).toBe(true);
    expect(body.capabilities.triage).toBe(true);
    expect(body.active).toEqual({ name: 'ollama', model: 'qwen2.5:14b' });
    await app.close();
  });
});
