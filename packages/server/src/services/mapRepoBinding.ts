/**
 * Who may point a map at a GitHub repo through the App (PUT /api/maps/:id).
 * The binding decides whose repo the map syncs and imports with the App's
 * token, so it takes map admin AND a repo the caller can reach on GitHub in
 * that installation, asked of GitHub with the caller's own token. A repo
 * without an installation goes through /api/integrations/github/connect,
 * which brings its own token.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { maps } from '../db/schema.js';
import * as permDb from '../db/permissions.js';
import { userInstallationRepos } from '../lib/githubInstallations.js';
import { isFleetUser } from '../db/fleets.js';

const FIELDS = ['githubInstallationId', 'githubRepoOwner', 'githubRepoName'] as const;
type BindingInput = { [K in (typeof FIELDS)[number]]?: string | null };

export interface RepoBindingError {
  status: number;
  code: string;
  message: string;
}

export async function authorizeMapRepoBinding(
  userId: string,
  mapId: string,
  input: BindingInput,
): Promise<RepoBindingError | null> {
  if (!FIELDS.some((f) => input[f] !== undefined)) return null;
  const [current] = await db
    .select({
      githubInstallationId: maps.githubInstallationId,
      githubRepoOwner: maps.githubRepoOwner,
      githubRepoName: maps.githubRepoName,
    })
    .from(maps)
    .where(eq(maps.id, mapId))
    .limit(1);
  if (!current) return null; // the update itself answers 404
  // A form that resends the binding it shows is not a change.
  if (!FIELDS.some((f) => input[f] !== undefined && (input[f] ?? null) !== (current[f] ?? null))) return null;

  const perm = await permDb.getPermission(mapId, userId);
  if (!permDb.hasPermission(perm, 'admin')) {
    return { status: 403, code: 'FORBIDDEN', message: "Only map admins can change the map's GitHub repository" };
  }
  const next = {
    installationId: input.githubInstallationId !== undefined ? input.githubInstallationId : current.githubInstallationId,
    owner: input.githubRepoOwner !== undefined ? input.githubRepoOwner : current.githubRepoOwner,
    name: input.githubRepoName !== undefined ? input.githubRepoName : current.githubRepoName,
  };
  if (!next.installationId) {
    // Disconnecting clears the repo too; a repo with no installation would
    // sync through whichever stored token matches it, not the caller's.
    if (next.owner || next.name) {
      return { status: 400, code: 'VALIDATION_ERROR', message: 'Pick the repo through the GitHub App, or connect it with a token' };
    }
    return null;
  }
  const access = await userInstallationRepos(userId, next.installationId);
  if ('status' in access) return access;
  const wanted = `${next.owner ?? ''}/${next.name ?? ''}`.toLowerCase();
  if (!access.repos.some((r) => r.full_name.toLowerCase() === wanted)) {
    return { status: 403, code: 'FORBIDDEN', message: `You have no access to ${next.owner}/${next.name} through that GitHub App installation` };
  }
  return null;
}

/**
 * `fleetCanEditCi` lets fleet code change the repo's CI, which can read its
 * secrets. Turning it on is the map creator's call alone: the fleet's token
 * comes from the creator's GitHub App installation and goes only to the
 * creator's fleet, so another admin must not open the creator's secrets to
 * it. Never a fleet key's: agent code must not open CI to itself. Any map
 * admin may turn it off; an editor may resend "off" (a settings form).
 * `true` is checked every time, so a stale resend can't undo a switch-off.
 */
export async function authorizeFleetCiChange(
  userId: string,
  mapId: string,
  input: { fleetCanEditCi?: unknown },
): Promise<RepoBindingError | null> {
  if (input.fleetCanEditCi === undefined) return null;
  if (typeof input.fleetCanEditCi !== 'boolean') {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'fleetCanEditCi must be true or false' };
  }
  if (input.fleetCanEditCi === false) {
    const [current] = await db.select({ fleetCanEditCi: maps.fleetCanEditCi }).from(maps).where(eq(maps.id, mapId)).limit(1);
    if (!current || !current.fleetCanEditCi) return null;
  }
  if (await isFleetUser(userId)) {
    return { status: 403, code: 'FORBIDDEN', message: 'A fleet key cannot change whether the fleet may edit CI workflows' };
  }
  if (input.fleetCanEditCi) {
    const [map] = await db.select({ createdBy: maps.createdBy }).from(maps).where(eq(maps.id, mapId)).limit(1);
    if (!map) return null; // the update itself answers 404
    if (map.createdBy !== userId) {
      return { status: 403, code: 'FORBIDDEN', message: "Only the map's creator can let the fleet change CI workflows — the fleet uses their GitHub access" };
    }
    return null;
  }
  const perm = await permDb.getPermission(mapId, userId);
  if (!permDb.hasPermission(perm, 'admin')) {
    return { status: 403, code: 'FORBIDDEN', message: 'Only map admins can change whether the fleet may edit CI workflows' };
  }
  return null;
}
