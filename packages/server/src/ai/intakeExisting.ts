/**
 * "Does this ticket already exist?" — the facts the intake model gets
 * before it drafts, and the shape the card shows afterwards.
 *
 * Two sources: nodes on the map (semantic hits, enriched with status,
 * closed date and the linked issue) and issues on the connected repo
 * that were never imported (keyword search over the forge). A forge hit
 * that is linked to a map node folds into that node. Whether a done
 * ticket was fixed by a merged PR is stated explicitly, because that is
 * what decides "reopen" versus "new ticket, relates to".
 */

import type { Node as CoreNode, ExternalLink } from '@mindblown/core';
import { isForgeLink, prBlocksIssueClose } from '@mindblown/core';
import { getGitHubContextForMap } from '../lib/githubContext.js';

export type IntakeVerdict = 'new' | 'covered' | 'extends' | 'regression';
export type IntakeRecommendation = 'nothing' | 'comment' | 'reopen' | 'create';

export interface IntakeExisting {
  /** Map node, or null when the issue only exists on the forge. */
  nodeId: string | null;
  /** Issue number on the connected repo, when linked or forge-only. */
  issueNumber: number | null;
  url: string | null;
  text: string;
  /** Node status, or the issue state for a forge-only hit. */
  status: string | null;
  closedAt: string | null;
  /** Done AND a merged PR landed for it — reopening is usually wrong. */
  fixedByPr: boolean;
  reason: string;
  recommendation: IntakeRecommendation;
}

export interface ForgeIssueHit {
  number: number;
  title: string;
  state: 'open' | 'closed';
  closedAt: string | null;
  url: string;
  externalId: string;
}

// ── Node facts ────────────────────────────────────────────────────

export interface NodeMatchFacts {
  status: string | null;
  closedAt: string | null;
  issueNumber: number | null;
  issueUrl: string | null;
  issueState: 'open' | 'closed' | null;
  fixedByPr: boolean;
}

function issueNumberOf(link: Pick<ExternalLink, 'externalId'>): number | null {
  const m = /#(\d+)$/.exec(link.externalId);
  return m ? Number(m[1]) : null;
}

export function forgeLinkOf(node: Pick<CoreNode, 'externalLinks'>): ExternalLink | null {
  return (node.externalLinks ?? []).find((l) => isForgeLink(l) && !l.isPullRequest) ?? null;
}

export function nodeMatchFacts(node: CoreNode): NodeMatchFacts {
  const link = forgeLinkOf(node);
  const done = node.status === 'done' || (node.percentComplete ?? 0) >= 100;
  // A merged, landed PR (mirror says merged and the close gate no longer
  // blocks) or a recorded merge commit on the link = shipped code.
  const merged =
    (node.linkedPr?.state === 'merged' && !prBlocksIssueClose(node.linkedPr, node.completedAt ?? null)) ||
    !!link?.mergeCommitSha;
  return {
    status: node.status ?? null,
    closedAt: node.completedAt ?? null,
    issueNumber: link ? issueNumberOf(link) : null,
    issueUrl: link?.url ?? null,
    issueState: link?.state ?? null,
    fixedByPr: done && merged,
  };
}

function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

export function describeNodeMatch(node: CoreNode): string {
  const f = nodeMatchFacts(node);
  const bits: string[] = [];
  bits.push(f.status ? `status ${f.status}` : 'no status');
  if (f.closedAt) bits.push(`done ${fmtDate(f.closedAt)}`);
  if (f.issueNumber != null) bits.push(`issue #${f.issueNumber}${f.issueState ? ` ${f.issueState}` : ''}`);
  if (f.fixedByPr) bits.push('fixed by a merged PR');
  return bits.join(', ');
}

// ── Forge search ──────────────────────────────────────────────────

const STOPWORDS = new Set(
  'a an the and or but if then so of to in on at for with without from by as is are was were be been being it its this that these those there here when where which who whom what how why not no yes do does did done should would could can cannot must also only just still already again very more most much many some any all each every both either neither than too into onto over under out up down off about after before during while until because since although though we you i he she they them our your their my me him her us ich du er sie es wir ihr der die das ein eine einer eines dem den und oder aber wenn dann also nicht kein keine mit ohne von zu im in auf für als ist sind war waren werden wird soll sollte kann könnte muss auch nur noch schon sehr mehr'
    .split(/\s+/),
);

/** A few discriminating words for a keyword search (forges AND the terms). */
export function keywordQuery(message: string, max = 5): string {
  const words = message
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#_-]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const uniq: string[] = [];
  for (const w of words) if (!uniq.includes(w)) uniq.push(w);
  // Longest words first: they carry the most meaning ("webhook" over "when").
  uniq.sort((a, b) => b.length - a.length);
  return uniq.slice(0, max).join(' ');
}

export type SearchForgeIssues = (mapId: string, query: string, limit?: number) => Promise<ForgeIssueHit[]>;

export const searchForgeIssues: SearchForgeIssues = async (mapId, query, limit = 6) => {
  const q = query.trim();
  if (!q) return [];
  const ctx = await getGitHubContextForMap(mapId);
  if (!ctx) return [];
  try {
    const issues = await ctx.forge.searchIssues(ctx.owner, ctx.repo, q, { limit });
    return issues
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        closedAt: i.closed_at ?? null,
        url: i.html_url,
        externalId: `${ctx.owner}/${ctx.repo}#${i.number}`,
      }));
  } catch (err) {
    console.warn(`[intake] forge search failed for map ${mapId}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
};

// ── The note the model reads ──────────────────────────────────────

export interface PreSearchInput {
  nodeHits: Array<{ nodeId: string; score: number }>;
  forgeHits: ForgeIssueHit[];
  nodes: CoreNode[];
}

/**
 * Lines for the "existing work" note under the user's message. Node hits
 * come first with their facts; forge hits that are linked to a node on
 * the map are dropped (the node line already carries the issue); the rest
 * are listed as "not in this map".
 */
export function preSearchLines(input: PreSearchInput): string[] {
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const linkedIds = new Set<string>();
  for (const n of input.nodes) {
    for (const l of n.externalLinks ?? []) if (isForgeLink(l)) linkedIds.add(l.externalId);
  }
  const lines: string[] = [];
  let i = 0;
  for (const h of input.nodeHits) {
    const n = byId.get(h.nodeId);
    if (!n) continue;
    lines.push(`${++i}. "${n.text}" [${n.id}] — ${describeNodeMatch(n)}; similarity ${h.score.toFixed(2)}`);
  }
  for (const f of input.forgeHits) {
    if (linkedIds.has(f.externalId)) continue;
    lines.push(
      `${++i}. issue #${f.number} "${f.title}" — ${f.state}${f.closedAt ? ` (closed ${fmtDate(f.closedAt)})` : ''}, NOT in this map`,
    );
  }
  return lines;
}
