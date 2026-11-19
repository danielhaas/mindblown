/**
 * Wrong-map guard (server side of core misfiled.ts): which repo each map
 * the reporter can see plans, and whether a node names another map's repo.
 * Used by create_node (REST, chat tool-kit), ticket intake and the
 * misfiled-repo lint rule.
 */
import { findMisfiledRepo, namedRepos, MISFILED_TAG, type MapRepoCandidate, type MisfiledRepo, type Node as CoreNode, type RepoBinding } from '@mindblown/core';
import * as mapDb from '../db/maps.js';
import { getForgeRepoForMap } from '../lib/githubContext.js';

async function repoOf(mapId: string): Promise<RepoBinding | null> {
  const repo = await getForgeRepoForMap(mapId).catch(() => null);
  return repo ? { owner: repo.owner, name: repo.name } : null;
}

/** The map's own repo and the other live maps the user can see, with theirs. */
export async function loadRepoContext(
  mapId: string,
  userId: string | null | undefined,
): Promise<{ ownRepo: RepoBinding | null; maps: MapRepoCandidate[] }> {
  const ownRepo = await repoOf(mapId);
  if (!ownRepo || !userId) return { ownRepo, maps: [] };
  const visible = (await mapDb.listMapsForUser(userId)).filter((m) => m.id !== mapId && !m.archivedAt);
  const maps = await Promise.all(visible.map(async (m) => ({ id: m.id, name: m.name, repo: await repoOf(m.id) })));
  return { ownRepo, maps };
}

/**
 * Whether a node about to be (or just) created in `mapId` names the repo
 * another map plans. Cheap when the node names no repo: no lookups.
 */
export async function detectMisfiled(
  node: { text: string; description?: unknown },
  mapId: string,
  userId: string | null | undefined,
): Promise<MisfiledRepo | null> {
  if (namedRepos(node).length === 0) return null;
  const ctx = await loadRepoContext(mapId, userId);
  return findMisfiledRepo(node, ctx.ownRepo, ctx.maps);
}

/** Tags with the dispatch hold added (the fleet skips the ticket until it moves or a person confirms). */
export function withMisfiledHold(tags: string[] | undefined): string[] {
  const list = tags ?? [];
  return list.some((t) => t.toLowerCase() === MISFILED_TAG) ? list : [...list, MISFILED_TAG];
}

/** misfiled-repo lint input: open leaves of the map that name another map's repo. */
export async function misfiledForMap(
  mapId: string,
  nodes: CoreNode[],
  userId: string | null | undefined,
): Promise<Map<string, MisfiledRepo> | undefined> {
  const named = nodes.filter((n) => n.parentId !== null && n.childrenIds.length === 0 && namedRepos(n).length > 0);
  const ctx = await loadRepoContext(mapId, userId);
  if (!ctx.ownRepo) return undefined;
  const out = new Map<string, MisfiledRepo>();
  for (const n of named) {
    const hit = findMisfiledRepo(n, ctx.ownRepo, ctx.maps);
    if (hit) out.set(n.id, hit);
  }
  return out;
}
