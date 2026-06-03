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
 * GET the Kuma push URL with status + msg query params. Errors (timeout,
 * non-2xx, network) are logged and swallowed — the caller's main flow
 * never fails because of a heartbeat hiccup.
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

  try {
    const res = await fetch(fullUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(KUMA_PUSH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`${logTag} HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`${logTag} failed:`, err instanceof Error ? err.message : err);
  }
}
