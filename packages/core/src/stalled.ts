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

import { BLOCKED_TAG } from './dispatch.js';
import { resolveStatusDef } from './statusWorkflow.js';
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
 * "blocked" — those are already a decision and show in the Blocked panel).
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
