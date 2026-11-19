/**
 * Stalled work — a leaf that says "in progress" while nobody works on it.
 *
 * A worker that dies mid-ticket leaves its claim behind; orphan recovery or
 * the stale sweeper releases it, and the node stays in_progress at 25 %
 * with no claim. The pull queue skips it (not todo), the Blocked panel
 * skips it (no blocker), and the board shows it like live work — so no
 * surface asks a human to decide. This is that signal: shared by
 * blocked_digest, the Blocked panel, the PM Cockpit and plan_lint.
 *
 * "Nobody on it" is read from the change log, not from `updatedAt`:
 * internal writes (tag sweeps, sync mirrors) bump the row without anyone
 * working, while every real move — a status or progress edit, a claim —
 * leaves a change_event. The release itself is one, so the clock starts
 * when the claim was dropped.
 */

import type { Ask } from './asks.js';
import { BLOCKED_TAG, dispatchSkipTag } from './dispatch.js';
import { resolveStatusDef } from './statusWorkflow.js';
import { isForgeLink, type ExternalLink } from './types.js';
import type { StatusDef } from './types.js';

/** Hours without a change before unclaimed in-progress work counts as stalled. */
export const STALLED_AFTER_HOURS = 2;

/** What the rule reads off a node — core Node and every client's node mirror satisfy it. */
export interface StalledNodeLike {
  id: string;
  childrenIds: string[];
  status: string | null;
  percentComplete: number | null;
  claimedBySession: string | null;
  blockedReason?: string | null;
  tags?: string[];
  updatedAt: string;
}

export interface StalledRelease {
  /** The session that held the last claim. */
  session: string;
  releasedAt: string;
  /** ReleaseReason from the claim trail (release / stale_sweep / …). */
  reason: string | null;
}

export interface StalledLeaf {
  nodeId: string;
  percentComplete: number | null;
  /** The latest change_event on the node; falls back to updatedAt when none is on record. */
  lastChangeAt: string;
  /** The last node.released row — who had it and when it was dropped; null when never claimed. */
  lastRelease: StalledRelease | null;
}

/** Per-node activity from the change log, as the server reads it. */
export interface StalledActivity {
  lastChangeAt: Map<string, string>;
  lastRelease: Map<string, StalledRelease>;
}

/**
 * The state half of the rule, no clock: an open leaf that is in progress
 * (an in_progress status, or 1–99 % without a todo status), holds no claim
 * and carries no manual blocker (reason, `blocked` tag or a status named
 * "blocked" — those are already a decision and show in the Blocked panel)
 * and no skip tag (`needs-human` …): someone already said a person does
 * the rest, so it is not "nobody decided".
 * A todo status is a queued ticket, whatever its % says: the pull queue
 * hands it out, so it is not "nobody on it" — that is also what releasing
 * a stalled node back to the queue leaves behind. Unfinished predecessors
 * are the caller's check (they need the whole map).
 */
export function isStalledCandidate(node: StalledNodeLike, workflow: readonly StatusDef[]): boolean {
  if (node.childrenIds.length > 0) return false;
  if (node.claimedBySession != null) return false;
  if ((node.blockedReason ?? '').trim() !== '') return false;
  if ((node.tags ?? []).includes(BLOCKED_TAG)) return false;
  if ((node.status ?? '').toLowerCase() === BLOCKED_TAG) return false;
  if (dispatchSkipTag({ tags: node.tags ?? [] }) !== null) return false;
  const pct = node.percentComplete ?? 0;
  const category = resolveStatusDef([...workflow], node.status)?.category;
  if (category === 'done' || category === 'todo' || pct >= 100) return false;
  return category === 'in_progress' || pct > 0;
}

/** Candidates whose last change is at least `afterHours` old, longest-idle first. */
export function findStalled(
  nodes: readonly StalledNodeLike[],
  workflow: readonly StatusDef[],
  activity: StalledActivity,
  now: Date = new Date(),
  afterHours: number = STALLED_AFTER_HOURS,
): StalledLeaf[] {
  const cutoff = now.getTime() - afterHours * 3_600_000;
  const out: StalledLeaf[] = [];
  for (const n of nodes) {
    if (!isStalledCandidate(n, workflow)) continue;
    const lastChangeAt = activity.lastChangeAt.get(n.id) ?? n.updatedAt;
    if (Date.parse(lastChangeAt) > cutoff) continue;
    out.push({
      nodeId: n.id,
      percentComplete: n.percentComplete,
      lastChangeAt,
      lastRelease: activity.lastRelease.get(n.id) ?? null,
    });
  }
  return out.sort((a, b) => Date.parse(a.lastChangeAt) - Date.parse(b.lastChangeAt));
}

