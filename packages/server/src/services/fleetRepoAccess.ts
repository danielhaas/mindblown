/**
 * Repo credentials for a fleet (#507). A fleet works whatever projects it
 * was picked for, with no repos or tokens configured on the machine: the
 * pull says where a ticket's code lives, and the fleet's own key fetches
 * that project's credentials here, per ticket.
 *
 * Handed out only while the project is connected to THIS fleet, isn't
 * archived and has a forge connection — unpicking ends it at the next
 * request. Credentials belong to the project, never to the fleet: when a
 * fleet is shared (phase 2), it still gets each project's own access only.
 *
 * Phase 1 hands out the project's existing forge token (the owner's), so
 * the fleet's commits and PRs appear as the owner; a forge bot account can
 * replace it later without changing this flow.
 */
import * as fleetDb from '../db/fleets.js';
import * as handouts from '../db/fleetRepoHandouts.js';
import { getForgeContextForMap, ticketRepo } from '../lib/githubContext.js';
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
  if (map.archivedAt) {
    return { status: 409, code: 'MAP_ARCHIVED', message: 'This project is archived; the fleet skips it until it is unarchived' };
  }
  const ctx = await getForgeContextForMap(mapId);
  if (!ctx) {
    return { status: 404, code: 'NO_REPO', message: 'This project has no repo connected (or its forge connection is broken)' };
  }
  await handouts.recordHandout(fleetId, mapId, `${ctx.owner}/${ctx.repo}`);
  return { ...ticketRepo(ctx.forge.endpoint, ctx.owner, ctx.repo), token: ctx.token, gitUsername: 'x-access-token' };
}
