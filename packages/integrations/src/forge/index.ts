/**
 * Forge factory + defaults.
 */

import { GitHubForge, GITHUB_ENDPOINT } from './github.js';
import type { ForgeClient, ForgeConnection, ForgeEndpoint, ForgeFetch, ForgeKind } from './types.js';

export * from './types.js';
export * from './github.js';
export * from './webhook.js';

/** Public defaults per kind. Gitea has no public default — the operator's URL is required. */
export function forgeDefaults(kind: ForgeKind): ForgeEndpoint | null {
  return kind === 'github' ? GITHUB_ENDPOINT : null;
}

/**
 * Resolve an operator-supplied connection to a concrete endpoint, filling in
 * the kind's public defaults. Rows written before #367 have neither `kind`
 * nor URLs and resolve to github.com — that is the whole back-compat story.
 */
export function resolveForgeEndpoint(
  conn: Pick<ForgeConnection, 'kind' | 'apiBaseUrl' | 'webBaseUrl'>,
): ForgeEndpoint {
  const kind: ForgeKind = conn.kind ?? 'github';
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
      // #368 lands GiteaForge here.
      throw new Error('Forge kind "gitea" is not supported yet (see #368)');
  }
}

/** Shorthand for the GitHub App / legacy paths that always mean github.com. */
export function githubForge(token: string): ForgeClient {
  return new GitHubForge({ token });
}
