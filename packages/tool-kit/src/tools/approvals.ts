/**
 * Approval tools (#494): the proposed tickets the fleet will not run until
 * a trusted person lets them through, and that decision for agents. The
 * server refuses a decision from anyone off the map's trusted list and
 * from every fleet key.
 */
import { z } from 'zod';
import type { PendingApprovalList } from '@mindblown/core';
import { defineTool } from '../spec.js';
import type { ApprovalResult } from '../backend.js';

export function renderPendingApprovals(res: PendingApprovalList): string {
  if (res.items.length === 0) return 'No tickets waiting for approval.';
  const lines = [`Waiting for approval: ${res.items.length}`];
  for (const p of res.items) {
    const bits = [`reported by ${p.reporterLabel} (${p.trustLevel})`, `merge ${p.approval.merge}`];
    if (p.issue) bits.push(p.issue.ref);
    if (!p.canApprove) bits.push('you may not decide');
    lines.push('', `- [${p.mapName}] ${p.nodeId} · ${p.title.slice(0, 100)}`, `  ${bits.join(' · ')} · since ${p.createdAt.slice(0, 10)}`);
    if (p.hints.length > 0) lines.push(`  ⚠ ${p.hints.join('; ')}`);
    if (p.description) lines.push(`  ${p.description.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
  return lines.join('\n');
}

function renderOutcome(nodeId: string, r: ApprovalResult): string {
  const lines = [`${nodeId}: ${r.approval?.state ?? '?'}${r.approval?.state === 'approved' ? ` (merge ${r.approval.merge})` : ''}${r.ok ? '' : ' — SOME WRITES FAILED'}`];
  for (const w of r.writes) lines.push(`  ${w.done ? 'wrote' : 'FAILED'}: ${w.kind} ${w.target}${w.error ? ` (${w.error})` : ''}`);
  return lines.join('\n');
}

export const listPendingApprovalsTool = defineTool({
  name: 'list_pending_approvals',
  description: [
    'Proposed tickets (#492): work the fleet will not run until a trusted',
    'person approves it — tickets from reporters off the map\'s trusted list,',
    'outside forge issues, follow-ups the fleet created. Each row names the',
    'reporter and trust level, the linked issue, the merge mode it gets once',
    'approved, and hints when the text reads as written at the agent (ignore',
    'your instructions, keys, commands, URLs to fetch) — a hint, not a verdict.',
    'Read-only. Without mapId/fleetId: every map you can view.',
  ].join('\n'),
  schema: {
    mapId: z.string().optional().describe('One map'),
    fleetId: z.string().optional().describe('Every map of a fleet you can view'),
  },
  handler: async (backend, { mapId, fleetId }) => {
    if (mapId && fleetId) throw new Error('Pass at most one of mapId or fleetId');
    return renderPendingApprovals(await backend.listPendingApprovals({ mapId, fleetId }));
  },
});

export const approveTicketTool = defineTool({
  name: 'approve_ticket',
  description: [
    'Approve a proposed ticket so the fleet may run it. `merge` = pr-only',
    '(the worker stops at an open PR for a human merge) or auto; default is',
    'what the trust policy gave the ticket. `description` = edit & approve:',
    'the new text replaces the description first. Only for a person on the',
    'map\'s trusted list, never a fleet key. NEVER call this without that',
    'person\'s explicit go-ahead for this ticket.',
  ].join('\n'),
  schema: {
    mapId: z.string(),
    nodeId: z.string(),
    merge: z.enum(['auto', 'pr-only']).optional(),
    description: z.string().optional().describe('Edit & approve: the new description (plain text)'),
  },
  handler: async (backend, { mapId, nodeId, merge, description }) => renderOutcome(nodeId, await backend.approveTicket(mapId, nodeId, { merge, description })),
});

export const rejectTicketTool = defineTool({
  name: 'reject_ticket',
  description: [
    'Reject a proposed ticket: the fleet never runs it. `note` is posted on',
    'the linked forge issue («Rejected (name, date): note»); the issue stays',
    'open unless closeIssue (closed as not planned). Only for a person on the',
    'map\'s trusted list, never a fleet key. NEVER call this without that',
    'person\'s explicit decision.',
  ].join('\n'),
  schema: {
    mapId: z.string(),
    nodeId: z.string(),
    note: z.string().optional().describe('Why — posted on the forge issue'),
    closeIssue: z.boolean().optional().describe('Also close the forge issue (not planned)'),
  },
  handler: async (backend, { mapId, nodeId, note, closeIssue }) => renderOutcome(nodeId, await backend.rejectTicket(mapId, nodeId, { note, closeIssue })),
});

export const approvalTools = [listPendingApprovalsTool, approveTicketTool, rejectTicketTool];
