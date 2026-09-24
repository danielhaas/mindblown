/**
 * Server-side glue between DB rows and `ForgeClient` instances (#367).
 *
 * Two kinds of binding exist:
 *   - a GitHub App installation on the map (`maps.github_installation_id`)
 *     → always github.com, token minted per call;
 *   - a PAT row in `integrations` → `provider` is the forge kind
 *     (`github` | `gitea`), `config` carries owner/repo/token and, for a
 *     self-hosted forge, `apiBaseUrl` / `webBaseUrl`.
 *
 * Kept separate from `lib/githubContext.ts` so tests that mock that module
 * by path (nine of them) don't have to know about these helpers.
 */

import {
  createForgeClient,
  githubForge,
  isForgeKind,
  mintInstallationToken,
  type ForgeClient,
  type ForgeKind,
} from '@mindblown/integrations';

/**
 * Shape of `integrations.config` for a PAT-backed forge row. `apiBaseUrl`
 * and `webBaseUrl` are optional: rows written before #367 have neither
 * and mean github.com.
 */
export interface ForgeIntegrationConfig {
  owner: string;
  repo: string;
  token: string;
  webhookSecret?: string;
  apiBaseUrl?: string | null;
  webBaseUrl?: string | null;
}

/**
 * `provider` values that denote a forge. Querying with this list instead of
 * `'github'` keeps every existing row selected and lets a `gitea` row join
 * without touching the callers again. A literal (not `FORGE_KINDS` from
 * the integrations package) so it is safe under test mocks of that module;
 * the `satisfies` keeps it honest against the kind union.
 */
export const FORGE_PROVIDERS: string[] = ['github', 'gitea'] satisfies ForgeKind[];

/** Build a client for a PAT integration row. */
export function forgeFromIntegration(row: { provider: string; config: unknown }): ForgeClient {
  const cfg = row.config as ForgeIntegrationConfig;
  return createForgeClient({
    kind: isForgeKind(row.provider) ? row.provider : 'github',
    apiBaseUrl: cfg.apiBaseUrl,
    webBaseUrl: cfg.webBaseUrl,
    token: cfg.token,
  });
}

/** Build a github.com client from a freshly minted App installation token. */
export async function forgeFromInstallation(installationId: string): Promise<ForgeClient> {
  const token = await mintInstallationToken(installationId);
  return githubForge(token);
}
