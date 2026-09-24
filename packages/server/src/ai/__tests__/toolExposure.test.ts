/**
 * Chat tool exposure by backend + model (#366).
 *
 * The semantic-search tool used to be gated per provider (Anthropic only).
 * It is now gated per model: Claude and large local models get it, small
 * local models (which pick between text and semantic search at random)
 * do not.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../backend.js', () => ({ createChatBackend: vi.fn() }));
vi.mock('../embeddings.js', () => ({ semanticSearch: vi.fn(async () => []) }));

import { getChatToolSpecs, isSmallLocalModel } from '../tools.js';

const has = (audience: { name: 'ollama' | 'anthropic'; model: string }, tool: string) =>
  getChatToolSpecs(audience).some((s) => s.name === tool);

describe('isSmallLocalModel', () => {
  it('flags sub-30B local models by their size tag', () => {
    for (const model of ['qwen2.5:14b', 'llama3.1:8b', 'mistral:7b-instruct', 'qwen2.5:14b-instruct-q4_K_M', 'gemma2:2b', 'phi3:3.8b']) {
      expect(isSmallLocalModel({ name: 'ollama', model }), model).toBe(true);
    }
  });

  it('does not flag large local models or Claude', () => {
    for (const model of ['qwen2.5:32b', 'llama3.1:70b', 'qwen3:235b', 'deepseek-r1:32b']) {
      expect(isSmallLocalModel({ name: 'ollama', model }), model).toBe(false);
    }
    expect(isSmallLocalModel({ name: 'anthropic', model: 'claude-haiku-4-5' })).toBe(false);
    expect(isSmallLocalModel({ name: 'anthropic', model: 'claude-opus-4-7' })).toBe(false);
  });
});

describe('getChatToolSpecs', () => {
  it('offers semantic_search to Claude and to large local models only', () => {
    expect(has({ name: 'anthropic', model: 'claude-opus-4-7' }, 'semantic_search')).toBe(true);
    expect(has({ name: 'ollama', model: 'qwen2.5:32b' }, 'semantic_search')).toBe(true);
    expect(has({ name: 'ollama', model: 'qwen2.5:14b' }, 'semantic_search')).toBe(false);
  });

  it('keeps the shared base tools for every audience', () => {
    const small = getChatToolSpecs({ name: 'ollama', model: 'qwen2.5:14b' }).map((s) => s.name);
    const claude = getChatToolSpecs({ name: 'anthropic', model: 'claude-opus-4-7' }).map((s) => s.name);
    expect(small.length).toBeGreaterThan(3);
    expect(claude).toEqual(expect.arrayContaining(small));
    expect(claude.length - small.length).toBe(1);
  });
});
