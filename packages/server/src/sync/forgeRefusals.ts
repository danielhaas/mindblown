/**
 * Bindings whose forge refused catch-up's last fetch (#513): a 401, a 403
 * that is not a rate limit, or a 404 (a still-valid token that lost access
 * to a private repo, or a repo renamed/deleted). Cleared by the next
 * successful fetch. In memory like the 401 counter in githubCatchup.ts —
 * after a restart the first tick fills it again.
 *
 * Keyed by binding, not by repo: the credential is what fails. A row's key
 * carries its updatedAt, which every connect/bind bumps, so reconnecting
 * with a fresh token retires the old refusal at once instead of after the
 * next tick.
 *
 * Read by lib/forgeProblem.ts, so a map whose token went bad says so in
 * Plan health, the forge settings and the Fleet tab instead of only in
 * the log.
 */
// GitHubApiError is ForgeApiError under its historical name (Gitea too) —
// the name catch-up and its test mocks already use.
import { GitHubApiError } from '@mindblown/integrations';

export interface ForgeRefusal {
  status: number;
  /** First refusal of the current streak (ISO). */
  since: string;
}

const refusals = new Map<string, ForgeRefusal>();

export function appBindingKey(installationId: string): string {
  return `app:${installationId}`;
}

export function rowBindingKey(row: { id: string; updatedAt?: Date | null }): string {
  return `row:${row.id}:${row.updatedAt?.getTime?.() ?? 0}`;
}

/** The HTTP status when `err` is the forge refusing this binding, else null. */
export function refusalStatus(err: unknown): number | null {
  if (!(err instanceof GitHubApiError)) return null;
  if (err.status === 401 || err.status === 404) return err.status;
  // GitHub answers a rate limit with 403 too; that is not a bad token.
  if (err.status === 403 && !/rate limit/i.test(err.body)) return 403;
  return null;
}

export function noteForgeRefusal(bindingKey: string, status: number, at: Date = new Date()): void {
  const prev = refusals.get(bindingKey);
  refusals.set(bindingKey, { status, since: prev?.since ?? at.toISOString() });
}

export function clearForgeRefusal(bindingKey: string): void {
  refusals.delete(bindingKey);
}

export function forgeRefusalFor(bindingKey: string): ForgeRefusal | null {
  return refusals.get(bindingKey) ?? null;
}

/** Test seam. */
export function resetForgeRefusals(): void {
  refusals.clear();
}
