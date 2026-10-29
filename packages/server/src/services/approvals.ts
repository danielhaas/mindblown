/**
 * Deciding on proposed tickets (#494): approve, edit & approve, reject.
 *
 * Who may decide: a person on the map's trusted list (trust_policy
 * trustedUserIds, the same list that approves at creation, #492) with
 * edit on the map. A fleet service user (users.kind = 'fleet') never
 * decides, even when an admin put it on the list — a worker key must not
 * let its own follow-ups through.
 *
 * The stamp records who and when (`by` = the user id). A reject leaves
 * the node where it is — the queue holds rejected work — and posts the
 * note on the linked forge issue; the issue stays open unless asked.
 */
import { eq, inArray } from 'drizzle-orm';
import { approvalHints, buildIsDonePredicate, isForgeLink, proseMirrorToPlainText, trustLevel } from '@mindblown/core';
import type { ApproveInput, NodeApproval, Node as CoreNode, PendingApproval, PendingApprovalList, RejectInput } from '@mindblown/core';
import { closeGitHubIssue, commentOnGitHubIssue, parseExternalId } from '@mindblown/integrations';
import { db } from '../db/connection.js';
import { maps, users } from '../db/schema.js';
import * as mapDb from '../db/maps.js';
import * as nodeDb from '../db/nodes.js';
import * as permDb from '../db/permissions.js';
import { recordEvent, recordFieldChanges } from '../db/events.js';
import { getGitHubContextForMap } from '../lib/githubContext.js';
import { getFleetForUser } from './fleets.js';
import { loadTrustContext } from './trustPolicy.js';

export interface ApprovalError {
  status: 400 | 403 | 404 | 409;
  code: string;
  message: string;
}

/** What one decision wrote: the node, and the forge writes with their outcome. */
export interface ApprovalOutcome {
  node: CoreNode;
  changedFields: string[];
  writes: Array<{ kind: 'comment' | 'close'; target: string; done: boolean; error?: string }>;
}

/** May this user decide on this map's proposals? null = yes, else why not. */
export async function approverRefusal(userId: string, mapId: string): Promise<ApprovalError | null> {
  // 'fleet' and 'fleet_retired' service users; anything not a person.
  const [user] = await db.select({ kind: users.kind }).from(users).where(eq(users.id, userId));
  if (user?.kind !== 'person') return { status: 403, code: 'NOT_TRUSTED', message: 'A fleet key cannot approve or reject tickets' };
  if (!permDb.hasPermission(await permDb.getPermission(mapId, userId), 'edit')) {
    return { status: 403, code: 'FORBIDDEN', message: 'Edit access to the map required' };
  }
  const ctx = await loadTrustContext(mapId);
  if (!ctx) return { status: 404, code: 'MAP_NOT_FOUND', message: `Map ${mapId} not found` };
  if (!ctx.policy.trustedUserIds.includes(userId)) {
    return { status: 403, code: 'NOT_TRUSTED', message: "Only people on the map's trusted list may approve or reject tickets" };
  }
  return null;
}

/** Which maps a list covers: one map, a fleet's maps the reader can view, or all of the reader's maps. */
async function mapsInScope(userId: string, scope: { mapId?: string; fleetId?: string }): Promise<Array<{ id: string; name: string }> | ApprovalError> {
  if (scope.mapId) {
    if (!permDb.hasPermission(await permDb.getPermission(scope.mapId, userId), 'view')) {
      return { status: 403, code: 'FORBIDDEN', message: 'View access required' };
    }
    const [map] = await db.select({ id: maps.id, name: maps.name }).from(maps).where(eq(maps.id, scope.mapId));
    if (!map) return { status: 404, code: 'MAP_NOT_FOUND', message: `Map ${scope.mapId} not found` };
    return [map];
  }
  if (scope.fleetId) {
    const view = await getFleetForUser(userId, scope.fleetId);
    if ('status' in view) return { status: view.status === 403 ? 403 : 404, code: view.code, message: view.message };
    return view.maps.map((m) => ({ id: m.id, name: m.name }));
  }
  return (await mapDb.listMapsForUser(userId)).map((m) => ({ id: m.id, name: m.name }));
}

function issueOf(node: CoreNode): PendingApproval['issue'] {
  const link = node.externalLinks.find((l) => isForgeLink(l) && !l.isPullRequest);
  return link ? { ref: link.externalId, url: link.url } : null;
}

