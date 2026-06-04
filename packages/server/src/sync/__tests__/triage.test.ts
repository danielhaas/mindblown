/**
 * Tests for the AI triage service (#92, #93).
 *
 * The Anthropic SDK is injected via the `provider` option on
 * `triageIssue` so we don't need ANTHROPIC_API_KEY set in CI. The
 * provider stub mimics `client.messages.create` returning a single
 * text content block — the same shape the real SDK produces when the
 * model isn't using tools.
 *
 * Coverage:
 *   - Happy paths for each of the 3 decision kinds.
 *   - Hallucinated parentNodeId → downgraded to uncertain.
 *   - Markdown-fenced JSON output is still parsed.
 *   - LLM throw → `triage_error:` uncertain, no rethrow.
 *   - LLM returns garbage → uncertain with reason explaining the parse failure.
 *   - confidence is clamped to [0, 100].
 *   - Reason and decision text are preserved verbatim.
 */

import { describe, it, expect, vi } from 'vitest';
import type { GitHubIssue } from '@mindblown/integrations';
import type { MapContext } from '../mapContext.js';
import { triageIssue, type TriageProvider } from '../triage.js';

// ── Fixtures ──────────────────────────────────────────────────────

function makeMapContext(overrides: Partial<MapContext> = {}): MapContext {
  return {
    mapId: 'map-1',
    mapName: 'Test Map',
    mapDescription: 'A map for triage tests',
    epics: [
      {
        nodeId: '11111111-1111-1111-1111-111111111111',
        title: 'Frontend',
        description: 'UI work',
      },
      {
        nodeId: '22222222-2222-2222-2222-222222222222',
        title: 'Backend',
        description: 'API and DB',
      },
    ],
    ...overrides,
  };
}

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    id: 100,
    number: 100,
    title: 'Fix the login button',
    body: 'The button is broken',
    state: 'open',
    labels: [{ name: 'bug' }],
    assignees: [],
    milestone: null,
    html_url: 'https://github.com/o/r/issues/100',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function fakeProvider(responseText: string): TriageProvider {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: responseText }],
      })),
    },
  };
}

function throwingProvider(err: Error): TriageProvider {
  return {
    messages: {
      create: vi.fn(async () => {
        throw err;
      }),
    },
  };
}

// ── Happy paths ───────────────────────────────────────────────────

