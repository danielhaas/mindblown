/**
 * Claude with the local model behind it. When Anthropic refuses a call for
 * a reason that isn't the request's fault — no credit, bad key, rate limit,
 * overload, server error, network — the same call goes to the local model,
 * and Claude is skipped for a while (`claudeOutage`) so the next calls don't
 * pay the failed round trip first. A request Claude rejects as malformed
 * (other 400s), or one the caller aborted, is not retried.
 */

import type { ChatProvider, CompletionOptions, ProviderEvent, RunTurnOptions } from './types.js';

/** Long pause for problems a person has to fix (billing, key); short for load. */
const LONG_OUTAGE_MS = 15 * 60_000;
const SHORT_OUTAGE_MS = 60_000;

export interface ClaudeOutage {
  reason: string;
  until: Date;
}

let outage: ClaudeOutage | null = null;

/** The current Claude outage, if one is in force. */
export function claudeOutage(now = Date.now()): ClaudeOutage | null {
  if (outage && outage.until.getTime() <= now) outage = null;
  return outage;
}

/** Tests only. */
export function __resetClaudeOutage(): void {
  outage = null;
}

/** Why Claude failed in plain words, and how long to skip it — or null when the local model wouldn't help. */
export function classifyClaudeError(err: unknown): { reason: string; pauseMs: number } | null {
  const e = err as { status?: number; name?: string; message?: string; error?: { error?: { type?: string; message?: string } } };
  if (e?.name === 'AbortError' || e?.name === 'APIUserAbortError') return null;
  const message = e?.error?.error?.message ?? e?.message ?? '';
  const status = e?.status;
  if (status === 400 && /credit balance/i.test(message)) return { reason: 'Claude: credit balance too low', pauseMs: LONG_OUTAGE_MS };
  if (status === 401) return { reason: 'Claude: API key rejected', pauseMs: LONG_OUTAGE_MS };
  if (status === 403) return { reason: 'Claude: access refused', pauseMs: LONG_OUTAGE_MS };
  if (status === 429) return { reason: 'Claude: rate limited', pauseMs: SHORT_OUTAGE_MS };
  if (status === 529) return { reason: 'Claude: overloaded', pauseMs: SHORT_OUTAGE_MS };
  if (typeof status === 'number' && status >= 500) return { reason: `Claude: server error ${status}`, pauseMs: SHORT_OUTAGE_MS };
  if (status === undefined && /connection|network|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|timed? ?out/i.test(`${e?.name} ${message}`)) {
    return { reason: 'Claude: not reachable', pauseMs: SHORT_OUTAGE_MS };
  }
  return null;
}

function noteOutage(why: { reason: string; pauseMs: number }): void {
  outage = { reason: why.reason, until: new Date(Date.now() + why.pauseMs) };
  console.warn(`[ai] ${why.reason} — using the local model until ${outage.until.toISOString()}`);
}

function bothFailed(claude: string, local: unknown): Error {
  const detail = local instanceof Error ? local.message : String(local);
  return new Error(`AI is unavailable right now. ${claude}, and the local model failed too (${detail}).`);
}

/** `primary` (Claude) with `local` taking over on outage-type failures. */
export function withLocalFallback(primary: ChatProvider, local: ChatProvider): ChatProvider {
  return {
    name: primary.name,
    model: primary.model,

    async complete(opts: CompletionOptions): Promise<string> {
      try {
        return await primary.complete(opts);
      } catch (err) {
        const why = classifyClaudeError(err);
        if (!why || opts.signal?.aborted) throw err;
        noteOutage(why);
        // A model override names a Claude model (triage's cheaper class); the local backend uses its own.
        try {
          return await local.complete({ ...opts, model: undefined });
        } catch (localErr) {
          throw bothFailed(why.reason, localErr);
        }
      }
    },

    async *runTurn(opts: RunTurnOptions): AsyncIterable<ProviderEvent> {
      let started = false;
      try {
        for await (const event of primary.runTurn(opts)) {
          started = true;
          yield event;
        }
        return;
      } catch (err) {
        // Once Claude has streamed part of a turn the caller has shown it; switching models mid-turn would garble it.
        const why = started ? null : classifyClaudeError(err);
        if (!why || opts.signal?.aborted) throw err;
        noteOutage(why);
      }
      try {
        yield* local.runTurn(opts);
      } catch (localErr) {
        throw bothFailed(claudeOutage()?.reason ?? 'Claude failed', localErr);
      }
    },
  };
}
