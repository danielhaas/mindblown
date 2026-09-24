/**
 * Forge factory + defaults.
 */

import { GitHubForge } from './github.js';
import { GiteaForge, giteaEndpoint } from './gitea.js';
import { GITHUB_ENDPOINT } from './constants.js';
import type { ForgeClient, ForgeConnection, ForgeEndpoint, ForgeFetch, ForgeKind } from './types.js';

export * from './types.js';
export * from './constants.js';
export { GitHubForge, issueWebUrl, type GitHubForgeOptions } from './github.js';
export * from './gitea.js';
export * from './webhook.js';
export * from './pagination.js';

/** Public defaults per kind. Gitea has no public default — the operator's URL is required. */
export function forgeDefaults(kind: ForgeKind): ForgeEndpoint | null {
  return kind === 'github' ? GITHUB_ENDPOINT : null;
}

/**
 * Resolve an operator-supplied connection to a concrete endpoint, filling in
 * the kind's public defaults. Rows written before #367 have neither `kind`
 * nor URLs and resolve to github.com — that is the whole back-compat story.
 * A Gitea row needs at least its instance URL (root or `/api/v1`).
 */
export function resolveForgeEndpoint(
  conn: Pick<ForgeConnection, 'kind' | 'apiBaseUrl' | 'webBaseUrl'>,
): ForgeEndpoint {
  const kind: ForgeKind = conn.kind ?? 'github';
  if (kind === 'gitea') {
    const base = conn.apiBaseUrl || conn.webBaseUrl;
    if (!base) throw new Error('Forge kind "gitea" needs apiBaseUrl (the instance URL)');
    return giteaEndpoint(base, conn.webBaseUrl);
  }
  const defaults = forgeDefaults(kind);
  const apiBaseUrl = conn.apiBaseUrl || defaults?.apiBaseUrl;
  const webBaseUrl = conn.webBaseUrl || defaults?.webBaseUrl;
  if (!apiBaseUrl || !webBaseUrl) {
    throw new Error(`Forge kind "${kind}" needs apiBaseUrl and webBaseUrl`);
  }
  return { kind, apiBaseUrl, webBaseUrl };
}

/**
 * Build a client for a connection. The only place that knows which class
 * serves which kind.
 */
export function createForgeClient(conn: ForgeConnection, fetchImpl?: ForgeFetch): ForgeClient {
  const endpoint = resolveForgeEndpoint(conn);
  switch (endpoint.kind) {
    case 'github':
      return new GitHubForge({
        token: conn.token,
        apiBaseUrl: endpoint.apiBaseUrl,
        webBaseUrl: endpoint.webBaseUrl,
        fetchImpl,
      });
    case 'gitea':
      return new GiteaForge({
        token: conn.token,
        apiBaseUrl: endpoint.apiBaseUrl,
        webBaseUrl: endpoint.webBaseUrl,
        fetchImpl,
      });
  }
}

/** Shorthand for the GitHub App / legacy paths that always mean github.com. */
export function githubForge(token: string): ForgeClient {
  return new GitHubForge({ token });
}
