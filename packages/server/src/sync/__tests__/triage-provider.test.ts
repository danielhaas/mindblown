/**
 * Triage on the provider abstraction (#365).
 *
 * Pins three behaviours a local-only install depends on:
 *   1. `resolveTriageProvider()` honours TRIAGE_PROVIDER / the chat
 *      preference with the chat panel's availability fallback.
 *   2. A decision records which backend and model produced it, and the
 *      prompt reaches the backend through `complete` with the map
 *      context marked cacheable.
 *   3. Local-model decisions are review-only by default: neither
 *      auto-apply nor auto-confirm-skip fires at any confidence, while
 *      Claude decisions keep the calibrated thresholds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitHubIssue } from '@mindblown/integrations';
import type { MapContext } from '../mapContext.js';

const mocks = vi.hoisted(() => ({
  pickProvider: vi.fn(),
  resolveProvider: vi.fn(),
}));
vi.mock('../../ai/providers/index.js', () => ({
  pickProvider: mocks.pickProvider,
  resolveProvider: mocks.resolveProvider,
}));

import {
  triageIssue,
  resolveTriageProvider,
  triageModelFor,
  autoApplyThreshold,
  shouldAutoConfirmSkip,
  TRIAGE_AUTO_APPLY_CONFIDENCE,
  TRIAGE_LOCAL_AUTO_APPLY_CONFIDENCE,
  TRIAGE_MODEL,
  type TriageProvider,
} from '../triage.js';

const EPIC = '11111111-1111-1111-1111-111111111111';

function mapContext(): MapContext {
  return {
    mapId: 'map-1',
    mapName: 'Test Map',
    mapDescription: '',
    epics: [{ nodeId: EPIC, title: 'Frontend', description: 'UI work' }],
    versions: [],
  };
}

function issue(): GitHubIssue {
  return {
    id: 1,
    number: 1,
    title: 'Button broken',
    body: 'It does nothing',
    state: 'open',
    labels: [],
    assignees: [],
    milestone: null,
    html_url: 'https://github.com/o/r/issues/1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as GitHubIssue;
}

function provider(name: 'ollama' | 'anthropic', reply: string): TriageProvider & { complete: ReturnType<typeof vi.fn> } {
  return { name, model: `${name}-default`, complete: vi.fn(async () => reply) };
}

const PLACE = JSON.stringify({ decision: 'place', parentNodeId: EPIC, reason: 'ui', confidence: 99 });

beforeEach(() => {
  mocks.pickProvider.mockReset();
  mocks.resolveProvider.mockReset();
});

describe('resolveTriageProvider', () => {
  it('auto follows the chat resolver', async () => {
    const p = provider('anthropic', '{}');
    mocks.resolveProvider.mockResolvedValue(p);
    expect(await resolveTriageProvider('auto')).toBe(p);
    expect(mocks.pickProvider).not.toHaveBeenCalled();
  });

  it('a pinned backend is used when available', async () => {
    const p = provider('ollama', '{}');
    mocks.pickProvider.mockReturnValue(p);
    expect(await resolveTriageProvider('ollama')).toBe(p);
    expect(mocks.pickProvider).toHaveBeenCalledWith('ollama');
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
  });

  it('a pinned backend that is not configured falls back like the chat panel', async () => {
    const p = provider('anthropic', '{}');
    mocks.pickProvider.mockReturnValue(null);
    mocks.resolveProvider.mockResolvedValue(p);
    expect(await resolveTriageProvider('ollama')).toBe(p);
  });
});

describe('triageModelFor', () => {
  it('uses Haiku on Claude and the backend default locally (no TRIAGE_MODEL in this test env)', () => {
    expect(triageModelFor({ name: 'anthropic', model: 'claude-opus-4-7' })).toBe(TRIAGE_MODEL);
    expect(triageModelFor({ name: 'ollama', model: 'qwen2.5:14b' })).toBe('qwen2.5:14b');
  });
});

describe('triageIssue through complete', () => {
  it('sends system prompt + cacheable map context + issue tail, records backend and model', async () => {
    const p = provider('ollama', PLACE);
    const decision = await triageIssue({ issue: issue(), mapContext: mapContext() }, { provider: p });

    expect(decision.decision).toBe('place');
    expect(decision.provider).toEqual({ name: 'ollama', model: 'ollama-default' });

    const call = p.complete.mock.calls[0][0];
    expect(call.model).toBe('ollama-default');
    expect(call.systemPrompt.length).toBeGreaterThan(100);
    expect(call.parts).toHaveLength(2);
    expect(call.parts[0].cacheable).toBe(true);
    expect(call.parts[0].text).toContain('Frontend');
    expect(call.parts[1].cacheable).toBeUndefined();
    expect(call.parts[1].text).toContain('Button broken');
  });

  it('resolves the backend itself when none is injected', async () => {
    const p = provider('anthropic', PLACE);
    mocks.resolveProvider.mockResolvedValue(p);
    const decision = await triageIssue({ issue: issue(), mapContext: mapContext() });
    expect(decision.provider).toEqual({ name: 'anthropic', model: TRIAGE_MODEL });
    expect(p.complete.mock.calls[0][0].model).toBe(TRIAGE_MODEL);
  });

  it('a resolver failure becomes a triage_error decision without a provider', async () => {
    mocks.resolveProvider.mockRejectedValue(new Error('No chat provider configured'));
    const decision = await triageIssue({ issue: issue(), mapContext: mapContext() });
    expect(decision.decision).toBe('uncertain');
    expect(decision.reason).toMatch(/^triage_error: No chat provider configured/);
    expect(decision.provider).toBeUndefined();
  });
});

describe('local decisions are review-only by default', () => {
  it('auto-apply threshold is unreachable for a local backend, calibrated for Claude', () => {
    expect(TRIAGE_LOCAL_AUTO_APPLY_CONFIDENCE).toBe(101);
    expect(autoApplyThreshold({ provider: { name: 'ollama', model: 'x' } })).toBe(101);
    expect(autoApplyThreshold({ provider: { name: 'anthropic', model: 'x' } })).toBe(TRIAGE_AUTO_APPLY_CONFIDENCE);
    // Decisions with no provider (error paths) keep the Claude threshold —
    // they never reach 'place' with confidence anyway.
    expect(autoApplyThreshold({})).toBe(TRIAGE_AUTO_APPLY_CONFIDENCE);
  });

  it('a 100-confidence local place is not auto-applied, the same from Claude is', async () => {
    const reply = JSON.stringify({ decision: 'place', parentNodeId: EPIC, reason: 'ui', confidence: 100 });
    const local = await triageIssue({ issue: issue(), mapContext: mapContext() }, { provider: provider('ollama', reply) });
    const claude = await triageIssue({ issue: issue(), mapContext: mapContext() }, { provider: provider('anthropic', reply) });
    expect(local.confidence >= autoApplyThreshold(local)).toBe(false);
    expect(claude.confidence >= autoApplyThreshold(claude)).toBe(true);
  });

  it('auto-confirm-skip never fires for a local backend', () => {
    const skip = { decision: 'skip' as const, confidence: 100 };
    expect(shouldAutoConfirmSkip({ ...skip, provider: { name: 'ollama', model: 'x' } }, 'closed')).toBe(false);
    expect(shouldAutoConfirmSkip({ ...skip, provider: { name: 'anthropic', model: 'x' } }, 'closed')).toBe(true);
  });
});
