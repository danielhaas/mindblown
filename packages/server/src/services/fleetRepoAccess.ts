/**
 * Repo credentials for a fleet (#507). A fleet works whatever projects it
 * was picked for, with no repos or tokens configured on the machine: the
 * pull says where a ticket's code lives, and the fleet's own key fetches
 * that project's credentials here, per ticket.
 *
 * Handed out only while the project is connected to THIS fleet, isn't
 * archived and has a forge connection — unpicking ends it at the next
 * request. And only to a fleet owned by the map's creator: the token is
 * the creator's (their PAT, Gitea sign-in or GitHub App), and a map admin
 * who connects someone's map to their own fleet must not walk away with
 * it. Phase 2 (sharing) revisits this with project-scoped bot tokens.
 *
 * Credentials belong to the project, never to the fleet. An App-bound map
 * gets a fresh token for just its repo; a PAT/OAuth token can't be
 * narrowed and goes out as is, so the fleet's commits and PRs appear as
 * the token's owner — a forge bot account can replace it later.
 */
import * as fleetDb from '../db/fleets.js';
import * as handouts from '../db/fleetRepoHandouts.js';
import { getFleetRepoCredentials } from '../lib/githubContext.js';
import type { TicketRepo } from '@mindblown/tool-kit';

export type RepoAccessError = { status: number; code: string; message: string };

export interface RepoCredentials extends TicketRepo {
  token: string;
  /**
   * HTTPS user for git with the token as password. Both forges accept it:
   * GitHub takes `x-access-token` for PATs and App tokens, Gitea ignores
   * the user when the password is a token.
   */
  gitUsername: 'x-access-token';
}

export async function issueRepoCredentials(userId: string, fleetId: string, mapId: unknown): Promise<RepoCredentials | RepoAccessError> {
  if (typeof mapId !== 'string' || mapId === '') {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'mapId is required' };
  }
  // The fleet's own key only — not its owner's session, not another fleet's key.
  const own = await fleetDb.fleetOfServiceUser(userId);
  if (!own || own.id !== fleetId) {
    return { status: 403, code: 'FORBIDDEN', message: "Only this fleet's own key can fetch its repo credentials" };
  }
  const map = await fleetDb.getMapFleetState(mapId);
  if (!map || map.fleetId !== fleetId) {
    return { status: 403, code: 'NOT_CONNECTED', message: 'This project is not connected to this fleet' };
  }
  const fleet = await fleetDb.getFleet(fleetId);
  if (!fleet || fleet.ownerId !== map.createdBy) {
    return {
      status: 403,
      code: 'NOT_PROJECT_OWNER',
      message: "Repo credentials go only to a fleet owned by the project's creator — the forge token is theirs",
    };
  }
  if (map.archivedAt) {
    return { status: 409, code: 'MAP_ARCHIVED', message: 'This project is archived; the fleet skips it until it is unarchived' };
  }
  const found = await getFleetRepoCredentials(mapId);
  if (!found) {
    return { status: 404, code: 'NO_REPO', message: 'This project has no repo connected (or its forge connection is broken)' };
  }
  await handouts.recordHandout(fleetId, mapId, `${found.repo.owner}/${found.repo.name}`);
  return { ...found.repo, token: found.token, gitUsername: 'x-access-token' };
}
