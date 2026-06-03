/**
 * Detect silent webhook signature-verification failures.
 *
 * Today: if GitHub's webhook secret drifts (rotated on the GH side,
 * forgotten in mindblown's config), webhook POSTs still arrive at
 * `/api/webhooks/github` but signature verification fails → handler
 * returns 401. The 5-min catchup reconciler picks up the slack so drift
 * stays at 0 — the operator never learns the realtime path is dead, and
 * every sync now lags by up to 5 min until someone notices.
 *
 * This module keeps a rolling 24h counter of webhook calls and how many
 * passed signature verification. A daily scheduler tick (see
 * `index.ts`) reads the counter and pushes to a dedicated Kuma monitor:
 *
 *   - `received >= MIN_THRESHOLD && authenticated === 0` →
 *     `status=down msg=webhook_auth_failed:received_N_authenticated_0`
 *     (the bad-secret case — alarms via the normal Kuma → Pushover
 *     chain)
 *   - `received >= MIN_THRESHOLD && authenticated >= 1` →
 *     `status=up msg=webhook_auth_ok:received_N_authenticated_M`
 *     (at least some pushes are passing; either healthy or in the
 *     middle of a rotation — don't alarm)
 *   - `received < MIN_THRESHOLD` → no push at all
 *     (too few samples to draw a conclusion; we deliberately do NOT
 *     push `status=down` for "received==0" because that's a different
 *     failure mode — webhook URL never configured on GH side — and
 *     conflating them would page the operator on freshly-deployed
 *     instances with no GH webhook wired yet)
 *
 * The MIN_THRESHOLD floor exists to avoid false-alarming on a quiet
 * day where the single webhook that lands happens to have a transient
 * auth blip (e.g. an old delivery retry from before a recent secret
 * rotation). 3 calls / 24h is conservative for any repo with real
 * traffic.
 *
 * Module-level state is fine here: the catchup loop in `githubCatchup`
 * uses the same single-process pattern (see #75). The deployment shape
 * is a single Fastify instance per host, so there is no cross-process
 * counter to coordinate.
 */

import { pushKumaHeartbeat } from './kumaPush.js';

/** Rolling window: only calls within this many ms back are considered. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum number of webhook calls in the window before we'll push
 * EITHER `up` or `down`. Avoids a single transient bad-signature on a
 * quiet day flipping the monitor.
 */
const MIN_THRESHOLD = 3;

interface CallRecord {
  at: number;
  ok: boolean;
}

/**
 * Module-level state — single Fastify process per host. If we ever move
 * to multi-process, this becomes a Redis HINCRBY or similar; the
 * abstraction is intentionally small so the swap is local.
 */
const calls: CallRecord[] = [];

/**
 * Drop entries older than the rolling window. Called before reads and
 * on every write; cheap because the array is bounded in practice
 * (production traffic is well below thousands of webhook calls / 24h).
 */
function prune(): void {
  const cutoff = Date.now() - WINDOW_MS;
  while (calls.length > 0 && calls[0].at < cutoff) {
    calls.shift();
  }
}

/**
 * Called by the webhook handler exactly once per inbound POST,
 * regardless of action / event type. `authenticated` reflects the final
 * signature-verified flag — true iff the request matched some
 * configured secret (App webhook secret OR a per-integration PAT
 * webhook secret).
 */
export function recordWebhookCall(authenticated: boolean): void {
  calls.push({ at: Date.now(), ok: authenticated });
  prune();
}

/**
 * Daily scheduler entry-point. Reads the 24h counter, decides the push
 * state (up / down / skip), and fires a single Kuma heartbeat. No-op
 * when the URL env var is unset, so deploying without the monitor
 * costs nothing.
 *
 * Returns `void` — the helper swallows its own fetch errors and we
 * never want a heartbeat hiccup to escape into the scheduler.
 */
export async function runWebhookAuthCheck(): Promise<void> {
  prune();
  const url = process.env.KUMA_WEBHOOK_AUTH_FAILURE_PUSH_URL;
  if (!url) return;

  const total = calls.length;
  const ok = calls.reduce((n, c) => n + (c.ok ? 1 : 0), 0);

  if (total < MIN_THRESHOLD) {
    // Too few samples to draw a conclusion. We deliberately also skip
    // the `received==0` case here — that's a different failure mode
    // (webhook URL not configured on the GH side at all) and lumping
    // it into this alarm would page operators on every fresh deploy.
    return;
  }

  if (ok === 0) {
    await pushKumaHeartbeat(
      url,
      'down',
      `webhook_auth_failed:received_${total}_authenticated_0`,
      '[webhook-auth-check] down',
    );
  } else {
    await pushKumaHeartbeat(
      url,
      'up',
      `webhook_auth_ok:received_${total}_authenticated_${ok}`,
      '[webhook-auth-check] up',
    );
  }
}

// ── Test hooks ───────────────────────────────────────────────────
// Exported with underscore prefixes to flag "internal — only call from
// tests". The vitest suite for this module needs to reset between
// cases and assert what landed in the buffer; nothing in production
// code should ever touch these.

/** Clear the rolling buffer. Test-only. */
export function _resetForTests(): void {
  calls.length = 0;
}

/** Snapshot the current buffer (defensive copy). Test-only. */
export function _getCallsForTests(): ReadonlyArray<CallRecord> {
  return [...calls];
}

/** Expose constants so tests can assert on the floor without hard-coding. */
export const _MIN_THRESHOLD_FOR_TESTS = MIN_THRESHOLD;
export const _WINDOW_MS_FOR_TESTS = WINDOW_MS;
