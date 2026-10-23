/**
 * The local model behind Claude. When Anthropic refuses a call for a reason
 * that isn't the request's fault — no credit, bad key, rate limit, overload,
 * server error, network — the caller's work is redone from the start with
 * the provider resolved again, which during the outage is the local one.
 * Redone, not just re-sent: callers shape prompts, tools, models and
 * auto-apply thresholds by `provider.name`, so the local answer has to come
 * from the local provider under its own name.
 *
 * The outage also makes `pickProvider` skip Claude for a while (15 min for
 * billing/key, 1 min for load), so later calls don't pay the failed round
 * trip first. A request Claude rejects as malformed (other 400s) and an
 * aborted call are not retried.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider } from './types.js';

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

const isA = (err: unknown, cls: unknown): boolean => typeof cls === 'function' && err instanceof (cls as new () => object);

/** Why Claude failed in plain words, and how long to skip it — or null when the local model wouldn't help. */
export function classifyClaudeError(err: unknown): { reason: string; pauseMs: number } | null {
  if (isA(err, Anthropic.APIUserAbortError) || (err as { name?: string })?.name === 'AbortError') return null;
  if (isA(err, Anthropic.APIConnectionError)) return { reason: 'Claude: not reachable', pauseMs: SHORT_OUTAGE_MS };
  const e = err as { status?: number; message?: string; error?: { type?: string; error?: { type?: string; message?: string } } };
  const status = e?.status;
  // An error event inside the stream has no status, only the body's type.
  const type = e?.error?.error?.type ?? e?.error?.type;
  const message = e?.error?.error?.message ?? e?.message ?? '';
  if (type === 'billing_error' || (status === 400 && /credit balance/i.test(message))) {
    return { reason: 'Claude: credit balance too low', pauseMs: LONG_OUTAGE_MS };
  }
  if (status === 401 || type === 'authentication_error') return { reason: 'Claude: API key rejected', pauseMs: LONG_OUTAGE_MS };
  if (status === 403 || type === 'permission_error') return { reason: 'Claude: access refused', pauseMs: LONG_OUTAGE_MS };
  if (status === 429 || type === 'rate_limit_error') return { reason: 'Claude: rate limited', pauseMs: SHORT_OUTAGE_MS };
  if (status === 529 || type === 'overloaded_error') return { reason: 'Claude: overloaded', pauseMs: SHORT_OUTAGE_MS };
  if ((typeof status === 'number' && status >= 500) || type === 'api_error') {
    return { reason: `Claude: server error${status ? ` ${status}` : ''}`, pauseMs: SHORT_OUTAGE_MS };
  }
  return null;
}

/**
 * `provider` just failed with `err`. When that was Claude failing for an
 * outage-type reason: note the outage and return the provider to redo the
 * work with (the local one). Otherwise null — the caller rethrows.
 */
export async function providerAfterFailure(
  err: unknown,
  provider: Pick<ChatProvider, 'name'>,
  resolve: () => Promise<ChatProvider>,
): Promise<ChatProvider | null> {
  if (provider.name !== 'anthropic') return null;
  const why = classifyClaudeError(err);
  if (!why) return null;
  outage = { reason: why.reason, until: new Date(Date.now() + why.pauseMs) };
  console.warn(`[ai] ${why.reason} — using the local model until ${outage.until.toISOString()}`);
  const next = await resolve();
  // No local model configured: nothing to fall back to.
  return next.name === 'anthropic' ? null : next;
}

/** One plain sentence when the local model failed as well; the detail (hosts) goes to the log only. */
export function bothFailedError(localErr: unknown): Error {
  console.error('[ai] local model failed after Claude:', localErr instanceof Error ? localErr.message : localErr);
  return new Error(`AI is unavailable right now: ${claudeOutage()?.reason ?? 'Claude failed'}, and the local model did not answer either.`);
}

/**
 * Run `work` with the resolved provider; if Claude fails for an outage-type
 * reason, run it again from the start with the provider resolved anew.
 * `work` must be safe to repeat (no side effects before the model answers).
 */
export async function withProviderFallback<T>(
  resolve: () => Promise<ChatProvider>,
  work: (provider: ChatProvider) => Promise<T>,
): Promise<T> {
  const provider = await resolve();
  try {
    return await work(provider);
  } catch (err) {
    const next = await providerAfterFailure(err, provider, resolve);
    if (!next) throw err;
    try {
      return await work(next);
    } catch (localErr) {
      // Typed errors (a bad JSON reply, a policy refusal) keep their meaning for the route.
      if (localErr instanceof Error && localErr.constructor !== Error) throw localErr;
      throw bothFailedError(localErr);
    }
  }
}