/** The proposed tickets in scope, each with its reporter and whether the reader may decide. */
export async function listPendingApprovals(userId: string, scope: { mapId?: string; fleetId?: string }): Promise<PendingApprovalList | ApprovalError> {
  const inScope = await mapsInScope(userId, scope);
  if ('status' in inScope) return inScope;
  // Done by the map's own workflow (category or name), as the pull queue reads it.
  const isDone = new Map<string, (status: string | null) => boolean>();
  const nodes: CoreNode[] = [];
  for (const n of await nodeDb.listProposedNodes(inScope.map((m) => m.id))) {
    if (!isDone.has(n.mapId)) isDone.set(n.mapId, buildIsDonePredicate((await mapDb.getStatusWorkflow(n.mapId)) ?? []));
    if (n.status !== 'done' && n.status !== 'cancelled' && !isDone.get(n.mapId)!(n.status)) nodes.push(n);
  }
  const names = new Map(inScope.map((m) => [m.id, m.name]));
  const reporterIds = [...new Set(nodes.flatMap((n) => (n.reportedBy?.kind === 'user' ? [n.reportedBy.userId] : [])))];
  const userNames = new Map(
    reporterIds.length === 0
      ? []
      : (await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, reporterIds))).map((u) => [u.id, u.name]),
  );
  const items: PendingApproval[] = [];
  const mayDecide = new Map<string, boolean>();
  for (const node of nodes) {
    const ctx = await loadTrustContext(node.mapId);
    if (!ctx || !node.approval) continue;
    if (!mayDecide.has(node.mapId)) mayDecide.set(node.mapId, (await approverRefusal(userId, node.mapId)) === null);
    const r = node.reportedBy;
    const description = proseMirrorToPlainText(node.description);
    items.push({
      mapId: node.mapId,
      mapName: names.get(node.mapId) ?? '',
      nodeId: node.id,
      revision: node.revision,
      title: node.text,
      description,
      reportedBy: r,
      reporterLabel: !r ? 'unknown' : r.kind === 'forge' ? `${r.provider}:${r.login}` : (userNames.get(r.userId) ?? 'a deleted user'),
      trustLevel: trustLevel(node, ctx.policy, ctx.memberIds, ctx.forgeUsers),
      approval: node.approval,
      issue: issueOf(node),
      hints: approvalHints(`${node.text}\n${description}`),
      canApprove: mayDecide.get(node.mapId)!,
      createdAt: node.createdAt,
    });
  }
  return { items, now: new Date().toISOString() };
}

/** The node on this map, refusing anything a decision can't apply to. */
async function decidable(userId: string, mapId: string, nodeId: string): Promise<CoreNode | ApprovalError> {
  const refused = await approverRefusal(userId, mapId);
  if (refused) return refused;
  const node = await nodeDb.getNode(nodeId);
  if (!node || node.mapId !== mapId) return { status: 404, code: 'NODE_NOT_FOUND', message: `Node ${nodeId} not found on this map` };
  return node;
}

/**
 * Write the stamp only if the node still carries the state the decision
 * was made on — two devices deciding at once: the second gets a 409, `by`
 * does not move. `note` (a reject's) goes into the change log with it.
 */
async function writeStamp(userId: string, node: CoreNode, approval: NodeApproval, note?: string): Promise<CoreNode | ApprovalError> {
  const saved = await nodeDb.setApproval(node.id, approval, node.approval?.state ?? null);
  if (!saved) return { status: 409, code: 'DECIDED_ELSEWHERE', message: 'Someone decided on this ticket in the meantime — reload' };
  const newValue = note ? { ...approval, note } : approval;
  await recordEvent({ mapId: node.mapId, nodeId: node.id, userId, eventType: 'node.field_changed', fieldName: 'approval', oldValue: node.approval, newValue });
  return saved;
}

/**
 * Approve a proposed (or rejected) ticket. With `description` the text is
 * written first — "edit & approve". `expectedRevision` = the revision the
 * person read: a ticket whose text changed since (a reporter's edit came
 * in through the forge) is a 409, so a yes never covers text nobody saw.
 */
