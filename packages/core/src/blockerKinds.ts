/**
 * Every blocker reaches a person or resolves itself (19.11.2026).
 *
 * Free-text blockers ("Waiting on Dan: merge PR #62 …") held tickets out of
 * the queue but never reached the Questions card: plan_lint's
 * blocker-without-question found them, nothing acted on it. A blocker now
 * has a kind (flag_blocker):
 *
 *   question     a decision someone has to make → a question row on the
 *                Questions card (answerer default the map owner)
 *   person-step  something a person has to do → needs-human, the text the
 *                "Next step (a person)" on Your steps (no blocker)
 *   external     a party outside (vendor, client) → kept as a blocker with
 *                a re-check date; on that date the owner is asked again
 *   waits-on     another ticket → a dependency, no blocker (clears itself)
 *
 * A blocker set without a kind (old clients, update_node blockedReason) is
 * classified after UNKINDED_GRACE_MINUTES: a dependency when its text names
 * an open ticket/PR of the same map, else a question to the map owner.
 * Fleet workers' own notes ("Fleet worker <host>: …") keep their path —
 * the blocker row on Your steps and the worker's own asks.
 *
 * The question and re-check rows are derived on read like the other
 * MindBlown rows (humanSteps.ts): the node's blockerInfo is the truth, and
 * answering writes the node.
 */
import type { Ask } from './asks.js';
import { WORKER_WAIT_NOTE } from './dispatch.js';
import { isForgeLink, type BlockerInfo, type ExternalLink } from './types.js';

/** How long an unkinded blocker waits before it is classified — its author can still pick a kind. */
export const UNKINDED_GRACE_MINUTES = 60;

/** Default wait before an external blocker is asked about again. */
export const EXTERNAL_RECHECK_DAYS = 7;

export const QUESTION_ASK_PREFIX = 'question-';
export const EXTERNAL_ASK_PREFIX = 'external-';
export const EXTERNAL_ASK_OPTIONS = ['Still waiting', 'Unblocked'] as const;

export function questionAskId(nodeId: string): string {
  return QUESTION_ASK_PREFIX + nodeId;
}

/** The node a blocker question row is about, or null for any other ask id. */
export function questionAskNodeId(askId: string): string | null {
  return askId.startsWith(QUESTION_ASK_PREFIX) && askId.length > QUESTION_ASK_PREFIX.length ? askId.slice(QUESTION_ASK_PREFIX.length) : null;
}

export function externalAskId(nodeId: string): string {
  return EXTERNAL_ASK_PREFIX + nodeId;
}

/** The node an external re-check row is about, or null for any other ask id. */
export function externalAskNodeId(askId: string): string | null {
  return askId.startsWith(EXTERNAL_ASK_PREFIX) && askId.length > EXTERNAL_ASK_PREFIX.length ? askId.slice(EXTERNAL_ASK_PREFIX.length) : null;
}

/** The re-check date of an external wait flagged at `now`: `days` later (default EXTERNAL_RECHECK_DAYS). */
export function externalRecheckAt(now: Date, days: number = EXTERNAL_RECHECK_DAYS): string {
  return new Date(now.getTime() + Math.max(0, days) * 86_400_000).toISOString();
}

/** "Dan Haas" → "Dan": answerers on the card go by first name. */
export function answererName(userName: string | null | undefined): string {
  return (userName ?? '').trim().split(/\s+/)[0] || 'Dan';
}

/** A fleet worker's own note on its ticket — it keeps its current path (Your steps, the worker's asks). */
export function isWorkerNote(reason: string | null | undefined): boolean {
  return WORKER_WAIT_NOTE.test((reason ?? '').trim());
}

type BlockerNode = {
  id: string;
  text: string;
  blockedReason?: string | null;
  blockedAt?: string | null;
  blockerInfo?: BlockerInfo | null;
  priority?: string | null;
  externalLinks?: ExternalLink[];
  percentComplete?: number | null;
  claimedBySession?: string | null;
  updatedAt?: string;
};

/** A blocker nobody gave a kind: free text, not a fleet worker's note. */
export function isUnkindedBlocker(n: Pick<BlockerNode, 'blockedReason' | 'blockerInfo'>): boolean {
  const reason = (n.blockedReason ?? '').trim();
  return reason !== '' && !n.blockerInfo && !isWorkerNote(reason);
}

/**
 * An unkinded blocker older than the grace — the hourly classification
 * takes it. A blocker from before blockedAt existed has no clock: only
 * the one-time run takes it (`legacy`), after its dry run was read.
 */
export function unkindedDue(n: BlockerNode, now: Date, opts: { legacy?: boolean } = {}): boolean {
  if (!isUnkindedBlocker(n)) return false;
  const since = Date.parse(n.blockedAt ?? '');
  if (Number.isNaN(since)) return opts.legacy === true;
  return now.getTime() - since >= UNKINDED_GRACE_MINUTES * 60_000;
}

/** A reference a blocker names: "owner/repo#12", "owner/repo PR #12", "PR #12", "#12". */
export interface BlockerRef {
  repo: string | null;
  number: number;
}

