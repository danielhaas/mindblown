/**
 * Heartbeat push helper. Supports both legacy Uptime-Kuma push monitors
 * AND the newer Gatus external-endpoint API.
 *
 * URL shape detection (zero config flag needed):
 *   - `/api/v1/endpoints/<key>/external` → Gatus. POST with
 *      Authorization: Bearer ${process.env.GATUS_PUSH_TOKEN}.
 *      Query params: success=true|false, duration=10ms[, error=<msg>].
 *   - `/api/push/<token>` → Kuma. GET with status=up|down&msg=<msg>&ping=...
 *      Token is embedded in the path; no bearer header.
 *
 * Failed pushes are logged at `warn` and swallowed — the caller's main
 * flow MUST NOT fail because a heartbeat couldn't be delivered.
 *
 * Migration: as of 2026-06-12 the production senders point at Gatus URLs
 * (Kuma's Pushover provider was disabled). The Kuma branch is kept so
 * the helper still works in environments still on Kuma (e.g. legacy
 * dev configs, CI fixtures) without a config flag flip.
 *
 * The function name `pushKumaHeartbeat` is preserved for callers'
 * minimal-diff compatibility — the helper does both Kuma and Gatus now.
 */

/** Maximum time we wait for the heartbeat receiver to acknowledge a push. */
const HEARTBEAT_PUSH_TIMEOUT_MS = 5000;

export type KumaStatus = 'up' | 'down';

/**
 * Per-`logTag` memo of the last failure signature we already warned
 * about. Used to collapse repeating identical failures (e.g. 404 every
 * 5 minutes because the operator deleted the monitor) into a single warn
 * line + a single recovery warn line when the failure clears.
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

/** Detect Gatus external endpoint URL by path shape. */
function isGatusUrl(url: string): boolean {
  return url.includes('/api/v1/endpoints/');
}

interface PreparedRequest {
  url: string;
  init: RequestInit;
}

/**
 * Build the fetch URL + init for the heartbeat receiver based on URL shape.
 */
function prepareRequest(
  rawUrl: string,
  status: KumaStatus,
  msg: string,
): PreparedRequest {
  const sep = rawUrl.includes('?') ? '&' : '?';

  if (isGatusUrl(rawUrl)) {
    const success = status === 'up';
    const parts = [`success=${success}`, `duration=10ms`];
    if (!success && msg) parts.push(`error=${encodeURIComponent(msg)}`);
    const url = `${rawUrl}${sep}${parts.join('&')}`;
    const token = process.env.GATUS_PUSH_TOKEN ?? '';
    return {
      url,
      init: {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(HEARTBEAT_PUSH_TIMEOUT_MS),
      },
    };
  }

  // Legacy Kuma push monitor. GET with status/msg in query, plus a ping
  // marker so each push is unique even with proxies that dedupe GETs.
  const url = `${rawUrl}${sep}status=${encodeURIComponent(
    status,
  )}&msg=${encodeURIComponent(msg)}&ping=${Date.now()}`;
  return {
    url,
    init: {
      method: 'GET',
      signal: AbortSignal.timeout(HEARTBEAT_PUSH_TIMEOUT_MS),
    },
  };
}

/**
 * Push a heartbeat to either a Kuma push-monitor or a Gatus external
 * endpoint. Errors (timeout, non-2xx, network) are swallowed — the
 * caller's main flow never fails because of a heartbeat hiccup.
 *
 * Logging policy: warn the FIRST time a given failure signature is seen
 * for a given `logTag`, then stay silent on every subsequent identical
 * tick. When the signature changes (recovery to 2xx, or a new error
 * kind), log once more. This keeps a misconfigured monitor from spamming
 * the journal every 5 minutes while still surfacing real incidents.
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
  // regression can't accidentally fire a malformed request against `?…`.
  if (!url) return;

  const { url: fullUrl, init } = prepareRequest(url, status, msg);

  let signature: string;
  let logLine: string | null = null;

  try {
    const res = await fetch(fullUrl, init);
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