/** "45 min", "9 h", "3 d". */
export function formatIdle(fromIso: string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(fromIso)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** One line for a digest or lint finding: "25 %, no change for 9 h, released by w-3@host 9 h ago (stale_sweep)". */
export function describeStalled(s: StalledLeaf, now: Date = new Date()): string {
  const parts = [`${s.percentComplete ?? 0} %`, `no change for ${formatIdle(s.lastChangeAt, now)}`];
  if (s.lastRelease) {
    const why = s.lastRelease.reason ? ` (${s.lastRelease.reason})` : '';
    parts.push(`released by ${s.lastRelease.session} ${formatIdle(s.lastRelease.releasedAt, now)} ago${why}`);
  } else {
    parts.push('never claimed');
  }
  return parts.join(', ');
}

// ── Stalled → a question on the Questions card ──────────────────────
//
// The Blocked panel shows stalled work, but nobody is asked: five Navy
// tickets sat at 85–90 % for up to 11 days (21.10.2026), all of them
// shipped. After a day the stall becomes an ask with three answers.
// No collector ever sees these (no worker holds the ticket), so MindBlown
// derives them on read — the one exception to "the collector is the
// truth for what is open" (asks.ts). Answering one writes the node, which
// ends the stall, so the question is gone on the next read.

/** A stalled leaf turns into an ask after this long without a change. */
export const STALLED_ASK_AFTER_HOURS = 24;
export const STALLED_ASK_PREFIX = 'stalled-';
export const STALLED_ASK_OPTIONS = ['Done', 'Back to the queue', 'For a person'] as const;
/** What an answer does — the lint fix of the same name (core LINT_ACTIONS). */
export type StalledAnswer = 'mark-done' | 'requeue' | 'needs-human';

export function stalledAskId(nodeId: string): string {
  return STALLED_ASK_PREFIX + nodeId;
}

/** The node a stalled ask is about, or null for any other ask id. */
export function stalledAskNodeId(askId: string): string | null {
  return askId.startsWith(STALLED_ASK_PREFIX) && askId.length > STALLED_ASK_PREFIX.length
    ? askId.slice(STALLED_ASK_PREFIX.length)
    : null;
}

/**
 * A "Decision: …" ticket is a person's call: left in progress with nobody
 * on it, it asks as soon as it counts as stalled. A Sonarpipe decision sat at 75 %
 * for 8 h on 23.10.2026 and looked like a fleet job running that long.
 */
export const DECISION_TITLE_RE = /^\s*(decision|entscheid)\s*:/i;

/** How long a stalled leaf waits before it becomes an ask: a decision after STALLED_AFTER_HOURS, anything else after a day. */
export function stalledAskAfterHours(title: string): number {
  return DECISION_TITLE_RE.test(title) ? STALLED_AFTER_HOURS : STALLED_ASK_AFTER_HOURS;
}

export function isStalledAskDue(s: StalledLeaf, now: Date = new Date(), title = ''): boolean {
  return now.getTime() - Date.parse(s.lastChangeAt) >= stalledAskAfterHours(title) * 3_600_000;
}

export function buildStalledAsk(
  node: { id: string; text: string; priority?: string | null; externalLinks?: ExternalLink[] },
  s: StalledLeaf,
  mapId: string,
  now: Date = new Date(),
): Ask {
  const issue = (node.externalLinks ?? []).find((l) => isForgeLink(l) && !l.isPullRequest);
  return {
    id: stalledAskId(node.id),
    map_id: mapId,
    ticket: null,
    requirement: null,
    title: node.text,
    url: issue?.url ?? null,
    sources: ['mindblown-stalled'],
    question:
      `In progress (${describeStalled(s, now)}) and nobody is working on it. Is it done, should it go back to the queue, ` +
      `or is the rest a person's step? Any other answer is kept as that next step.`,
    question_author: 'MindBlown',
    options: [...STALLED_ASK_OPTIONS],
    answerer: 'Dan',
    hint: 'decision',
    priority: node.priority ?? null,
    milestone: null,
    needs_version: false,
    idle_hours: Math.floor((now.getTime() - Date.parse(s.lastChangeAt)) / 3_600_000),
    unblocks: {
      node_id: node.id,
      node_title: node.text,
      node_status: 'stalled',
      claimed_by: null,
      worker: s.lastRelease?.session ?? null,
      pr: null,
      pr_state: null,
    },
    moot: false,
  };
}

/** Which fix an answer means: one of the three options, else free text = a person's next step. */
export function stalledAnswerAction(decision: string): StalledAnswer {
  const d = decision.trim().toLowerCase();
  if (d === 'done' || d === 'mark done' || d === 'mark-done') return 'mark-done';
  if (d === 'back to the queue' || d === 'requeue' || d === 'queue') return 'requeue';
  return 'needs-human';
}

/** The note a free-text answer leaves; the options themselves carry none. */
export function stalledAnswerNote(decision: string): string | null {
  const d = decision.trim();
  return STALLED_ASK_OPTIONS.some((o) => o.toLowerCase() === d.toLowerCase()) ? null : d || null;
}
