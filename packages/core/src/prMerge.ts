/**
 * A person merges a fleet PR through MindBlown (pr_summary / merge_pr /
 * prs_waiting) — e.g. by voice through the Tracer avatar, after the
 * person said yes. The shapes the server returns and the rules it gates
 * a merge on, kept pure so every surface reads the same refusal.
 */

import type { LinkedPrState } from './types.js';

export type PrCheckState = 'success' | 'failure' | 'pending' | 'neutral';
/** Roll-up of a PR head's checks; `none` = no CI reported at all. */
export type PrCiResult = 'success' | 'failure' | 'pending' | 'none';

export interface PrCheck {
  name: string;
  state: PrCheckState;
  url: string | null;
}

export interface PrFileStat {
  path: string;
  additions: number;
  deletions: number;
}

/** pr_summary: everything a person needs to decide a merge. */
export interface PrSummary {
  mapId: string;
  nodeId: string;
  ticket: string;
  forge: 'github' | 'gitea';
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string | null;
  /** The fleet session holding the ticket, if any. */
  worker: string | null;
  base: string;
  head: string;
  headSha: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  mergeable: boolean | null;
  ci: PrCiResult;
  checks: PrCheck[];
  reviews: LinkedPrState['reviews'];
  /** Why it waits (the fleet's label: Needs a human merge / No CI / CI red …); null when it does not wait on a person. */
  waits: string | null;
  /** Top files by lines changed (at most PR_SUMMARY_FILES). */
  files: PrFileStat[];
  filesTotal: number;
  additions: number;
  deletions: number;
  readAt: string;
}

export const PR_SUMMARY_FILES = 20;

export type MergeRefusalCode =
  | 'NOT_A_PERSON'
  | 'FORBIDDEN'
  | 'NO_PR'
  | 'NO_FORGE'
  | 'NOT_OPEN'
  | 'DRAFT'
  | 'HEAD_MOVED'
  | 'CONFLICTS'
  | 'MERGEABLE_UNKNOWN'
  | 'CI_FAILED'
  | 'CI_RUNNING'
  | 'PROTECTED';

export interface MergeRefusal {
  code: MergeRefusalCode;
  message: string;
}

export type MergePrResult =
  | {
      merged: true;
      repo: string;
      number: number;
      url: string;
      method: 'merge' | 'squash' | 'rebase';
      mergeCommitSha: string | null;
      /** The node after the post-merge flow (done unless the PR merged off the default branch). */
      nodeStatus: string | null;
      landedOnDefault: boolean;
    }
  | ({ merged: false } & MergeRefusal);

/** prs_waiting: one open PR a person has to act on. */
export interface PrWaiting {
  mapId: string;
  mapName: string;
  nodeId: string;
  ticket: string;
  repo: string;
  number: number;
  url: string | null;
  title: string | null;
  ci: PrCiResult | 'unknown';
  waits: string;
  /** Since when it waits: the fleet's phase start, else the PR's last activity MindBlown saw. */
  since: string | null;
}

export interface PrsWaitingList {
  items: PrWaiting[];
  now: string;
}

/** The fleet labels (core ticketPhase) that mean a person has to act on the PR. */
export const WAITS_ON_PERSON = ['Needs a human merge', 'No CI', 'CI red', 'Merge conflict'] as const;

export function waitsOnPerson(label: string | null | undefined): boolean {
  return !!label && (WAITS_ON_PERSON as readonly string[]).includes(label);
}

export function ciResult(checks: Array<{ state: PrCheckState }>): PrCiResult {
  if (checks.length === 0) return 'none';
  if (checks.some((c) => c.state === 'failure')) return 'failure';
  if (checks.some((c) => c.state === 'pending')) return 'pending';
  return 'success';
}

/** A webhook snapshot's roll-up (`checks.state`: success | failure | skipped | cancelled | null …) in the same words. */
export function snapshotCi(state: string | null | undefined): PrCiResult {
  if (state == null) return 'none';
  if (state === 'success' || state === 'neutral' || state === 'skipped') return 'success';
  if (state === 'pending' || state === 'queued' || state === 'in_progress') return 'pending';
  return 'failure';
}

/** Why a PR without a fleet phase waits — the same labels ticketPhase uses; null = it waits on CI, not a person. */
export function waitLabel(pr: { draft?: boolean; mergeable: boolean | null }, ci: PrCiResult): string | null {
  if (pr.draft) return null;
  if (pr.mergeable === false) return 'Merge conflict';
  if (ci === 'failure') return 'CI red';
  if (ci === 'none') return 'No CI';
  if (ci === 'pending') return null;
  return 'Needs a human merge';
}

/**
 * Why this PR must not merge now, or null. No force: every refusal names
 * what has to change first. No CI at all is not a refusal — that is the
 * "No CI, merge it by hand" case a person is asked to decide.
 */
export function mergeRefusal(
  pr: { state: 'open' | 'closed'; merged: boolean; draft: boolean; headSha: string; mergeable: boolean | null; number: number },
  checks: PrCheck[],
  expectedHeadSha: string,
): MergeRefusal | null {
  if (pr.merged) return { code: 'NOT_OPEN', message: `PR #${pr.number} is already merged.` };
  if (pr.state !== 'open') return { code: 'NOT_OPEN', message: `PR #${pr.number} is closed.` };
  if (pr.draft) return { code: 'DRAFT', message: `PR #${pr.number} is a draft — mark it ready first.` };
  if (!expectedHeadSha || !pr.headSha.toLowerCase().startsWith(expectedHeadSha.toLowerCase()) || expectedHeadSha.length < 7) {
    return {
      code: 'HEAD_MOVED',
      message: `PR #${pr.number}'s head is now ${pr.headSha.slice(0, 10)}, not ${expectedHeadSha.slice(0, 10) || '(none given)'} — someone pushed since you read it. Read pr_summary again and decide on what is there now.`,
    };
  }
  if (pr.mergeable === false) return { code: 'CONFLICTS', message: `PR #${pr.number} has merge conflicts with its base — they must be resolved first.` };
  if (pr.mergeable === null) return { code: 'MERGEABLE_UNKNOWN', message: `The forge is still working out whether PR #${pr.number} merges cleanly — try again in a minute.` };
  const failed = checks.filter((c) => c.state === 'failure');
  if (failed.length > 0) return { code: 'CI_FAILED', message: `CI failed on PR #${pr.number}: ${failed.map((c) => c.name).join(', ')}.` };
  const running = checks.filter((c) => c.state === 'pending');
  if (running.length > 0) return { code: 'CI_RUNNING', message: `CI is still running on PR #${pr.number}: ${running.map((c) => c.name).join(', ')}. Wait for it to finish.` };
  return null;
}
