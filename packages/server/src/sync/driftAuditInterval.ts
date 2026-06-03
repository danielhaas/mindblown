/**
 * Drift-audit cadence resolver (closes #72).
 *
 * The drift audit was previously hardcoded to a 24-hour interval in
 * `index.ts`, so a sync incident that started in the morning could
 * wait up to 24 hours before the operator was alarmed. We now run
 * every 6 hours by default, with an `DRIFT_AUDIT_INTERVAL_MS` env-var
 * override for operators to dial up/down.
 *
 * Lives in its own module rather than inline in `index.ts` so the
 * unit test can verify the parse/guard/fallback rules without
 * importing `index.ts` itself — `index.ts` calls `main()` at module
 * load time (binds the port, runs migrations), which is unsuitable
 * for a pure unit-test surface.
 *
 * Resolution rules:
 *
 *   1. Unset env var          → DEFAULT (6h)
 *   2. Valid integer ≥ MIN    → used as-is
 *   3. NaN / non-numeric      → DEFAULT, with console.warn
 *   4. Below MIN (incl. zero) → DEFAULT, with console.warn
 *
 * The min-interval guard is a sanity floor: an env-var typo like
 * `DRIFT_AUDIT_INTERVAL_MS=0` would otherwise turn `setInterval` into
 * a busy-loop hammering the GitHub API across every opted-in map.
 * 1 hour is well below the operational target (6 h) but high enough
 * that even a 100-map deployment stays under GitHub's rate limit
 * comfortably.
 */

export const DEFAULT_DRIFT_AUDIT_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MIN_DRIFT_AUDIT_INTERVAL_MS = 60 * 60 * 1000;

export function resolveDriftAuditIntervalMs(
  raw: string | undefined,
): number {
  if (raw === undefined) return DEFAULT_DRIFT_AUDIT_INTERVAL_MS;
  const parsed = parseInt(raw, 10);
  if (
    Number.isFinite(parsed) &&
    parsed >= MIN_DRIFT_AUDIT_INTERVAL_MS
  ) {
    return parsed;
  }
  console.warn(
    `[drift-audit] DRIFT_AUDIT_INTERVAL_MS=${raw} invalid (must be an ` +
      `integer ≥ ${MIN_DRIFT_AUDIT_INTERVAL_MS} ms), falling back to ` +
      `${DEFAULT_DRIFT_AUDIT_INTERVAL_MS} ms`,
  );
  return DEFAULT_DRIFT_AUDIT_INTERVAL_MS;
}
