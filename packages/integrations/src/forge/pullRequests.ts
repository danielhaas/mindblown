/**
 * Wire → shared shape for a person's merge (pr_summary / merge_pr).
 *
 * GitHub and Gitea answer a single-PR read, a PR's file list and a commit's
 * combined status with near-identical JSON; the differences (Gitea's
 * `status` instead of `state` on a commit status, GitHub's separate check
 * runs, the merge-style vocabulary) are settled here.
 */

import type { ForgeCheck, ForgePullRequestDetail, ForgePullRequestFile, MergeMethod } from './types.js';

export interface RawPullRequest {
  number: number;
  title?: string | null;
  state: 'open' | 'closed';
  merged?: boolean | null;
  merged_at?: string | null;
  draft?: boolean | null;
  html_url: string;
  user?: { login?: string | null } | null;
  base: { ref: string };
  head: { ref: string; sha: string };
  mergeable?: boolean | null;
  additions?: number | null;
  deletions?: number | null;
  changed_files?: number | null;
  merge_commit_sha?: string | null;
}

export function pullRequestDetail(raw: RawPullRequest): ForgePullRequestDetail {
  return {
    number: raw.number,
    title: raw.title ?? '',
    state: raw.state,
    merged: raw.merged ?? raw.merged_at != null,
    draft: !!raw.draft,
    url: raw.html_url,
    author: raw.user?.login ?? null,
    base: raw.base.ref,
    head: raw.head.ref,
    headSha: raw.head.sha,
    mergeable: raw.mergeable ?? null,
    additions: raw.additions ?? null,
    deletions: raw.deletions ?? null,
    changedFiles: raw.changed_files ?? null,
    mergeCommitSha: raw.merge_commit_sha ?? null,
  };
}

export function pullRequestFiles(rows: Array<{ filename: string; additions?: number | null; deletions?: number | null }>): ForgePullRequestFile[] {
  return rows.map((f) => ({ path: f.filename, additions: f.additions ?? 0, deletions: f.deletions ?? 0 }));
}

/** A commit status — GitHub says `state`, Gitea `status`. */
export interface RawCommitStatus {
  context?: string | null;
  state?: string | null;
  status?: string | null;
  target_url?: string | null;
}

export function commitStatusCheck(s: RawCommitStatus): ForgeCheck {
  const v = (s.state ?? s.status ?? '').toLowerCase();
  const state: ForgeCheck['state'] =
    v === 'success' ? 'success' : v === 'pending' || v === '' ? 'pending' : v === 'warning' || v === 'skipped' ? 'neutral' : 'failure';
  return { name: s.context || 'status', state, url: s.target_url || null };
}

export interface RawCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
}

/** A GitHub check run: anything not completed is pending; only success / neutral / skipped pass. */
export function checkRunCheck(r: RawCheckRun): ForgeCheck {
  const c = (r.conclusion ?? '').toLowerCase();
  const state: ForgeCheck['state'] =
    r.status !== 'completed' ? 'pending' : c === 'success' ? 'success' : c === 'neutral' || c === 'skipped' ? 'neutral' : 'failure';
  return { name: r.name, state, url: r.html_url ?? null };
}

/** Gitea's `default_merge_style` in our vocabulary; a style we do not offer reads as squash. */
export function giteaMergeMethod(style: string | null | undefined): MergeMethod {
  return style === 'merge' || style === 'rebase' || style === 'squash' ? style : 'squash';
}

/** GitHub has no default merge method: squash (the fleet's own), else whatever the repo allows. */
export function githubMergeMethod(repo: { allow_squash_merge?: boolean; allow_merge_commit?: boolean; allow_rebase_merge?: boolean }): MergeMethod {
  if (repo.allow_squash_merge !== false) return 'squash';
  if (repo.allow_merge_commit !== false) return 'merge';
  return 'rebase';
}
