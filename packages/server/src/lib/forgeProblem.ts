/**
 * Does the map reach the repo it names? (#513)
 *
 * A map names its repo (`github_repo_owner/name`); a GitHub App install
 * or a workspace connection row binds it. When the row is gone or points
 * elsewhere the map just looks unconnected, and ingest, catch-up,
 * webhooks, triage and the fleet all stop without a word — crm2 took
 * Sonarpipe's row on 19.10.2026 and nobody noticed for 16 h. The same
 * silence follows a binding whose token the forge refuses.
 *
 * Unbound is decided by `getForgeBindingForMap`, the lookup behind the
 * fleet's `getForgeRepoForMap`, so this says "unbound" exactly when a
 * worker gets `repo: null`. Refused is read under the same binding key
 * catch-up records failures with (sync/forgeRefusals.ts).
 * No token is minted and no network call made: cheap enough for every
 * map load.
 */
import { forgeLabel, type ForgeProblem } from '@mindblown/core';
import { getForgeBindingForMap } from './githubContext.js';
import { forgeRefusalFor } from '../sync/forgeRefusals.js';

export async function forgeProblemForMap(map: {
  id: string;
  githubRepoOwner?: string | null;
  githubRepoName?: string | null;
}): Promise<ForgeProblem | null> {
  if (!map.githubRepoOwner || !map.githubRepoName) return null;
  const named = `${map.githubRepoOwner}/${map.githubRepoName}`;
  const binding = await getForgeBindingForMap(map.id);
  if (!binding) {
    return {
      kind: 'unbound',
      repo: named,
      message: `Map names ${named}, but no forge connection binds it — sync, triage and the fleet are off for this map.`,
    };
  }
  const refusal = forgeRefusalFor(binding.bindingKey);
  if (refusal) {
    const forge = forgeLabel(binding.repo.forge);
    const since = `HTTP ${refusal.status} since ${refusal.since.slice(0, 16).replace('T', ' ')} UTC`;
    const what =
      refusal.status === 404
        ? `${forge} cannot find ${named} with this connection (${since}: the repo was renamed or deleted, or the token lost access)`
        : `${forge} refuses the token for ${named} (${since})`;
    return {
      kind: 'refused',
      repo: named,
      message: `${what} — sync, triage and the fleet are failing for this map. Reconnect the repo.`,
    };
  }
  return null;
}
