/**
 * Who may point a map at a GitHub App installation (PUT /api/maps/:id).
 * The binding decides whose repo the map syncs and imports with the App's
 * token, so it takes map admin AND an installation recorded for the caller
 * — rows that only the install callback writes, after the user's own
 * GitHub token listed it.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { maps } from '../db/schema.js';
import * as permDb from '../db/permissions.js';
import { userHasGithubInstallation } from '../lib/githubInstallations.js';

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
  const installationId = input.githubInstallationId !== undefined ? input.githubInstallationId : current.githubInstallationId;
  if (installationId && !(await userHasGithubInstallation(userId, installationId))) {
    return { status: 403, code: 'FORBIDDEN', message: 'That GitHub App installation is not connected to your account' };
  }
  return null;
}