export async function approveTicket(userId: string, mapId: string, nodeId: string, input: ApproveInput): Promise<ApprovalOutcome | ApprovalError> {
  if (input.merge !== undefined && input.merge !== 'auto' && input.merge !== 'pr-only') {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'merge must be "auto" or "pr-only"' };
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'description must be a string' };
  }
  if (input.expectedRevision !== undefined && !Number.isInteger(input.expectedRevision)) {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'expectedRevision must be an integer' };
  }
  const node = await decidable(userId, mapId, nodeId);
  if ('code' in node) return node;
  if (node.approval?.state === 'approved') return { status: 409, code: 'ALREADY_APPROVED', message: 'This ticket is already approved' };
  if (input.expectedRevision !== undefined && node.revision !== input.expectedRevision) {
    return { status: 409, code: 'TEXT_CHANGED', message: 'The ticket changed since you read it — reload and read it again' };
  }

  const changedFields: string[] = [];
  let current = node;
  if (input.description !== undefined && input.description.trim() !== proseMirrorToPlainText(node.description).trim()) {
    let edited: CoreNode | null;
    try {
      edited = await nodeDb.updateNode(node.id, { description: input.description.trim() || null }, node.revision);
    } catch (err) {
      if (err instanceof nodeDb.RevisionConflictError) return { status: 409, code: 'TEXT_CHANGED', message: 'The ticket changed while you edited it — reload' };
      throw err;
    }
    if (!edited) return { status: 404, code: 'NODE_NOT_FOUND', message: `Node ${node.id} not found` };
    // Who rewrote the ticket just before letting it through belongs in the trail.
    await recordFieldChanges(mapId, node.id, userId, node, edited);
    current = edited;
    changedFields.push('description');
  }
  const stamp: NodeApproval = {
    state: 'approved',
    merge: input.merge ?? node.approval?.merge ?? 'pr-only',
    by: userId,
    at: new Date().toISOString(),
  };
  const saved = await writeStamp(userId, current, stamp);
  if ('code' in saved) return saved;
  changedFields.push('approval');
  return { node: saved, changedFields, writes: [] };
}

function rejectLine(by: string, note: string): string {
  return `Rejected (${by}, ${new Date().toISOString().slice(0, 10)}): ${note}`;
}

/**
 * Reject a proposed ticket: the queue never runs it. Only proposed — an
 * approved ticket may already be claimed, and rejecting would not stop
 * its worker. The note goes into the change log and on the forge issue.
 */
export async function rejectTicket(userId: string, mapId: string, nodeId: string, input: RejectInput): Promise<ApprovalOutcome | ApprovalError> {
  if (input.note !== undefined && typeof input.note !== 'string') return { status: 400, code: 'VALIDATION_ERROR', message: 'note must be a string' };
  const node = await decidable(userId, mapId, nodeId);
  if ('code' in node) return node;
  if (node.approval?.state !== 'proposed') {
    return { status: 409, code: 'NOT_PROPOSED', message: `Only a proposed ticket can be rejected (this one is ${node.approval?.state ?? 'unstamped'})` };
  }

  const note = input.note?.trim() ?? '';
  const stamp: NodeApproval = { state: 'rejected', merge: node.approval.merge, by: userId, at: new Date().toISOString() };
  const saved = await writeStamp(userId, node, stamp, note || undefined);
  if ('code' in saved) return saved;

  const writes: ApprovalOutcome['writes'] = [];
  const link = node.externalLinks.find((l) => isForgeLink(l) && !l.isPullRequest);
  if (link && (note || input.closeIssue)) {
    const ctx = await getGitHubContextForMap(mapId);
    const parsed = parseExternalId(link.externalId);
    const fail = (kind: 'comment' | 'close', error: string) => writes.push({ kind, target: link.externalId, done: false, error });
    if (note) {
      if (!ctx || !parsed) fail('comment', 'map has no issue tracker connected — note not posted');
      else {
        const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
        try {
          await commentOnGitHubIssue(parsed.owner, parsed.repo, parsed.issueNumber, rejectLine(me?.name.split(/\s+/)[0] || 'a trusted user', note), ctx.forge);
          writes.push({ kind: 'comment', target: link.externalId, done: true });
        } catch (err) {
          fail('comment', err instanceof Error ? err.message : String(err));
        }
      }
    }
    if (input.closeIssue) {
      if (!ctx) fail('close', 'map has no issue tracker connected — issue left open');
      else {
        try {
          await closeGitHubIssue(link, ctx.forge, 'not_planned');
          writes.push({ kind: 'close', target: link.externalId, done: true });
        } catch (err) {
          fail('close', err instanceof Error ? err.message : String(err));
        }
      }
    }
  }
  return { node: saved, changedFields: ['approval'], writes };
}
