/**
 * Per-map AI policy (#375).
 *
 * The invariants a private project depends on:
 *   - `none`  → no capability, no provider, ever;
 *   - `local` → the local provider and ONLY the local provider — with no
 *               local backend configured the answer is "off", never Claude;
 *   - `any`   → the server-wide behaviour, unchanged;
 *   - an unreadable policy (DB error) fails closed to `none`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ aiPolicy: string }>,
  throwOnSelect: false,
  aiEnabled: true,
  embedEnabled: true,
  anthropicAvailable: true,
  resolveProvider: vi.fn(),
}));

vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (mocks.throwOnSelect) throw new Error('db down');
            return mocks.rows;
          },
        }),
      }),
    }),
  },
}));
vi.mock('../../db/schema.js', () => ({ maps: { id: 'id', aiPolicy: 'ai_policy' } }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));
vi.mock('../client.js', () => ({
  get aiEnabled() { return mocks.aiEnabled; },
  get embedEnabled() { return mocks.embedEnabled; },
}));
vi.mock('../providers/anthropic.js', () => ({
  get anthropicAvailable() { return mocks.anthropicAvailable; },
}));
vi.mock('../providers/index.js', () => ({
  resolveProvider: mocks.resolveProvider,
}));
vi.mock('../providers/ollama.js', () => ({
  ollamaProvider: { name: 'ollama', model: 'qwen-test' },
}));

import {
  AiPolicyError,
  capabilitiesForPolicy,
  getMapAiPolicy,
  resolveProviderForMap,
  resolveProviderForPolicy,
  mapAllowsEmbeddings,
} from '../policy.js';

const CLAUDE = { name: 'anthropic', model: 'claude-test' };

beforeEach(() => {
  mocks.rows = [];
  mocks.throwOnSelect = false;
  mocks.aiEnabled = true;
  mocks.embedEnabled = true;
  mocks.anthropicAvailable = true;
  mocks.resolveProvider.mockReset();
  mocks.resolveProvider.mockResolvedValue(CLAUDE);
});

describe('getMapAiPolicy', () => {
  it('reads the stored policy', async () => {
    mocks.rows = [{ aiPolicy: 'local' }];
    expect(await getMapAiPolicy('m1')).toBe('local');
  });
  it('an unknown map reads as any (the route 404s it)', async () => {
    expect(await getMapAiPolicy('missing')).toBe('any');
  });
  it('a garbage value reads as any', async () => {
    mocks.rows = [{ aiPolicy: 'cloud-please' }];
    expect(await getMapAiPolicy('m1')).toBe('any');
  });
  it('a DB error fails CLOSED to none', async () => {
    mocks.throwOnSelect = true;
    expect(await getMapAiPolicy('m1')).toBe('none');
  });
});

describe('capabilitiesForPolicy', () => {
  it('none → nothing', () => {
    expect(capabilitiesForPolicy('none')).toEqual({
      enabled: false, chat: false, structured: false, embeddings: false, triage: false,
    });
  });
  it('local → what the local backend offers, Claude ignored', () => {
    expect(capabilitiesForPolicy('local')).toEqual({
      enabled: true, chat: true, structured: true, embeddings: true, triage: true,
    });
    mocks.aiEnabled = false;
    expect(capabilitiesForPolicy('local')).toEqual({
      enabled: false, chat: false, structured: false, embeddings: true, triage: false,
    });
  });
  it('any → the server-wide flags', () => {
    mocks.aiEnabled = false;
    expect(capabilitiesForPolicy('any').chat).toBe(true); // Claude still there
  });
});

describe('resolveProviderForPolicy / ForMap', () => {
  it('none throws AiPolicyError and never consults the resolver', async () => {
    await expect(resolveProviderForPolicy('none')).rejects.toBeInstanceOf(AiPolicyError);
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
  });
  it('local pins the local provider without the resolver', async () => {
    const p = await resolveProviderForPolicy('local');
    expect(p.name).toBe('ollama');
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
  });
  it('local with no local backend throws — it does NOT fall back to Claude', async () => {
    mocks.aiEnabled = false;
    await expect(resolveProviderForPolicy('local')).rejects.toMatchObject({ code: 'AI_POLICY', policy: 'local' });
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
  });
  it('any defers to the resolver', async () => {
    expect(await resolveProviderForPolicy('any')).toBe(CLAUDE);
  });
  it('ForMap reads the stored policy first', async () => {
    mocks.rows = [{ aiPolicy: 'none' }];
    await expect(resolveProviderForMap('m1')).rejects.toBeInstanceOf(AiPolicyError);
    mocks.rows = [{ aiPolicy: 'any' }];
    expect(await resolveProviderForMap('m1')).toBe(CLAUDE);
  });
});

describe('mapAllowsEmbeddings', () => {
  it('none forbids, local and any allow while an embedder exists', async () => {
    mocks.rows = [{ aiPolicy: 'none' }];
    expect(await mapAllowsEmbeddings('m1')).toBe(false);
    mocks.rows = [{ aiPolicy: 'local' }];
    expect(await mapAllowsEmbeddings('m1')).toBe(true);
    mocks.embedEnabled = false;
    expect(await mapAllowsEmbeddings('m1')).toBe(false);
  });
});
