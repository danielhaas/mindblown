/**
 * `audit_closed_issues` — the inventory half of the premature-close fix.
 *
 * The gates in the sync stop NEW issues from being closed as COMPLETED
 * with nothing merged behind them. This tool is how a project lead finds
 * the ones already sitting on the board claiming to be done: a
 * `CLOSED / COMPLETED` ticket with `commit_id = null` and no merged PR
 * ends the search, and that is exactly what happened to crm#8400 (two
 * weeks in the done column) and crm#6085 (its PR never merged; the work
 * is still missing).
 *
 * It lives on the MCP surface rather than in a shell script because the
 * people who need it — Dan reviewing the board, Jenna reconciling a
 * version — work through MCP tools, not through a server checkout. A
 * "run this script on the API host" answer is not a delivered feature
 * for them.
 *
 * `dryRun` defaults to TRUE. Reopening tickets in bulk is the kind of
 * thing you look at first and decide second.
 */

import { z } from 'zod';
import { defineTool } from '../spec.js';
import type { ClosedIssueAuditFinding } from '../backend.js';

const VERDICT_LABEL: Record<string, string> = {
  unbacked: 'NO MERGE — a PR claimed to close it, nothing landed',
  backed_by_pr: 'ok — merged PR on the default branch',
  backed_by_commit: 'ok — closed by a commit on the default branch',
  no_closing_pr: 'no PR ever — closed without code (not acted on)',
  skipped: 'skipped — not a completed close by the audited actor',
  error: 'ERROR',
};

function formatFinding(f: ClosedIssueAuditFinding): string {
  const bits = [`  ${f.externalId} — ${VERDICT_LABEL[f.verdict] ?? f.verdict}`];
  bits.push(`      ${f.title}`);
  if (f.closedBy || f.closedAt) {
    bits.push(`      closed ${f.closedAt ?? '?'} by ${f.closedBy ?? '?'}`);
  }
  if (f.closingPrs.length > 0) {
    bits.push(`      closing PRs: ${f.closingPrs.map((n) => `#${n}`).join(', ')}`);
  }
  if (f.mergeCommitSha) bits.push(`      merge commit: ${f.mergeCommitSha}`);
  if (f.nodeId) bits.push(`      node: ${f.nodeId}`);
  if (f.reopened) bits.push('      → REOPENED, node rolled back off done');
  if (f.error) bits.push(`      error: ${f.error}`);
  return bits.join('\n');
}

export const auditClosedIssuesTool = defineTool({
  name: 'audit_closed_issues',
  description: [
    'Find GitHub issues that are closed as COMPLETED but have no merge commit behind them.',
    '',
    'An issue fails the audit ("unbacked") when ALL of these hold:',
    '  - it is closed, and not closed as "not planned"',
    '  - its most recent `closed` event has commit_id = null (an API close, not a commit)',
    '  - a pull request DOES reference it with a closing keyword, and none of those merged',
    '    into the default branch',
    '',
    'Those tickets claim shipped work that is not on the default branch — the failure mode where',
    'a coding agent marks its node done on PR OPEN and the issue closes seconds later, then the',
    'PR dies unmerged and nobody looks again.',
    '',
    'An issue closed with no PR referencing it at all is reported as "no_closing_pr", never as',
    'a failure: that is ordinary non-code work (an assessment, an ops task) where MindBlown is',
    'the only thing that can close the ticket.',
    '',
    'THIS TOOL ONLY REPORTS. It never reopens anything. Reopening is a bulk write against real',
    'tickets and lives on the admin REST route POST /api/maps/:mapId/github/audit-closed-issues',
    'with `dryRun: false`, which requires a real admin session — an API key alone is not enough.',
    'Run this first, read the findings, then decide.',
    '',
    'Admin-only. Costs several GitHub API calls per inspected issue — use `limit` and `since`.',
  ].join('\n'),
  schema: {
    mapId: z.string().describe('The map whose GitHub integration to audit'),
    closedBy: z
      .string()
      .optional()
      .describe(
        'Only audit closes made by this GitHub login, e.g. "mindblown-by-project-li[bot]". Omit for all API closes.',
      ),
    since: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp — only consider issues updated at/after this point.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe('Maximum issues to inspect (default 200).'),
  },
  handler: async (backend, { mapId, closedBy, since, limit }) => {
    // No `dryRun` is forwarded — the tool reports, full stop. The MCP
    // API client forces `dryRun: true` on the wire as well, so a future
    // edit here cannot turn this into a write path by accident.
    const result = await backend.auditClosedIssues(mapId, {
      closedBy,
      since,
      limit,
    });

    const header = [
      `Closed-issue audit — ${result.repo} (report only, nothing was changed)`,
      `  inspected: ${result.inspected}`,
      `  claim completed work that never landed: ${result.unbacked}`,
      `  closed without any PR (not a finding): ${result.noClosingPr}`,
    ];
    if (result.truncated) {
      header.push(
        '  NOTE: the sweep was cut short (fetch valve or limit) — this is a sample, not the repo.',
      );
    }

    const interesting = result.findings.filter(
      (f) => f.verdict === 'unbacked' || f.verdict === 'error',
    );
    if (interesting.length === 0) {
      header.push('', 'No issue claims completed work that is missing from the default branch.');
      return header.join('\n');
    }

    header.push('', 'Findings:');
    for (const f of interesting) header.push(formatFinding(f));

    if (result.unbacked > 0) {
      header.push(
        '',
        'To reopen these, an admin runs POST /api/maps/' +
          mapId +
          '/github/audit-closed-issues with {"dryRun": false} from a logged-in session.',
      );
    }
    return header.join('\n');
  },
});

export const githubAuditTools = [auditClosedIssuesTool];
