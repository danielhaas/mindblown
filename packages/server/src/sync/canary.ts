/**
 * Weekly synthetic Pushover-canary.
 *
 * The catchup-heartbeat → Kuma → Pushover chain is normally only
 * exercised during a real outage. If Pushover credentials silently
 * expire, or a Kuma monitor loses its notification link, we'd only
 * find out during an actual incident.
 *
 * This canary fires a `status=down&msg=synthetic-test` push to a
 * dedicated Kuma monitor (`mindblown-alarm-canary`) once a week, waits
 * a short while, then fires a `status=up&msg=synthetic-test-ack` to
 * recover the monitor. If the down push trips the alarm chain, the
 * operator gets a Pushover. If the chain is broken, the canary stops
 * arriving and Kuma's "missing push" threshold alarms instead — either
 * way the breakage surfaces within a week instead of during the next
 * real incident.
 *
 * Wiring:
 *   - `KUMA_ALARM_CANARY_PUSH_URL` — required; unset = scheduler no-op.
 *   - The Kuma monitor should be configured with a short "down"
 *     threshold (e.g. 90 s) so the synthetic down trips a notification
 *     before the ack push lands ~60 s later.
 *   - The Kuma monitor's notification link CAN target a dedicated
 *     Pushover device so the canary doesn't spam the main channel;
 *     that's a Kuma-side configuration, not a server-side one. See
 *     `deploy/README.md` for the operator runbook.
 *
 * Both pushes are best-effort: each is wrapped in its own try/catch and
 * the ack push fires even if the down push threw. The helper
 * (`pushKumaHeartbeat`) already swallows its own fetch errors, so the
 * try/catch here is defence-in-depth against an unexpected synchronous
 * throw (e.g. a bug in the helper itself).
 */

import { pushKumaHeartbeat } from './kumaPush.js';

/**
 * Delay between the synthetic `status=down` push and the `status=up`
 * ack. Long enough for Kuma to register the down state and fire its
 * notification, short enough that the monitor recovers within the
 * operator's normal triage latency. Exported so tests can override.
 */
export const CANARY_ACK_DELAY_MS = 60 * 1000;

/**
 * Fire a synthetic `status=down` then `status=up` push to the canary
 * Kuma monitor. No-op when the URL env var is unset. The ack push
 * fires even if the down push throws — we never want to leave the
 * monitor stuck in `down` state because of a transient error during
 * the first push.
 */
export async function runCanary(
  url: string | undefined = process.env.KUMA_ALARM_CANARY_PUSH_URL,
  ackDelayMs: number = CANARY_ACK_DELAY_MS,
): Promise<void> {
  if (!url) return;

  try {
    await pushKumaHeartbeat(url, 'down', 'synthetic-test', '[canary] down');
  } catch (err) {
    // `pushKumaHeartbeat` swallows its own fetch errors, so reaching
    // this branch implies an unexpected synchronous throw. Log and
    // continue — the ack push MUST still fire so the monitor recovers.
    console.warn(
      '[canary] down push threw unexpectedly:',
      err instanceof Error ? err.message : err,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, ackDelayMs));

  try {
    await pushKumaHeartbeat(url, 'up', 'synthetic-test-ack', '[canary] ack');
  } catch (err) {
    console.warn(
      '[canary] ack push threw unexpectedly:',
      err instanceof Error ? err.message : err,
    );
  }
}