export function blockerRefs(text: string): BlockerRef[] {
  const out: BlockerRef[] = [];
  const re = /(?:(?<![\w.-])([\w.-]+\/[\w.-]+)(?:\s+(?:PR|pull request|issue|ticket))?\s*)?#(\d+)\b/gi;
  for (const m of (text ?? '').matchAll(re)) {
    const ref = { repo: m[1]?.toLowerCase() ?? null, number: Number(m[2]) };
    if (!out.some((r) => r.repo === ref.repo && r.number === ref.number)) out.push(ref);
  }
  return out;
}

function linksTo(n: { externalLinks?: ExternalLink[] }, ref: BlockerRef): boolean {
  return (n.externalLinks ?? []).some((l) => {
    if (!isForgeLink(l)) return false;
    const m = /^(.+)#(\d+)$/.exec(l.externalId);
    return m != null && Number(m[2]) === ref.number && (ref.repo == null || m[1].toLowerCase() === ref.repo);
  });
}

/**
 * The open node of the same map the blocker's text names through its
 * issue or PR link — the ticket it waits on. Null when it names none, or
 * only finished ones (a wait on finished work is a question: why still?).
 */
export function waitedOnNode<N extends { id: string; status: string | null; externalLinks?: ExternalLink[] }>(
  node: { id: string; blockedReason?: string | null },
  nodes: Iterable<N>,
  isDone: (status: string | null) => boolean,
): N | null {
  const refs = blockerRefs(node.blockedReason ?? '');
  if (refs.length === 0) return null;
  const all = [...nodes];
  for (const ref of refs) {
    const hit = all.find((n) => n.id !== node.id && !isDone(n.status) && linksTo(n, ref));
    if (hit) return hit;
  }
  return null;
}

/** What the classification makes of an unkinded blocker. */
export type UnkindedPlan = { kind: 'waits-on'; targetNodeId: string } | { kind: 'question' };

export function classifyUnkinded<N extends { id: string; status: string | null; externalLinks?: ExternalLink[] }>(
  node: { id: string; blockedReason?: string | null },
  nodes: Iterable<N>,
  isDone: (status: string | null) => boolean,
): UnkindedPlan {
  const target = waitedOnNode(node, nodes, isDone);
  return target ? { kind: 'waits-on', targetNodeId: target.id } : { kind: 'question' };
}

function baseAsk(node: BlockerNode, mapId: string): Ask {
  const links = node.externalLinks ?? [];
  const issue = links.find((l) => isForgeLink(l) && !l.isPullRequest);
  const pr = links.find((l) => isForgeLink(l) && l.isPullRequest);
  return {
    id: '',
    map_id: mapId,
    ticket: null,
    requirement: null,
    title: node.text,
    url: issue?.url ?? pr?.url ?? null,
    sources: [],
    question: '',
    question_author: 'MindBlown',
    options: [],
    answerer: 'Dan',
    hint: 'decision',
    priority: node.priority ?? null,
    milestone: null,
    needs_version: false,
    idle_hours: null,
    unblocks: {
      node_id: node.id,
      node_title: node.text,
      node_status: `blocked${node.percentComplete ? ` · ${node.percentComplete} %` : ''}`,
      claimed_by: node.claimedBySession ?? null,
      worker: null,
      pr: pr?.url ?? null,
      pr_state: pr?.state ?? null,
    },
    moot: false,
  };
}

/** The question row of a node whose blocker is a question (blockerInfo.kind 'question'). */
export function buildQuestionAsk(node: BlockerNode, mapId: string, defaultAnswerer: string): Ask {
  const info = node.blockerInfo;
  return {
    ...baseAsk(node, mapId),
    id: questionAskId(node.id),
    sources: ['mindblown-question'],
    question: (node.blockedReason ?? '').trim() || '(no question given)',
    options: [...(info?.options ?? [])],
    answerer: info?.answerer?.trim() || defaultAnswerer,
  };
}

/** Is an external wait due for its re-check? */
export function externalRecheckDue(info: BlockerInfo | null | undefined, now: Date): boolean {
  if (info?.kind !== 'external') return false;
  const t = Date.parse(info.recheckAt ?? '');
  return Number.isNaN(t) || t <= now.getTime();
}

/** The re-check row of an external wait whose date has come. */
export function buildExternalAsk(node: BlockerNode, mapId: string, defaultAnswerer: string): Ask {
  const reason = (node.blockedReason ?? '').trim();
  return {
    ...baseAsk(node, mapId),
    id: externalAskId(node.id),
    sources: ['mindblown-external'],
    hint: 'waiting-external',
    question: `Still waiting? ${reason || '(no reason given)'}`,
    options: [...EXTERNAL_ASK_OPTIONS],
    answerer: node.blockerInfo?.answerer?.trim() || defaultAnswerer,
    unblocks: { ...baseAsk(node, mapId).unblocks, node_status: 'waiting on a party outside' },
  };
}

/** What an answer to a re-check row does: wait another round, lift the blocker, or record a decision and lift it. */
export type ExternalAnswer = 'still-waiting' | 'clear-blocker' | 'decision';

export function externalAnswerAction(decision: string): ExternalAnswer {
  const d = decision.trim().toLowerCase();
  if (d === 'still waiting' || d === 'still-waiting' || d === 'waiting') return 'still-waiting';
  if (d === 'unblocked' || d === 'unblock' || d === 'clear-blocker') return 'clear-blocker';
  return 'decision';
}
