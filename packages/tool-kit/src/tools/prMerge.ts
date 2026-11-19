/**
 * A person merges a fleet PR through MindBlown — e.g. by voice through the
 * Tracer avatar: prs_waiting lists what waits on a person, pr_summary reads
 * one PR live from the forge, merge_pr merges it pinned to the head the
 * person was told about. A merge happens only on a person's explicit
 * decision; a fleet key is refused by the server.
 */
import { z } from 'zod';
import type { MergePrResult, PrSummary, PrsWaitingList } from '@mindblown/core';
import { defineTool } from '../spec.js';

const CHECK_MARK: Record<string, string> = { success: '✓', failure: '✗', pending: '…', neutral: '○' };
const CI_TEXT: Record<string, string> = { success: 'green', failure: 'red', pending: 'running', none: 'no CI reported', unknown: 'unknown' };

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function renderPrSummary(s: PrSummary): string {
  const lines = [
    `PR #${s.number} · ${s.repo} — ${s.title}`,
    `Ticket: ${s.ticket} (node ${s.nodeId})`,
    s.url,
    `Author: ${s.author ?? 'unknown'}${s.worker ? ` · Worker: ${s.worker}` : ''}`,
    `${s.base} ← ${s.head} @ ${s.headSha}`,
    `State: ${s.state}${s.draft ? ' (draft)' : ''} · ${s.mergeable === true ? 'merges cleanly' : s.mergeable === false ? 'HAS CONFLICTS' : 'mergeable not known yet'}`,
  ];
  if (s.waits) lines.push(`Waits: ${s.waits}`);
  lines.push(`CI: ${CI_TEXT[s.ci] ?? s.ci}${s.checks.length ? ` (${s.checks.length} check${s.checks.length === 1 ? '' : 's'})` : ''}`);
  for (const c of s.checks) lines.push(`  ${CHECK_MARK[c.state] ?? '?'} ${c.name}${c.state === 'failure' && c.url ? ` — ${c.url}` : ''}`);
  if (s.reviews.length === 0) lines.push('Reviews: none');
  else {
    lines.push('Reviews:');
    for (const r of s.reviews) lines.push(`  ${r.state} by ${r.author}${r.body ? ` — ${oneLine(r.body)}` : ''}`);
  }
  lines.push(`Files: ${s.filesTotal} changed, +${s.additions} −${s.deletions}`);
  for (const f of s.files) lines.push(`  +${f.additions} −${f.deletions}  ${f.path}`);
  if (s.filesTotal > s.files.length) lines.push(`  … ${s.filesTotal - s.files.length} more`);
  if (s.state === 'open') {
    lines.push('', `Only after the person said yes: merge_pr mapId=${s.mapId} nodeId=${s.nodeId} expectedHeadSha=${s.headSha}`);
  }
  return lines.join('\n');
}

export function renderMergeResult(r: MergePrResult): string {
  if (!r.merged) return `Not merged (${r.code}): ${r.message}`;
  const lines = [`Merged PR #${r.number} in ${r.repo} (${r.method})${r.mergeCommitSha ? ` as ${r.mergeCommitSha.slice(0, 10)}` : ''}.`, r.url];
  if (!r.landedOnDefault) lines.push('It merged into a branch other than the default branch — the ticket stays open until the work lands there.');
  else if (r.nodeStatus) lines.push(`Ticket is now ${r.nodeStatus}.`);
  return lines.join('\n');
}

export function renderPrsWaiting(res: PrsWaitingList): string {
  if (res.items.length === 0) return 'No PRs are waiting on a person.';
  const lines = [`PRs waiting on a person: ${res.items.length}`];
  for (const p of res.items) {
    const ref = p.repo ? `${p.repo}#${p.number}` : `PR #${p.number}`;
    lines.push(
      '',
      `- [${p.mapName}]${p.mapArchived ? ' [ARCHIVED]' : ''} ${ref} · ${p.title ?? p.ticket}`,
      `  ${p.waits} · CI ${CI_TEXT[p.ci] ?? p.ci}${p.since ? ` · since ${p.since.slice(0, 16).replace('T', ' ')}` : ''} · node ${p.nodeId}${p.url ? ` · ${p.url}` : ''}`,
    );
  }
  lines.push('', 'Read one with pr_summary mapId=<map> nodeId=<node> before deciding.');
  return lines.join('\n');
}

export const prsWaitingTool = defineTool({
  name: 'prs_waiting',
  description: [
    'Open PRs waiting on a person: the fleet says "Needs a human merge", "No CI",',
    '"CI red" or "Merge conflict", or an open PR outside the fleet that is not',
    'waiting on CI. One row each: map, repo#number, title, why it waits, CI',
    'result, since when, node id. Read-only. Without mapId: every map you can',
    'view (or the fleet\'s), archived maps left out — they are on hold; name an',
    'archived map by mapId to see its PRs (marked [ARCHIVED]). Next step:',
    'pr_summary on the one the person asks about.',
  ].join('\n'),
  schema: {
    mapId: z.string().optional().describe('One map'),
    fleetId: z.string().optional().describe('Every map of a fleet you can view'),
  },
  handler: async (backend, { mapId, fleetId }) => {
    if (mapId && fleetId) throw new Error('Pass at most one of mapId or fleetId');
    return renderPrsWaiting(await backend.prsWaiting({ mapId, fleetId }));
  },
});

export const prSummaryTool = defineTool({
  name: 'pr_summary',
  description: [
    "A ticket's open PR, read live from the map's forge: repo, number, URL,",
    'title, ticket, author and worker, base ← head and the head SHA, mergeable',
    'or conflicts, every CI check, reviews, why it waits, and the files changed',
    'with +/- (top 20) and the total diff stat. Read-only. Tell the person what',
    'it says before asking whether to merge; merge_pr needs the head SHA from',
    'this read.',
  ].join('\n'),
  schema: {
    mapId: z.string().describe('The map of the ticket'),
    nodeId: z.string().describe('The ticket (node) whose PR to read'),
  },
  handler: async (backend, { mapId, nodeId }) => renderPrSummary(await backend.prSummary(mapId, nodeId)),
});

export const mergePrTool = defineTool({
  name: 'merge_pr',
  description: [
    "Merge a ticket's PR through the map's forge (GitHub or Gitea/Forgejo) —",
    "only on a person's explicit decision: call it only after the person, told",
    'what pr_summary said, answered yes to merging this PR. Never on your own',
    'judgment, never to clear a queue. A fleet key is refused.',
    'Refused, with the reason, when the PR is not open or is a draft, the head',
    'moved past expectedHeadSha, it has conflicts, CI failed or is still',
    'running, or the forge protects the branch. There is no force. Afterwards',
    'the ticket goes done and its claim is released, as for a merge on the',
    'forge, and change_history records who merged.',
  ].join('\n'),
  schema: {
    mapId: z.string().describe('The map of the ticket'),
    nodeId: z.string().describe('The ticket (node) whose PR to merge'),
    expectedHeadSha: z.string().min(7).describe('The head SHA pr_summary showed the person — the merge is refused if the PR moved since'),
    method: z.enum(['merge', 'squash', 'rebase']).optional().describe("How to merge; default: the repo's setting"),
  },
  handler: async (backend, { mapId, nodeId, expectedHeadSha, method }) =>
    renderMergeResult(await backend.mergePr(mapId, nodeId, { expectedHeadSha, method })),
});

export const prMergeTools = [prsWaitingTool, prSummaryTool, mergePrTool];
