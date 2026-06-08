/**
 * AI triage for incoming GitHub issues (#92, #93).
 *
 * Phase 0 of the triage feature. Given a GitHub issue + a summary of the
 * map's top-level epics, produces one of three decisions:
 *
 *   - `place`    — the issue belongs in the map; LLM proposes a parent
 *                  epic and a confidence score.
 *   - `skip`     — the issue does not belong (e.g. closed bug from
 *                  another component, test scenario, coordination chatter).
 *   - `uncertain`— LLM can't decide; the row is persisted and waits for
 *                  human review.
 *
 * Failure modes are explicitly normalised to `uncertain` rather than
 * thrown — triage runs inside `ensureNodeForIssue` and an LLM hiccup must
 * NEVER block the upstream webhook/catchup. The caller persists the row
 * regardless, so an operator can re-classify or override after the fact.
 *
 * Provider: we use the existing `ai/providers/anthropic.ts` plumbing
 * (same SDK, same env-var pattern) but issue a one-shot non-streaming
 * `messages.create` call rather than going through the chat tool-use
 * loop. The chat ChatProvider abstraction is built around streaming and
 * tool calls; triage is single-shot JSON classification with no tools,
 * so spinning up the streaming infrastructure would be pure overhead.
 *
 * Prompt caching: the map context is the bulk of input tokens and
 * changes infrequently. We mark it with `cache_control: ephemeral` so
 * subsequent triage calls in the same 5-min window pay only for the
 * delta (the issue's title + body + labels). With dozens of webhook
 * ticks per hour this drops Anthropic spend ~80%.
 *
 * Default model: Haiku-class. Triage is a cheap classification task and
 * the top-tier reasoning models (Opus) would be 10× the cost for no
 * material accuracy lift. Overridable via TRIAGE_MODEL env var.
 */

import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { GitHubIssue } from '@mindblown/integrations';
import type { MapContext } from './mapContext.js';

// ── Public types ──────────────────────────────────────────────────

export type TriageDecisionKind = 'skip' | 'place' | 'uncertain';

export interface TriageInput {
  issue: GitHubIssue;
  mapContext: MapContext;
}

export interface TriageDecision {
  decision: TriageDecisionKind;
  /**
   * Only set when `decision === 'place'`. UUID of the epic the LLM
   * picked from `mapContext.epics`. The caller validates that this
   * matches one of the offered epics before applying — a hallucinated
   * UUID falls back to `uncertain` at the call site.
   */
  parentNodeId?: string;
  /** Free-text LLM reasoning — persisted verbatim for audit. */
  reason: string;
  /** 0-100. We treat <0 / >100 as clamped at the boundary. */
  confidence: number;
}

// ── Config ────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
/**
 * Default chosen to be Haiku-class: cheap, fast, good enough at
 * structured classification. Overridable via env. Falls back to a known
 * Haiku model if TRIAGE_MODEL is unset and the upstream Anthropic
 * model catalogue ever drifts; the caller doesn't depend on a specific
 * model version, only on JSON output.
 */
export const TRIAGE_MODEL = process.env.TRIAGE_MODEL ?? 'claude-haiku-4-5';

/**
 * Confidence threshold above which a `place` decision is auto-applied
 * (the node gets created under the suggested parent without human
 * review). Below this, the decision is persisted but the node is NOT
 * created — operator review required.
 *
 * 75 is conservative: in the pilot dataset, Claude scored 90+ on
 * obvious epic matches and 50-70 on ambiguous ones. Setting the cut
 * at 75 keeps the auto-apply false-positive rate near zero while still
 * picking up the bulk of unambiguous routes.
 */
export const TRIAGE_AUTO_APPLY_CONFIDENCE = parseConfidenceEnv(
  process.env.TRIAGE_AUTO_APPLY_CONFIDENCE,
  75,
);

function parseConfidenceEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 100) return fallback;
  return n;
}

// ── Cost optimisation: body-hash idempotency + per-issue debounce ─
//
// Three layers stack at progressively coarser granularity (#142):
//
//   1. Diff-aware skip on `issues.edited` (webhook handler — outermost).
//   2. Per-issue debounce window (this module — short-circuits the
//      same-issue burst inside the LLM-call window).
//   3. Body-hash idempotency (caller — short-circuits when the canonical
//      input tuple matches the last persisted hash).
//
// Layers 2 + 3 live here because they share the `(mapId, externalId)`
// keying and they both belong on the LLM-call boundary; the diff-aware
// skip is webhook-shape-specific and lives next to the payload parsing.

