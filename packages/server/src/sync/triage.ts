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
 * Provider: triage goes through the shared `ChatProvider.complete()`
 * primitive (`ai/providers/`), so it runs on Claude or on a local
 * OpenAI-compatible model — whichever `TRIAGE_PROVIDER` / the admin's
 * chat preference resolves to. Single-shot JSON classification, no
 * tools, no streaming.
 *
 * Prompt caching: the map context is the bulk of input tokens and
 * changes infrequently. It is passed as a `cacheable` part so a backend
 * with prompt caching (Claude) pays only for the delta (the issue's
 * title + body + labels) within a cache window. With dozens of webhook
 * ticks per hour this drops Anthropic spend ~80%.
 *
 * Default model: Haiku-class on Claude — triage is a cheap classification
 * task and the top-tier reasoning models would be 10× the cost for no
 * material accuracy lift. A local backend uses its own default model.
 * Overridable via TRIAGE_MODEL env var.
 *
 * Local backends are review-only by default: their confidence numbers
 * are not calibrated against the Claude thresholds, so auto-apply and
 * auto-confirm-skip are disabled unless the operator lowers the
 * `TRIAGE_LOCAL_*` levers.
 */

import { createHash } from 'crypto';
import { aiCapabilities } from '../ai/capabilities.js';
import { capabilitiesForMap, getMapAiPolicy, resolveProviderForPolicy } from '../ai/policy.js';
import { pickProvider, resolveProvider } from '../ai/providers/index.js';
import type { ChatProvider, ProviderName } from '../ai/providers/types.js';
import type { AiProviderPreference } from '../db/settings.js';
import type { AiPolicy } from '@mindblown/core';
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
  /**
   * Release lane the LLM picked from `mapContext.versions`, on `place`
   * decisions only. Validated against the offered list like
   * `parentNodeId`, but an invalid/missing pick does NOT downgrade the
   * decision — the ingest layer falls back to the map's active lane
   * (`resolveIngestVersionId` in sync/githubIngest.ts).
   */
  versionId?: string;
  /** Free-text LLM reasoning — persisted verbatim for audit. */
  reason: string;
  /** 0-100. We treat <0 / >100 as clamped at the boundary. */
  confidence: number;
  /**
   * Which backend produced this decision. Drives the auto-apply
   * thresholds (local models are review-only by default) and is worth
   * keeping in the audit reason trail. Absent when the call never
   * reached a provider (no LLM configured, resolver threw).
   */
  provider?: { name: ProviderName; model: string };
}

// ── Config ────────────────────────────────────────────────────────

/**
 * Whether this server can run LLM triage at all. The ingest layer checks
 * this before entering the triage path so a no-LLM install falls through
 * to the plain inbox flow instead of recording a `triage_error` decision
 * for every incoming issue. Derived from the shared capability flags so
 * there is exactly one answer to "is triage available?".
 */
export async function triageAvailable(mapId?: string): Promise<boolean> {
  if (!aiCapabilities().triage) return false;
  // Per-map AI policy (#375): `none` turns triage off for that map, `local`
  // keeps it only while a local backend exists.
  if (mapId) return (await capabilitiesForMap(mapId)).triage;
  return true;
}

/**
 * Which backend runs triage. `auto` (default) follows the admin-selected
 * chat preference in system_settings, with the same availability
 * fallback as the chat panel; `anthropic` / `ollama` pin a backend but
 * still fall back when it isn't configured.
 */
export const TRIAGE_PROVIDER: AiProviderPreference = (() => {
  const raw = process.env.TRIAGE_PROVIDER;
  return raw === 'anthropic' || raw === 'ollama' ? raw : 'auto';
})();

/** Explicit `TRIAGE_MODEL` from env, applied to whichever backend runs. */
const TRIAGE_MODEL_OVERRIDE = process.env.TRIAGE_MODEL;

/**
 * Resolve the backend for one triage call. Exported for tests and for
 * the re-triage routes, which want the same answer the ingest path gets.
 */