describe('triageIssue — happy paths', () => {
  it('parses a "place" decision with a valid epic UUID', async () => {
    const provider = fakeProvider(
      JSON.stringify({
        decision: 'place',
        parentNodeId: '11111111-1111-1111-1111-111111111111',
        reason: 'matches Frontend',
        confidence: 88,
      }),
    );
    const result = await triageIssue(
      { issue: makeIssue(), mapContext: makeMapContext() },
      { provider },
    );
    expect(result.decision).toBe('place');
    expect(result.parentNodeId).toBe('11111111-1111-1111-1111-111111111111');
    expect(result.reason).toBe('matches Frontend');
    expect(result.confidence).toBe(88);
  });

  it('parses a "skip" decision (no parentNodeId expected)', async () => {
    const provider = fakeProvider(
      JSON.stringify({
        decision: 'skip',
        reason: 'closed bug from unrelated repo',
        confidence: 92,
      }),
    );
    const result = await triageIssue(
      {
        issue: makeIssue({ state: 'closed' }),
        mapContext: makeMapContext(),
      },
      { provider },
    );
    expect(result.decision).toBe('skip');
    expect(result.parentNodeId).toBeUndefined();
    expect(result.confidence).toBe(92);
  });

  it('parses an "uncertain" decision', async () => {
    const provider = fakeProvider(
      JSON.stringify({
        decision: 'uncertain',
        reason: 'could fit either epic',
        confidence: 55,
      }),
    );
    const result = await triageIssue(
      { issue: makeIssue(), mapContext: makeMapContext() },
      { provider },
    );
    expect(result.decision).toBe('uncertain');
    expect(result.confidence).toBe(55);
  });

  it('strips a markdown code fence around the JSON', async () => {
    const provider = fakeProvider(
      '```json\n' +
        JSON.stringify({
          decision: 'place',
          parentNodeId: '22222222-2222-2222-2222-222222222222',
          reason: 'backend',
          confidence: 80,
        }) +
        '\n```',
    );
    const result = await triageIssue(
      { issue: makeIssue(), mapContext: makeMapContext() },
      { provider },
    );
    expect(result.decision).toBe('place');
    expect(result.parentNodeId).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('extracts JSON when the LLM prepends prose', async () => {
    const provider = fakeProvider(
      'Sure, here is the answer:\n' +
        JSON.stringify({
          decision: 'skip',
          reason: 'no match',
          confidence: 70,
        }) +
        '\nLet me know if you need anything else.',
    );
    const result = await triageIssue(
      { issue: makeIssue(), mapContext: makeMapContext() },
      { provider },
    );
    expect(result.decision).toBe('skip');
  });

  it('clamps confidence above 100', async () => {
    const provider = fakeProvider(
      JSON.stringify({ decision: 'skip', reason: 'ok', confidence: 150 }),
    );
    const result = await triageIssue(
      { issue: makeIssue(), mapContext: makeMapContext() },
      { provider },
    );
    expect(result.confidence).toBe(100);
  });

  it('clamps negative confidence to 0', async () => {
    const provider = fakeProvider(
      JSON.stringify({ decision: 'skip', reason: 'ok', confidence: -10 }),
    );
    const result = await triageIssue(
      { issue: makeIssue(), mapContext: makeMapContext() },
      { provider },
    );
    expect(result.confidence).toBe(0);
  });
});

// ── Hallucinated / invalid parent ─────────────────────────────────

describe('triageIssue — hallucinated parent', () => {
  it('downgrades place→uncertain when parentNodeId is not in the offered epics', async () => {
    const provider = fakeProvider(
      JSON.stringify({
        decision: 'place',
        parentNodeId: '99999999-9999-9999-9999-999999999999',
        reason: 'I made this up',
        confidence: 95,
      }),
    );
    const result = await triageIssue(
      { issue: makeIssue(), mapContext: makeMapContext() },
      { provider },
    );
    expect(result.decision).toBe('uncertain');
    expect(result.parentNodeId).toBeUndefined();
    expect(result.reason).toMatch(/lacked a valid parentNodeId/);
    // Reason from the LLM is preserved as a suffix.
    expect(result.reason).toMatch(/I made this up/);
  });

  it('downgrades place→uncertain when parentNodeId is missing', async () => {
    const provider = fakeProvider(
      JSON.stringify({
        decision: 'place',
        reason: 'forgot to include parent',
        confidence: 70,
      }),
    );
    const result = await triageIssue(
      { issue: makeIssue(), mapContext: makeMapContext() },
      { provider },
    );
    expect(result.decision).toBe('uncertain');
  });

  it('treats unrecognised decision kind as uncertain', async () => {
    const provider = fakeProvider(
      JSON.stringify({
        decision: 'maybe-place',
        reason: 'made up a decision',
        confidence: 50,
      }),
    );
    const result = await triageIssue(
      { issue: makeIssue(), mapContext: makeMapContext() },
      { provider },
    );
    expect(result.decision).toBe('uncertain');
    expect(result.reason).toMatch(/unrecognised decision kind/);
  });
});

// ── Error normalisation ───────────────────────────────────────────

describe('triageIssue — error normalisation (never throws)', () => {
  it('LLM throw → uncertain with triage_error: prefix', async () => {
    const provider = throwingProvider(new Error('upstream 503'));
    const result = await triageIssue(
      { issue: makeIssue(), mapContext: makeMapContext() },
      { provider },
    );
    expect(result.decision).toBe('uncertain');
    expect(result.reason).toMatch(/^triage_error:/);
    expect(result.reason).toMatch(/upstream 503/);
    expect(result.confidence).toBe(0);
  });

  it('non-JSON response → uncertain with parse-error reason', async () => {
    const provider = fakeProvider('this is not json at all, sorry');
    const result = await triageIssue(
      { issue: makeIssue(), mapContext: makeMapContext() },
      { provider },
    );
    expect(result.decision).toBe('uncertain');
    expect(result.reason).toMatch(/^triage_error:/);
    expect(result.confidence).toBe(0);
  });

  it('malformed JSON → uncertain with parse-error reason', async () => {
    const provider = fakeProvider('{"decision": "skip", "reason":');
    const result = await triageIssue(
      { issue: makeIssue(), mapContext: makeMapContext() },
      { provider },
    );
    expect(result.decision).toBe('uncertain');
    expect(result.reason).toMatch(/^triage_error:/);
  });

  it('empty content blocks → uncertain (no JSON found)', async () => {
    const provider: TriageProvider = {
      messages: { create: vi.fn(async () => ({ content: [] })) },
    };
    const result = await triageIssue(
      { issue: makeIssue(), mapContext: makeMapContext() },
      { provider },
    );
    expect(result.decision).toBe('uncertain');
    expect(result.confidence).toBe(0);
  });
});

// ── Prompt construction ───────────────────────────────────────────

describe('triageIssue — request construction', () => {
  it('passes the system prompt with cache_control set', async () => {
    const create = vi.fn(async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            decision: 'skip',
            reason: 'no',
            confidence: 70,
          }),
        },
      ],
    }));
    const provider: TriageProvider = { messages: { create } };

    await triageIssue(
      { issue: makeIssue(), mapContext: makeMapContext() },
      { provider },
    );

    expect(create).toHaveBeenCalledTimes(1);
    const arg = (create.mock.calls as unknown as Array<Array<Record<string, unknown>>>)[0][0];
    // System prompt is an array of text blocks; the first must carry
    // cache_control so the static guidance caches across calls.
    const system = arg.system as Array<{ text: string; cache_control?: unknown }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    // The user message has the map context block FIRST and the
    // issue-specific block second. The map-context block is the cached
    // one (changes infrequently); the issue block changes per call.
    const messages = arg.messages as Array<{
      role: string;
      content: Array<{ type: string; text: string; cache_control?: unknown }>;
    }>;
    expect(messages[0].role).toBe('user');
    expect(messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(messages[0].content[1].cache_control).toBeUndefined();
  });

  it('uses TRIAGE_MODEL by default but honors the opts override', async () => {
    const create = vi.fn(async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ decision: 'skip', reason: 'x', confidence: 80 }),
        },
      ],
    }));
    const provider: TriageProvider = { messages: { create } };
    await triageIssue(
      { issue: makeIssue(), mapContext: makeMapContext() },
      { provider, model: 'claude-haiku-test' },
    );
    const arg = (create.mock.calls as unknown as Array<Array<Record<string, unknown>>>)[0][0];
    expect(arg.model).toBe('claude-haiku-test');
  });

  it('renders an empty-epics map context without crashing', async () => {
    const provider = fakeProvider(
      JSON.stringify({
        decision: 'uncertain',
        reason: 'no epics offered',
        confidence: 30,
      }),
    );
    const result = await triageIssue(
      {
        issue: makeIssue(),
        mapContext: makeMapContext({ epics: [] }),
      },
      { provider },
    );
    expect(result.decision).toBe('uncertain');
  });
});
