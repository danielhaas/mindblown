/**
 * move_node_to_map: re-home a ticket (or a subtree) filed in the wrong map
 * (wrong-map guard). Before this a person recreated each node by hand in
 * the right map, copied description, priority and estimate, and deleted
 * the original (19.11.2026).
 *
 * The node keeps its id, so text, description, priority, estimate,
 * progress, tags, reporter, approval, comments and attachments all go
 * with it. What is per map does not:
 *  - versions, sprints and phase are cleared;
 *  - an issue link stays only when it points at the target map's repo,
 *    else it is dropped with a note;
 *  - a dependency across the two maps is dropped, with a note on both ends;
 *  - a claim is released — refused while an agent runs on it.
 * The source map no longer has the node (not in its Trash: it lives on in
 * the target map); both change logs say "moved from / to".
 */
import { isForgeLink, MISFILED_TAG, parseRepoRef, ticketPhases, type Node as CoreNode, type ExternalLink, type RepoBinding } from '@mindblown/core';
import * as nodeDb from '../db/nodes.js';
import * as mapDb from '../db/maps.js';
import * as events from '../db/events.js';
import * as commentDb from '../db/comments.js';
import * as fleetDb from '../db/fleet.js';
import * as fleetEntityDb from '../db/fleets.js';
import { getForgeRepoForMap } from '../lib/githubContext.js';
import { checkMapAccess } from '../lib/mapAccess.js';
import { broadcast } from '../ws.js';

export class MoveToMapError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MoveToMapError';
  }
}

export interface MoveToMapResult {
  node: CoreNode;
  movedIds: string[];
  fromMapId: string;
  toMapId: string;
  toMapName: string;
  /** What did not come along: dropped issue links and dependencies, a released claim. */
  notes: string[];
}