/**
 * Canonical hash of the inputs that drive a triage decision. SHA-256 of
 * a JSON-stringified tuple of `{title, body, labels (sorted), state}`.
 *
 * Labels are sorted by `name` so the order GitHub returns them in
 * doesn't poison the hash (the GitHub API doesn't guarantee a stable
 * label ordering across calls). `body` defaults to the empty string so
 * a null/undefined body hashes identically across SDK shapes. `state`
 * is folded in so a closed/reopened transition without a body change
 * still re-triages — closing an issue is a real signal change.
 *
 * Persisted in `triage_decisions.last_input_hash`; compared against the
 * freshly-computed hash on the next ingest. Identical → LLM call is
 * skipped (#142 layer 3). Operator reclassify with `force=true`
 * bypasses the comparison.
 */
export function computeInputHash(issue: {
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  labels?: Array<{ name: string }> | null;
}): string {
  const labels = (issue.labels ?? [])
    .map((l) => l.name)
    .filter((n): n is string => typeof n === 'string')
    .slice()
    .sort();
  const payload = JSON.stringify({
    title: issue.title,
    body: issue.body ?? '',
    labels,
    state: issue.state,
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Per-issue debounce window, in milliseconds. A second `triageIssue`
 * call for the same `(mapId, externalId)` within this window short-
 * circuits without an LLM round-trip. Defaults to 60 s; override via
 * the `TRIAGE_DEBOUNCE_WINDOW_MS` env var. Setting to `0` disables
 * the debounce entirely (useful for tests / per-deploy disable).
 */
let _debounceWindowMs = parseDebounceMs(
  process.env.TRIAGE_DEBOUNCE_WINDOW_MS,
);

function parseDebounceMs(raw: string | undefined): number {
  if (!raw) return 60_000;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 60_000;
  return n;
}

/**
 * In-memory map of last-triage timestamps per `(mapId, externalId)`.
 * Same single-process precedent as #75's catchup counter — works
 * because the server is a single Node process per deploy. A future
 * multi-process deploy would need to lift this into Redis; the body-
 * hash layer below keeps the worst-case cost bounded even without it.
 */
const _debounceMap = new Map<string, number>();

function debounceKey(mapId: string, externalId: string): string {
  return `${mapId}/${externalId}`;
}

/**
 * Test-only: clear the debounce map between tests. Production code
 * never calls this — the entries naturally fall out of the window.
 */
export function _resetDebounceWindow(): void {
  _debounceMap.clear();
}

/**
 * Test-only: override the debounce window length. Production code
 * uses the env-var default; tests use this to drive both
 * within-window and past-window paths without `setTimeout(60_000)`.
 */
export function _setDebounceWindowMs(ms: number): void {
  _debounceWindowMs = ms;
}

/**
 * Returns the current debounce window in milliseconds. Exposed for
 * callers that want to log a "debounced for Ns" diagnostic. Mostly
 * useful in tests.
 */
export function getDebounceWindowMs(): number {
  return _debounceWindowMs;
}

/**
 * Returns true if `(mapId, externalId)` was triaged within the
 * debounce window. Caller MUST stamp `markTriageDebounce` after a
 * successful LLM call — this read-only check is intentionally
 * decoupled so a caller can fall back to the body-hash layer when
 * the debounce window expires but the hash still matches.
 */
export function isWithinDebounceWindow(
  mapId: string,
  externalId: string,
  now: number = Date.now(),
): boolean {
  if (_debounceWindowMs <= 0) return false;
  const lastAt = _debounceMap.get(debounceKey(mapId, externalId));
  if (lastAt === undefined) return false;
  return now - lastAt < _debounceWindowMs;
}

/**
 * Stamp the debounce timestamp for `(mapId, externalId)`. Called by
 * the ingest path after a successful LLM round-trip OR after a
 * hash-match short-circuit — both count as "we know the current
 * decision, don't re-call for the next N seconds." Skip on
 * triage_error so a transient LLM failure doesn't lock us out of
 * retrying for 60 s.
 */
export function markTriageDebounce(
  mapId: string,
  externalId: string,
  now: number = Date.now(),
): void {
  if (_debounceWindowMs <= 0) return;
  _debounceMap.set(debounceKey(mapId, externalId), now);
}

/**
 * Clear the debounce timestamp for a single `(mapId, externalId)`.
 * Used by the operator reclassify route — when the operator forces a
 * fresh classification, an immediately-following webhook delivery
 * should NOT be debounced (the operator is explicitly soliciting a
 * new LLM read). Scoped to the one key so other in-flight bursts
 * aren't disrupted.
 */
export function clearTriageDebounce(
  mapId: string,
  externalId: string,
): void {
  _debounceMap.delete(debounceKey(mapId, externalId));
}

// ── Anthropic client (lazy) ───────────────────────────────────────

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    if (ANTHROPIC_API_KEY.length === 0) {
      throw new Error('Triage requires ANTHROPIC_API_KEY (no fallback yet)');
    }
    _client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return _client;
}

/**
 * Test-only override for the underlying Anthropic client. Lets the
 * unit tests inject a fake `messages.create` without monkey-patching
 * the SDK. The runTriageDirect export below also supports passing an
 * explicit client, which is the cleaner injection point — this is the
 * escape hatch for code paths that go through `triageIssue` itself.
 */
export function _setTriageClientForTests(client: unknown | null): void {
  _client = client as Anthropic | null;
}

// ── Prompts ───────────────────────────────────────────────────────

/**
 * Static system prompt — same on every call, so it caches well. The
 * concrete map context + issue are user-content blocks below.
 */
const SYSTEM_PROMPT = `You are a triage assistant for a mindmap-based project management tool called MindBlown. Your job is to decide what happens to an inbound GitHub issue.

You will see:
  - A summary of the user's MindBlown map (name, description, and the top-level "epic" nodes that organise the work).
  - A single GitHub issue: title, body, state (open/closed), and labels.

Decide ONE of:
  - "place"     — The issue belongs in this map under a specific epic. Pick the epic that best matches.
  - "skip"      — The issue does NOT belong in this map (e.g. closed bug from an unrelated component, test scenario, coordination chatter, feedback that should live elsewhere).
  - "uncertain" — You can't tell. The issue may belong but the fit isn't clear, or the available epics don't cover the topic well.

Calibration guidance:
  - High confidence (85-100): The issue's topic matches an epic's title or description almost word-for-word.
  - Medium confidence (60-84): Plausible fit, but the issue could also belong to a different epic or to no epic at all.
  - Low confidence (<60): Flag as "uncertain" instead of forcing a "place".

Output STRICTLY a JSON object with these fields, no markdown fences:
  {
    "decision": "place" | "skip" | "uncertain",
    "parentNodeId": "<UUID from the epics list, ONLY when decision is 'place'>",
    "reason": "<one or two sentences explaining your choice — this is persisted in the audit log>",
    "confidence": <integer 0-100>
  }

For "skip" and "uncertain" decisions, OMIT parentNodeId entirely. Do not invent a UUID — only use UUIDs that appeared in the map context's epics list.`;

function buildUserMessage(input: TriageInput): {
  context: string;
  issue: string;
} {
  const ctx = input.mapContext;
  const epicsText =
    ctx.epics.length === 0
      ? '(this map has no top-level epics yet)'
      : ctx.epics
          .map(
            (e) =>
              `- nodeId: ${e.nodeId}\n  title: ${e.title}\n  description: ${
                e.description ? e.description.slice(0, 500) : '(no description)'
              }`,
          )
          .join('\n');

  const contextBlock = `<map>
name: ${ctx.mapName}
description: ${ctx.mapDescription || '(no description)'}

available top-level epics:
${epicsText}
</map>`;

  const issue = input.issue;
  const labels = (issue.labels ?? []).map((l) => l.name).join(', ');
  const issueBlock = `<issue>
title: ${issue.title}
state: ${issue.state}
labels: ${labels || '(none)'}
body:
${(issue.body ?? '').slice(0, 4000)}
</issue>

Decide the disposition. Respond with the JSON object only.`;

  return { context: contextBlock, issue: issueBlock };
}

// ── JSON parsing + validation ─────────────────────────────────────

interface ParsedLlmOutput {
  decision?: unknown;
  parentNodeId?: unknown;
  reason?: unknown;
  confidence?: unknown;
}

/**
 * Locate a JSON object inside the LLM's textual response. We've asked
 * for raw JSON, but models occasionally wrap the answer in a markdown
 * fence or prepend an apology. Strip fences first, then extract the
 * first {...} block. Returns null if no plausible JSON is found.
 */
function extractJson(text: string): string | null {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  if (stripped.startsWith('{')) return stripped;
  // Fallback: find the first '{' and matching '}' substring.
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) return stripped.slice(start, end + 1);
  return null;
}

function clampConfidence(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * Parse + validate the LLM's JSON output. Caller decisions:
 *   - Decision must be one of the three known kinds; anything else
 *     collapses to `uncertain`.
 *   - `parentNodeId` is only honored on `place` decisions AND only if
 *     it matches a UUID present in the offered epics list. A
 *     hallucinated UUID downgrades the call to `uncertain` so we
 *     never create a node under a non-existent parent.
 *   - `confidence` is clamped to [0, 100]; non-numeric → 0.
 *   - `reason` falls back to a placeholder if missing.
 *
 * Returns a TriageDecision in all cases — never throws.
 */
function validateDecision(
  parsed: ParsedLlmOutput,
  validEpicIds: Set<string>,
): TriageDecision {
  const rawDecision =
    typeof parsed.decision === 'string' ? parsed.decision.toLowerCase() : '';
  const reason =
    typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
      ? parsed.reason.trim()
      : 'no reason provided';
  const confidence = clampConfidence(parsed.confidence);

  if (rawDecision === 'skip') {
    return { decision: 'skip', reason, confidence };
  }
  if (rawDecision === 'place') {
    const pid =
      typeof parsed.parentNodeId === 'string' ? parsed.parentNodeId : '';
    if (validEpicIds.has(pid)) {
      return { decision: 'place', parentNodeId: pid, reason, confidence };
    }
    // Hallucinated or missing UUID — downgrade rather than crash.
    return {
      decision: 'uncertain',
      reason: `place decision lacked a valid parentNodeId (got ${JSON.stringify(parsed.parentNodeId)}); ${reason}`,
      confidence,
    };
  }
  if (rawDecision === 'uncertain') {
    return { decision: 'uncertain', reason, confidence };
  }
  // Unknown decision kind.
  return {
    decision: 'uncertain',
    reason: `unrecognised decision kind ${JSON.stringify(parsed.decision)}; ${reason}`,
    confidence,
  };
}

// ── Provider call ─────────────────────────────────────────────────

/**
 * Minimal shape we depend on from the Anthropic SDK. Test code can
 * inject any object that satisfies it — no need to mock the full SDK.
 */
export interface TriageProvider {
  messages: {
    create: (req: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

interface TriageCallOpts {
  model?: string;
  /**
   * Inject an alternate provider for tests. Defaults to the lazy
   * Anthropic client. When set, ANTHROPIC_API_KEY isn't required.
   */
  provider?: TriageProvider;
}

/**
 * Single Anthropic round-trip. Extracted so the test suite can call
 * this with an injected provider without going through the env-gated
 * `getClient()` path.
 */
async function callTriageProvider(
  input: TriageInput,
  opts: TriageCallOpts = {},
): Promise<string> {
  const provider: TriageProvider = opts.provider ?? (getClient() as unknown as TriageProvider);
  const model = opts.model ?? TRIAGE_MODEL;
  const { context, issue } = buildUserMessage(input);

  const response = await provider.messages.create({
    model,
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        // System prompt is static across all triage calls — cache it
        // so we only pay full-tokens cost the first time per 5-min window.
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            // Map context is the bulk of the per-call tokens but
            // changes only when the map's epics change. Mark it
            // cacheable so multiple triage calls in the same window
            // share the cost. Anthropic supports multiple cache
            // breakpoints per request; placing one here keeps the
            // issue-specific content uncached (it changes every call).
            type: 'text',
            text: context,
            cache_control: { type: 'ephemeral' },
          },
          { type: 'text', text: issue },
        ],
      },
    ],
  });

  // Concatenate every `text` content block in the response. Triage
  // doesn't use tool_use, so the response should be a single text
  // block, but we tolerate multiples defensively.
  const parts: string[] = [];
  for (const block of response.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('').trim();
}

// ── Public entry point ────────────────────────────────────────────

/**
 * Triage a single GitHub issue against a map's context. Returns a
 * decision in ALL cases — LLM failures normalise to `uncertain` with
 * a `triage_error:` reason prefix rather than throwing. The caller
 * persists the decision regardless and decides whether to act on it.
 *
 * `opts` is intended for test injection; production callers use the
 * one-arg form and pick up env-driven defaults.
 */
export async function triageIssue(
  input: TriageInput,
  opts: TriageCallOpts = {},
): Promise<TriageDecision> {
  const validEpicIds = new Set(input.mapContext.epics.map((e) => e.nodeId));

  let text: string;
  try {
    text = await callTriageProvider(input, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      decision: 'uncertain',
      reason: `triage_error: ${msg}`,
      confidence: 0,
    };
  }

  const jsonText = extractJson(text);
  if (!jsonText) {
    return {
      decision: 'uncertain',
      reason: `triage_error: LLM returned no parseable JSON (got ${JSON.stringify(text.slice(0, 200))})`,
      confidence: 0,
    };
  }

  let parsed: ParsedLlmOutput;
  try {
    parsed = JSON.parse(jsonText) as ParsedLlmOutput;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      decision: 'uncertain',
      reason: `triage_error: invalid JSON: ${msg}`,
      confidence: 0,
    };
  }

  return validateDecision(parsed, validEpicIds);
}