export async function resolveTriageProvider(
  preference: AiProviderPreference = TRIAGE_PROVIDER,
  policy: AiPolicy = 'any',
): Promise<ChatProvider> {
  // The map's policy outranks TRIAGE_PROVIDER: `local` never reaches Claude,
  // `none` never reaches anything.
  if (policy !== 'any') return resolveProviderForPolicy(policy);
  if (preference !== 'auto') {
    const pinned = pickProvider(preference);
    if (pinned) return pinned;
  }
  return resolveProvider();
}

/** Model for a given backend: env override, else Haiku on Claude, else the backend's own default. */
export function triageModelFor(provider: Pick<ChatProvider, 'name' | 'model'>): string {
  if (TRIAGE_MODEL_OVERRIDE) return TRIAGE_MODEL_OVERRIDE;
  return provider.name === 'anthropic' ? TRIAGE_MODEL : provider.model;
}
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

/**
 * Confidence threshold at/above which a `skip` decision on a CLOSED
 * issue is persisted as already-reviewed (reviewed=true), so it never
 * enters the operator queue. `place` had this lever from day one
 * (TRIAGE_AUTO_APPLY_CONFIDENCE); skip did not, so every high-confidence
 * "closed tactical PR, no epic fit" row waited for a human ack — the
 * dominant review-burden pattern in production (~85% of skips).
 *
 * Scope is deliberately narrow: open-issue skips always queue for
 * review (a skipped open issue is potentially lost planning signal),
 * and `decidedBy` stays 'auto' so a later webhook or reclassify can
 * still overwrite the row — auto-confirm is not operator curation.
 *
 * Range 0-101; 101 disables the lever (confidence caps at 100).
 */
export const TRIAGE_AUTO_CONFIRM_SKIP_CONFIDENCE = parseConfidenceEnv(
  process.env.TRIAGE_AUTO_CONFIRM_SKIP_CONFIDENCE,
  95,
  101,
);

/**
 * Local-model counterparts of the two levers above. The Claude thresholds
 * were calibrated on Haiku; a 14B local model's confidence numbers are
 * not comparable, so by default nothing a local backend decides is
 * applied or confirmed without a human — 101 disables both levers
 * (confidence caps at 100). Operators lower these once they trust the
 * model they run.
 */
export const TRIAGE_LOCAL_AUTO_APPLY_CONFIDENCE = parseConfidenceEnv(
  process.env.TRIAGE_LOCAL_AUTO_APPLY_CONFIDENCE,
  101,
  101,
);
export const TRIAGE_LOCAL_AUTO_CONFIRM_SKIP_CONFIDENCE = parseConfidenceEnv(
  process.env.TRIAGE_LOCAL_AUTO_CONFIRM_SKIP_CONFIDENCE,
  101,
  101,
);

/** A decision made by anything other than Claude counts as "local". */
function isLocalDecision(decision: Pick<TriageDecision, 'provider'>): boolean {
  return decision.provider != null && decision.provider.name !== 'anthropic';
}

/** Auto-apply threshold that applies to this decision's backend. */
export function autoApplyThreshold(decision: Pick<TriageDecision, 'provider'>): number {
  return isLocalDecision(decision)
    ? TRIAGE_LOCAL_AUTO_APPLY_CONFIDENCE
    : TRIAGE_AUTO_APPLY_CONFIDENCE;
}

/**
 * Gate for the auto-confirm-skip lever. Callers pass the freshly
 * decided (or re-decided) triage outcome plus the issue state captured
 * at decision time.
 */
export function shouldAutoConfirmSkip(
  decision: Pick<TriageDecision, 'decision' | 'confidence' | 'provider'>,
  issueState: 'open' | 'closed',
): boolean {
  const threshold = isLocalDecision(decision)
    ? TRIAGE_LOCAL_AUTO_CONFIRM_SKIP_CONFIDENCE
    : TRIAGE_AUTO_CONFIRM_SKIP_CONFIDENCE;
  return (
    decision.decision === 'skip' &&
    issueState === 'closed' &&
    decision.confidence >= threshold
  );
}

function parseConfidenceEnv(
  raw: string | undefined,
  fallback: number,
  max = 100,
): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > max) return fallback;
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