/** The repo an issue link points at: `owner/repo#42`, else its URL. */
export function linkRepo(link: Pick<ExternalLink, 'externalId' | 'url'>): RepoBinding | null {
  const m = /^([^/\s#]+)\/([^/\s#]+)#\d+$/.exec(link.externalId ?? '');
  if (m) return { owner: m[1], name: m[2] };
  const ref = link.url ? parseRepoRef(link.url) : null;
  return ref && ref.owner ? { owner: ref.owner, name: ref.name } : null;
}

const sameRepo = (a: RepoBinding | null, b: RepoBinding | null): boolean =>
  !!a && !!b && a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

function subtreeOf(root: CoreNode, byId: Map<string, CoreNode>): CoreNode[] {
  const out: CoreNode[] = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.shift()!;
    out.push(n);
    for (const id of n.childrenIds) {
      const c = byId.get(id);
      if (c) stack.push(c);
    }
  }
  return out;
}

export async function moveNodeToMap(input: {
  nodeId: string;
  fromMapId: string;
  toMapId: string;
  parentId?: string | null;
  userId: string | null;
}): Promise<MoveToMapResult> {
  const { nodeId, fromMapId, toMapId, userId } = input;
  if (fromMapId === toMapId) throw new MoveToMapError(400, 'SAME_MAP', 'The node is already in that map — use move_node to change its parent');
  for (const mapId of [fromMapId, toMapId]) {
    const denied = await checkMapAccess(userId ?? undefined, mapId, 'edit');
    if (denied) {
      throw new MoveToMapError(denied.status, denied.code, `Moving a node needs edit on both maps — you cannot edit map ${mapId}`);
    }
  }

  const [source, target] = await Promise.all([mapDb.getMap(fromMapId), mapDb.getMap(toMapId)]);
  if (!source) throw new MoveToMapError(404, 'MAP_NOT_FOUND', `Map ${fromMapId} not found`);
  if (!target) throw new MoveToMapError(404, 'MAP_NOT_FOUND', `Map ${toMapId} not found`);
  if (source.map.workspaceId !== target.map.workspaceId) {
    throw new MoveToMapError(400, 'OTHER_WORKSPACE', 'Nodes move only between maps of the same workspace');
  }

  const byId = new Map(source.nodes.map((n) => [n.id, n]));
  const root = byId.get(nodeId);
  if (!root) throw new MoveToMapError(404, 'NODE_NOT_FOUND', `Node ${nodeId} not found on map ${fromMapId}`);
  if (root.parentId === null) throw new MoveToMapError(400, 'ROOT_NODE', "A map's root node cannot move to another map");

  const toParentId = input.parentId ?? target.map.rootNodeId;
  if (!toParentId || !target.nodes.some((n) => n.id === toParentId)) {
    throw new MoveToMapError(400, 'PARENT_NOT_FOUND', `Parent ${toParentId ?? '(root)'} not found on map ${toMapId}`);
  }

  const subtree = subtreeOf(root, byId);
  const movedIds = new Set(subtree.map((n) => n.id));

  // A claim goes, but not from under a running agent: its work would land
  // in the old map's repo.
  const claimed = subtree.filter((n) => n.claimedBySession !== null);
  if (claimed.length > 0) {
    const fleetId = await fleetEntityDb.getMapFleetId(fromMapId);
    const phases = fleetId ? ticketPhases(await fleetDb.listRollups(fleetId), new Date()) : new Map();
    const running = claimed.find((n) => phases.get(n.id)?.agentRunning);
    if (running) {
      throw new MoveToMapError(
        409,
        'AGENT_RUNNING',
        `An agent is working on "${running.text}" — stop it first (flag_blocker), then move the node`,
      );
    }
  }

  const targetRepo = await getForgeRepoForMap(toMapId).then(
    (r) => (r ? { owner: r.owner, name: r.name } : null),
    () => null,
  );
  const targetName = target.map.name;
  const sourceName = source.map.name;

  const notes: string[] = [];
  const comments: Array<{ nodeId: string; text: string }> = [];
  const moved = subtree.map((n) => {
    const externalLinks = (n.externalLinks ?? []).filter((l) => {
      if (!isForgeLink(l) || sameRepo(linkRepo(l), targetRepo)) return true;
      const note = `Issue link ${l.externalId} dropped on the move from map ${sourceName}: it is not in ${targetRepo ? `${targetRepo.owner}/${targetRepo.name}` : 'a repo this map plans'}.`;
      notes.push(`"${n.text}": ${note}`);
      comments.push({ nodeId: n.id, text: note });
      return false;
    });
    const dependencies = (n.dependencies ?? []).filter((d) => {
      if (movedIds.has(d.targetNodeId)) return true;
      const other = byId.get(d.targetNodeId);
      const note = `Dependency dropped: "${n.text}" moved to map ${targetName}, "${other?.text ?? d.targetNodeId}" stays in map ${sourceName}. Dependencies don't cross maps.`;
      notes.push(note);
      comments.push({ nodeId: n.id, text: note });
      if (other) comments.push({ nodeId: other.id, text: note });
      return false;
    });
    const linkedPr = n.linkedPr && sameRepo(parseRepoRef(n.linkedPr.repo) as RepoBinding | null, targetRepo) ? n.linkedPr : null;
    const tags = n.tags.filter((t) => t.toLowerCase() !== MISFILED_TAG);
    return { id: n.id, externalLinks, dependencies, tags, linkedPr };
  });

  const leftBehind = source.nodes
    .filter((n) => !movedIds.has(n.id) && (n.dependencies ?? []).some((d) => movedIds.has(d.targetNodeId)))
    .map((n) => {
      for (const d of n.dependencies.filter((x) => movedIds.has(x.targetNodeId))) {
        const other = byId.get(d.targetNodeId);
        const note = `Dependency dropped: "${other?.text ?? d.targetNodeId}" moved to map ${targetName}, "${n.text}" stays in map ${sourceName}. Dependencies don't cross maps.`;
        notes.push(note);
        comments.push({ nodeId: n.id, text: note });
        comments.push({ nodeId: d.targetNodeId, text: note });
      }
      return { id: n.id, dependencies: n.dependencies.filter((d) => !movedIds.has(d.targetNodeId)) };
    });

  const after = await nodeDb.moveSubtreeToMap({
    rootId: root.id,
    fromMapId,
    toMapId,
    fromParentId: root.parentId,
    toParentId,
    moved,
    leftBehind,
  });
  const movedRoot = after.find((n) => n.id === root.id);
  if (!movedRoot) throw new MoveToMapError(404, 'NODE_NOT_FOUND', `Node ${nodeId} changed while it was moved — try again`);

  for (const n of claimed) {
    const now = after.find((a) => a.id === n.id);
    if (now) {
      notes.push(`"${n.text}": claim released.`);
      await events
        .recordClaimTransition(fromMapId, n.id, userId, n, now, { reason: 'release', note: `moved to map ${targetName}` })
        .catch(() => {});
    }
  }

  // The change log of both maps. The node's own history stays under the
  // source map; the target map's starts with "moved from".
  const moveValue = { parentId: root.parentId, mapId: fromMapId, mapName: sourceName };
  const toValue = { parentId: toParentId, mapId: toMapId, mapName: targetName, text: root.text, nodeCount: after.length };
  await events
    .recordEvent({ mapId: fromMapId, nodeId: root.id, userId, eventType: 'node.moved', fieldName: 'map', oldValue: moveValue, newValue: toValue })
    .catch(() => {});
  await events
    .recordEvent({ mapId: toMapId, nodeId: root.id, userId, eventType: 'node.moved', fieldName: 'map', oldValue: moveValue, newValue: toValue })
    .catch(() => {});
  if (userId) {
    for (const c of comments) await commentDb.createComment({ nodeId: c.nodeId, userId, text: c.text }).catch(() => {});
  }

  broadcast(fromMapId, { type: 'node:deleted', nodeId: root.id, deletedIds: [...movedIds] });
  for (const l of leftBehind) {
    const n = byId.get(l.id)!;
    broadcast(fromMapId, { type: 'node:updated', nodeId: l.id, fields: ['dependencies'], node: { ...n, dependencies: l.dependencies } });
  }
  for (const n of after) broadcast(toMapId, { type: 'node:created', node: n });

  return { node: movedRoot, movedIds: [...movedIds], fromMapId, toMapId, toMapName: targetName, notes };
}
