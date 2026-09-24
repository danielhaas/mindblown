/**
 * AI capability flags — the single place that answers "which AI features
 * does THIS server offer?".
 *
 * A private install may run with Claude, with a local OpenAI-compatible
 * model (Ollama, vLLM, llama.cpp), or with no LLM at all. Every surface
 * that shows or executes an AI feature (REST routes, MCP tools, the
 * frontend, the GitHub triage pipeline) reads these flags instead of
 * checking env vars itself, so a feature is either fully offered or
 * cleanly absent — never a button that 503s on click.
 *
 * Derivation today (widened by #365 / #366):
 *   chat        — either backend, via the provider resolver
 *   structured  — breakdown / brain dump / estimate / refine / standup:
 *                 JSON-mode completions on the local backend only
 *   embeddings  — semantic search + backfill: local embeddings endpoint only
 *   triage      — GitHub issue triage: Anthropic only
 */

import { aiEnabled } from './client.js';
import { anthropicAvailable } from './providers/anthropic.js';

export interface AiCapabilities {
  /** Any LLM configured at all. False = "no-LLM mode". */
  enabled: boolean;
  /** In-app chat (`POST /api/ai/chat`). */
  chat: boolean;
  /** Structured-output features: breakdown, brain dump, estimate, refine, standup. */
  structured: boolean;
  /** Semantic search + embedding backfill. */
  embeddings: boolean;
  /** LLM triage of incoming GitHub issues. */
  triage: boolean;
}

export function aiCapabilities(): AiCapabilities {
  const enabled = aiEnabled || anthropicAvailable;
  return {
    enabled,
    chat: enabled,
    structured: aiEnabled,
    embeddings: aiEnabled,
    triage: anthropicAvailable,
  };
}

/** Operator-facing explanation used by 503s and MCP tool errors. */
export const AI_DISABLED_MESSAGE =
  'AI features are disabled on this server — no LLM is configured. ' +
  'Set AI_BASE_URL for a local OpenAI-compatible model or ANTHROPIC_API_KEY for Claude.';
