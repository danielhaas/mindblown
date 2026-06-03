/**
 * Shared helper for parsing positive-integer millisecond intervals from
 * env vars.
 *
 * Problem this exists for: `parseInt('1d', 10)` returns `1` (parseInt
 * stops at the first non-digit, NOT NaN as you'd expect), and
 * `parseInt('abc', 10)` returns `NaN`. Both feed `setInterval` something
 * catastrophic — `setInterval(fn, 1)` fires every 1 ms, `setInterval(fn,
 * NaN)` is treated as `setInterval(fn, 0)` and fires every event-loop
 * tick. An operator who types `CANARY_INTERVAL_MS=1d` instead of a real
 * millisecond count would accidentally DDOS Kuma + Pushover at sub-ms
 * cadence.
 *
 * This helper guards against:
 *   - Missing env var          → returns `defaultMs`
 *   - Non-numeric / NaN parse  → returns `defaultMs`, with `console.warn`
 *   - Trailing garbage (`1d`)  → returns `defaultMs`, with `console.warn`
 *   - Zero or negative integer → returns `defaultMs`, with `console.warn`
 *   - Integer below `minMs`    → returns `defaultMs`, with `console.warn`
 *
 * `minMs` is optional and defaults to `0` (no floor). Use it when an
 * interval has a hard operational floor (e.g. the drift-audit cadence's
 * 1h floor — see `driftAuditInterval.ts`, which has its own bespoke
 * resolver for the same reason this helper exists).
 *
 * Returns `defaultMs` (not the typo'd value) so that even a misconfigured
 * deployment ends up running on its intended cadence — visible only in
 * the warn log, not as a functional outage.
 */
export function parsePositiveIntMs(
  envValue: string | undefined,
  defaultMs: number,
  minMs = 0,
): number {
  if (!envValue) return defaultMs;
  // Strict: the env string must be ONLY digits (with optional leading
  // sign, but no trailing units). `parseInt('1d', 10)` is `1` — that's
  // a sub-millisecond cadence, not "1 day", so we treat it as a typo.
  // Use a regex match before parseInt to reject anything that isn't a
  // pure integer literal.
  if (!/^-?\d+$/.test(envValue.trim())) {
    console.warn(
      `[interval] ${envValue} invalid (must be a positive integer${minMs > 0 ? ` ≥ ${minMs}` : ''} ms), falling back to ${defaultMs}`,
    );
    return defaultMs;
  }
  const parsed = parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed < minMs) {
    console.warn(
      `[interval] ${envValue} invalid (must be a positive integer${minMs > 0 ? ` ≥ ${minMs}` : ''} ms), falling back to ${defaultMs}`,
    );
    return defaultMs;
  }
  return parsed;
}
