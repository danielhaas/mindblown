/**
 * Repos whose forge refuses the binding's token (#513), as catch-up last
 * saw them: a 401, or a 403 that is not a rate limit. Cleared by the next
 * successful fetch. In memory like the 401 counter in githubCatchup.ts —
 * after a restart the first tick fills it again.
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

// GitHub full names are case-insensitive; a binding may be user-typed.
const key = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase();

/** The HTTP status when `err` is the forge refusing the credential, else null. */
export function refusalStatus(err: unknown): number | null {
  if (!(err instanceof GitHubApiError)) return null;
  if (err.status === 401) return 401;
  // GitHub answers a rate limit with 403 too; that is not a bad token.
  if (err.status === 403 && !/rate limit/i.test(err.body)) return 403;
  return null;
}

export function noteForgeRefusal(owner: string, repo: string, status: number, at: Date = new Date()): void {
  const k = key(owner, repo);
  const prev = refusals.get(k);
  refusals.set(k, { status, since: prev?.since ?? at.toISOString() });
}

export function clearForgeRefusal(owner: string, repo: string): void {
  refusals.delete(key(owner, repo));
}

export function forgeRefusalFor(owner: string, repo: string): ForgeRefusal | null {
  return refusals.get(key(owner, repo)) ?? null;
}

/** Test seam. */
export function resetForgeRefusals(): void {
  refusals.clear();
}
