/**
 * An edited issue goes back for approval (#605).
 *
 * The approval gate (#492, #494) checks a ticket's text once. When the
 * issue's title or body changes after that, and the person who changed
 * it is not trusted on the map, the node is `proposed` again: the fleet
 * must not run text nobody approved.
 *
 * Left alone: a trusted editor, an edit that touches neither title nor
 * body, an edit whose title and body equal what the node holds (our own
 * sync echo), a node that is not `approved`, and a done / cancelled one.
 * A claimed or in-progress ticket is re-proposed too — the dispatch hold
 * keeps it from being handed out again — but a running agent is not
 * stopped (v1); the change event says so.
 */
import { buildIsDonePredicate, proseMirrorToPlainText, trustLevel } from '@mindblown/core';
import type { ForgeKindName, Node as CoreNode, NodeApproval } from '@mindblown/core';
import { extractAutoLinkIssueNumber } from '../lib/autoLink.js';
import * as mapDb from '../db/maps.js';
import * as nodeDb from '../db/nodes.js';
import { recordEvent } from '../db/events.js';
import { loadTrustContext } from './trustPolicy.js';

/** The parts of an `issues.edited` delivery (GitHub or normalized Gitea) this reads. */
export interface IssueEditedPayload {
  issue?: { number?: number; title?: string; body?: string | null } | null;
  changes?: { title?: unknown; body?: unknown } | null;
  sender?: { login?: string } | null;
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\r\n/g, '\n').trim();

/** The issue title as the node would hold it — ingest keeps the `#N ` marker. */
function titleAsText(node: CoreNode, number: number | undefined, title: string): string {
  if (number != null && extractAutoLinkIssueNumber(node.text) === number && extractAutoLinkIssueNumber(title) !== number) {
    return `#${number} ${title}`;
  }
  return title;
}

/** Did this edit change the ticket's text, against what the node holds? Pure. */
export function editChangesText(node: CoreNode, payload: IssueEditedPayload): boolean {
  const issue = payload.issue;
  if (!issue) return false;
  const changes = payload.changes ?? {};
  const titleEdited =
    changes.title !== undefined &&
    typeof issue.title === 'string' &&
    norm(titleAsText(node, issue.number, issue.title)) !== norm(node.text);
  const description = node.description;
  const bodyEdited =
    changes.body !== undefined &&
    norm(issue.body) !== norm(description) &&
    norm(issue.body) !== norm(proseMirrorToPlainText(description));
  return titleEdited || bodyEdited;
}

export type ReproposeOutcome =
  | { reproposed: true; node: CoreNode }
  | { reproposed: false; reason: 'not_approved' | 'closed' | 'no_text_change' | 'no_editor' | 'trusted_editor' | 'no_map' | 'decided_elsewhere' };

/**
 * Re-propose `node` if this edit warrants it. Call with the node as it was
 * BEFORE the edit is applied — the text comparison needs the stored text.
 * The caller broadcasts (`announceReproposal`).
 */
export async function reproposeOnIssueEdit(
  node: CoreNode,
  payload: IssueEditedPayload,
  provider: ForgeKindName,
  now: Date = new Date(),
): Promise<ReproposeOutcome> {
  if (node.approval?.state !== 'approved') return { reproposed: false, reason: 'not_approved' };
  if (node.status === 'done' || node.status === 'cancelled') return { reproposed: false, reason: 'closed' };
  if (!editChangesText(node, payload)) return { reproposed: false, reason: 'no_text_change' };
  // Fail closed: an edit with no named editor counts as untrusted.
  const login = payload.sender?.login ?? null;
  const ctx = await loadTrustContext(node.mapId);
  if (!ctx) return { reproposed: false, reason: 'no_map' };
  if (login && trustLevel({ reportedBy: { kind: 'forge', provider, login } }, ctx.policy, ctx.memberIds, ctx.forgeUsers) === 'trusted') {
    return { reproposed: false, reason: 'trusted_editor' };
  }
  const isDone = buildIsDonePredicate((await mapDb.getStatusWorkflow(node.mapId)) ?? []);
  if (isDone(node.status)) return { reproposed: false, reason: 'closed' };

  const approval: NodeApproval = { state: 'proposed', merge: node.approval.merge, by: null, at: now.toISOString() };
  const saved = await nodeDb.setApproval(node.id, approval, 'approved');
  if (!saved) return { reproposed: false, reason: 'decided_elsewhere' };
  const running = node.claimedBySession !== null || node.status === 'in_progress';
  const note =
    `Back for approval: issue text edited by ${login ?? 'an unknown user'}` +
    (running ? '. The ticket is claimed or in progress; a running agent is not stopped.' : '');
  await recordEvent({
    mapId: node.mapId,
    nodeId: node.id,
    userId: null,
    eventType: 'node.field_changed',
    fieldName: 'approval',
    oldValue: node.approval,
    newValue: { ...approval, note },
  });
  return { reproposed: true, node: saved };
}
