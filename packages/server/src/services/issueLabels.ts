/**
 * Taking hold labels off a node's linked forge issue (GitHub or Gitea).
 *
 * The outbound sync rewrites labels only on a link with sync on, so a node
 * released from a hold — a step handed back (#619), a blocker cleared
 * (#622) — kept `blocked` / `needs-human` on its issue until someone took
 * it off by hand. Both releases call this.
 */
import { isForgeLink, type AskWrite, type ExternalLink, type Node as CoreNode } from '@mindblown/core';
import { ForgeApiError } from '@mindblown/integrations';
import type { ForgeMapContext } from '../lib/githubContext.js';

/**
 * The link a finding is about — the same choice the engine's forgeLinkOf
 * makes (first issue link with a synced state), falling back to any issue
 * link so a fix still works on a link that never synced a state.
 */
export function issueLinkOf(node: Pick<CoreNode, 'externalLinks'>): ExternalLink | null {
  const issues = (node.externalLinks ?? []).filter((l) => isForgeLink(l) && !l.isPullRequest);
  return issues.find((l) => l.state != null) ?? issues[0] ?? null;
}

/** The issue number of a forge link ("owner/repo#42" → 42), or null. */
export function issueNumberOf(link: ExternalLink | null): number | null {
  const num = link ? Number(/#(\d+)$/.exec(link.externalId)?.[1]) : NaN;
  return Number.isInteger(num) ? num : null;
}

/**
 * Remove `labels` from issue `num`. A 404 is a label that was not there.
 * Never throws: a forge error is reported on the returned write.
 */
export async function removeIssueLabels(ctx: ForgeMapContext, num: number, labels: readonly string[]): Promise<AskWrite> {
  const w: AskWrite = { kind: 'gh-edit', target: `#${num}`, detail: `--remove-label ${labels.join(',')}`, done: false };
  try {
    for (const label of labels) {
      const res = await ctx.forge.removeIssueLabel(ctx.owner, ctx.repo, num, label);
      if (res.status !== 404 && (res.status < 200 || res.status >= 300)) throw new ForgeApiError(res.status, res.bodyText, ctx.forge.endpoint.kind);
    }
    w.done = true;
  } catch (err) {
    w.error = err instanceof Error ? err.message : String(err);
  }
  return w;
}
