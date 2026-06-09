/**
 * Uptime-Kuma push-monitor helper.
 *
 * Kuma "push" monitors are passive endpoints: you GET/POST a per-monitor
 * URL like `https://kuma.example/api/push/<token>?status=up&msg=...` and
 * Kuma alarms (Pushover, Telegram, email, ...) when those pushes stop
 * for longer than the monitor's configured threshold.
 *
 * This module wraps the GET so callers can do
 *   `await pushKumaHeartbeat(url, status, msg)`
 * without worrying about timeouts or Kuma being temporarily unreachable.
 * Failed pushes are logged at `warn` and swallowed — the caller's main
 * flow MUST NOT fail because a heartbeat couldn't be delivered.
 *
 * The pattern mirrors the CRM infra's existing Kuma push usage (see
 * `reference_kuma_state.md`): catchup heartbeat + daily drift audit each
 * own a distinct monitor URL set via env vars.
 */

/** Maximum time we wait for Kuma to acknowledge a push. */
const KUMA_PUSH_TIMEOUT_MS = 5000;

export type KumaStatus = 'up' | 'down';

/**
 * Per-`logTag` memo of the last failure signature we already warned
 * about. Used to collapse repeating identical failures (e.g. Kuma
 * returning `404` every 5 minutes because the operator deleted the
 * monitor on Kuma's side) into a single warn line + a single recovery
 * warn line when the failure clears.
 *
 * Keyed by `logTag` (which is unique per call site, e.g. catchup vs
 * drift audit vs auth failure), so concurrent monitors don't suppress
 * each other.
 *
 * Failure signatures:
 *   - `http:<status>` for non-2xx responses
 *   - `err:<message>` for thrown fetch/timeout errors
 *   - `ok`            for the recovery transition
 */
const lastFailureByTag = new Map<string, string | null>();

/**
 * Reset the suppression memo. Production never calls this; the tests
 * use it to start each case from a clean slate.
 */
export function _resetKumaSuppressionForTests(): void {
  lastFailureByTag.clear();
}

/**
 * GET the Kuma push URL with status + msg query params. Errors (timeout,
 * non-2xx, network) are swallowed — the caller's main flow never fails
 * because of a heartbeat hiccup.
 *
 * Logging policy: warn the FIRST time a given failure signature is seen
 * for a given `logTag`, then stay silent on every subsequent identical
 * tick. When the signature changes (recovery to 2xx, or a new error
 * kind), log once more. This keeps a misconfigured Kuma monitor from
 * spamming the journal every 5 minutes while still surfacing real
 * incidents.
 *
 * `logTag` is the prefix used in the warn log so multiple call sites are
 * easy to distinguish ("[kuma-push] catchup heartbeat" vs
 * "[kuma-push] drift audit").
 */
export async function pushKumaHeartbeat(
  url: string | undefined,
  status: KumaStatus,
  msg: string,
  logTag: string,
): Promise<void> {
  // Defence-in-depth: callers already guard `if (url)` before invoking
  // us, but treat a falsy URL as a hard no-op here too so a config
  // regression can't accidentally fire a malformed GET against `?…`.
  if (!url) return;

  // Append status/msg/ping as query params. We deliberately don't try to
  // be clever about an existing `?` — Kuma push URLs are vanilla, and the
  // ping marker is included so each push is unique even with proxies that
  // dedupe identical GETs.
  const sep = url.includes('?') ? '&' : '?';
  const fullUrl = `${url}${sep}status=${encodeURIComponent(status)}&msg=${encodeURIComponent(msg)}&ping=${Date.now()}`;

  let signature: string;
  let logLine: string | null = null;

  try {
    const res = await fetch(fullUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(KUMA_PUSH_TIMEOUT_MS),
    });
    if (!res.ok) {
      signature = `http:${res.status}`;
      logLine = `${logTag} HTTP ${res.status}`;
    } else {
      signature = 'ok';
    }
  } catch (err) {
    const msgStr = err instanceof Error ? err.message : String(err);
    signature = `err:${msgStr}`;
    logLine = `${logTag} failed: ${msgStr}`;
  }

  const prev = lastFailureByTag.get(logTag) ?? null;
  if (signature === 'ok') {
    // Recovery: warn once if we were previously in a failure state, then
    // clear so the next failure (if any) logs immediately.
    if (prev && prev !== 'ok') {
      console.warn(`${logTag} recovered (was ${prev})`);
    }
    lastFailureByTag.set(logTag, 'ok');
    return;
  }

  // Failure path. Log only when the signature changed (first occurrence
  // or transition to a different failure mode).
  if (signature !== prev) {
    console.warn(logLine);
    lastFailureByTag.set(logTag, signature);
  }
}