On a "place" decision, ALSO pick the release lane (version) the issue belongs to, when the map context lists versions. Prefer a lane whose name/status the issue clearly matches (e.g. an explicit "V2" mention in the body, or a follow-up to work in a known lane); if you can't tell, OMIT versionId — the system falls back to the map's active lane.

Output STRICTLY a JSON object with these fields, no markdown fences:
  {
    "decision": "place" | "skip" | "uncertain",
    "parentNodeId": "<UUID from the epics list, ONLY when decision is 'place'>",
    "versionId": "<UUID from the versions list, ONLY when decision is 'place' and the lane is clear>",
    "reason": "<one or two sentences explaining your choice — this is persisted in the audit log>",
    "confidence": <integer 0-100>
  }

For "skip" and "uncertain" decisions, OMIT parentNodeId and versionId entirely. Do not invent a UUID — only use UUIDs that appeared in the map context's epics or versions lists.`;

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

  const versionsText =
    ctx.versions.length === 0
      ? '(this map has no release lanes)'
      : ctx.versions
          .map((v) => `- versionId: ${v.versionId}\n  name: ${v.name} (${v.status})`)
          .join('\n');

  const contextBlock = `<map>
name: ${ctx.mapName}
description: ${ctx.mapDescription || '(no description)'}

available top-level epics:
${epicsText}

available release lanes (versions):
${versionsText}
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
  versionId?: unknown;
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
 *   - `versionId` is only honored on `place` decisions AND only if it
 *     matches an offered version. Unlike a hallucinated parent, a bad
 *     versionId does NOT downgrade the decision — it's simply dropped
 *     and the ingest layer's active-lane fallback takes over.
 *   - `confidence` is clamped to [0, 100]; non-numeric → 0.
 *   - `reason` falls back to a placeholder if missing.
 *
 * Returns a TriageDecision in all cases — never throws.
 */
function validateDecision(
  parsed: ParsedLlmOutput,
  validEpicIds: Set<string>,
  validVersionIds: Set<string>,
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
      const vid =
        typeof parsed.versionId === 'string' && validVersionIds.has(parsed.versionId)
          ? parsed.versionId
          : undefined;
      return {
        decision: 'place',
        parentNodeId: pid,
        ...(vid ? { versionId: vid } : {}),
        reason,
        confidence,
      };
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
 * What triage needs from a backend: a name, a model label and one
 * completion call. Any `ChatProvider` satisfies it; tests inject a stub
 * without touching an SDK.
 */
export type TriageProvider = Pick<ChatProvider, 'name' | 'model' | 'complete'>;

interface TriageCallOpts {
  /** Override the model for this call (defaults per backend, see `triageModelFor`). */
  model?: string;
  /**
   * Inject a backend for tests or for callers that already resolved
   * one. Defaults to `resolveTriageProvider()`.
   */
  provider?: TriageProvider;
}

/**
 * Single structured round-trip against the resolved backend. Returns
 * the raw reply plus which backend/model produced it.
 */
async function callTriageProvider(
  input: TriageInput,
  opts: TriageCallOpts = {},
): Promise<{ text: string; provider: { name: ProviderName; model: string } }> {
  const provider: TriageProvider =
    opts.provider ??
    (await resolveTriageProvider(TRIAGE_PROVIDER, await getMapAiPolicy(input.mapContext.mapId)));
  const model = opts.model ?? triageModelFor(provider);
  const { context, issue } = buildUserMessage(input);

  const text = await provider.complete({
    systemPrompt: SYSTEM_PROMPT,
    format: 'json',
    model,
    maxTokens: 1024,
    parts: [
      // Map context is the bulk of the per-call tokens but changes only
      // when the map's epics change — cacheable on backends that support
      // prompt caching; the issue-specific tail changes every call.
      { text: context, cacheable: true },
      { text: issue },
    ],
  });

  return { text: text.trim(), provider: { name: provider.name, model } };
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
  const validVersionIds = new Set(
    input.mapContext.versions.map((v) => v.versionId),
  );

  let text: string;
  let provider: TriageDecision['provider'];
  try {
    const call = await callTriageProvider(input, opts);
    text = call.text;
    provider = call.provider;
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
      provider,
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
      provider,
    };
  }

  return { ...validateDecision(parsed, validEpicIds, validVersionIds), provider };
}
