/**
 * MindBlown's own deploy is a deploy signal too: when the server starts on a
 * commit it hasn't run before, the maps bound to its own repo (the git origin
 * of the checkout it runs from) get `markDeployed` — the reporter of every
 * finished outside ticket whose merge is inside that commit is asked.
 *
 * A plain restart on the same commit does nothing. No git checkout (a
 * container image, a tarball) means no signal; the card button still works.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DeployedResult } from '@mindblown/core';
import { listMapIdsBoundToRepo } from '../db/maps.js';
import { getSystemSetting, setSystemSetting } from '../db/settings.js';
import { markDeployed } from './reporterCheck.js';

const run = promisify(execFile);

export const SELF_DEPLOY_SHA_KEY = 'self_deploy_sha';

/** owner/repo of a GitHub remote URL (ssh or https); null for anything else. */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const m = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

export interface Git {
  head(): Promise<string>;
  origin(): Promise<string>;
  /** True when `sha` is an ancestor of (or equal to) `head`. Unknown commit → false. */
  contains(sha: string, head: string): Promise<boolean>;
}

const realGit: Git = {
  head: async () => (await run('git', ['rev-parse', 'HEAD'], { timeout: 10_000 })).stdout.trim(),
  origin: async () => (await run('git', ['remote', 'get-url', 'origin'], { timeout: 10_000 })).stdout.trim(),
  contains: async (sha, head) => {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
    try {
      await run('git', ['merge-base', '--is-ancestor', sha, head], { timeout: 10_000 });
      return true;
    } catch (err) {
      // exit 1 = not an ancestor, 128 = commit not here yet; anything else is a broken git.
      const code = (err as { code?: unknown }).code;
      if (code === 1 || code === 128) return false;
      throw err;
    }
  },
};

/** Real git with HEAD read once, right now: the commit this process runs, not a later pull. */
export function pinnedGit(): Git {
  const head = realGit.head();
  head.catch(() => undefined); // surfaced when awaited
  return { ...realGit, head: () => head };
}

export interface SelfDeployResult {
  sha: string;
  repo: string;
  maps: Array<{ mapId: string; result: DeployedResult }>;
}

/**
 * One check at startup; null when there's nothing to signal. Production
 * only — a dev server in a worktree changes commits all the time.
 */
export async function signalSelfDeploy(git: Git = realGit, now: Date = new Date()): Promise<SelfDeployResult | null> {
  let head: string;
  let origin: string;
  try {
    head = await git.head();
    origin = await git.origin();
  } catch (err) {
    console.warn('[self-deploy] no git checkout to read the deployed commit from:', err instanceof Error ? err.message : err);
    return null;
  }
  if ((await getSystemSetting(SELF_DEPLOY_SHA_KEY)) === head) return null; // a plain restart
  const repo = parseGitHubRemote(origin);
  const out: SelfDeployResult = { sha: head, repo: repo ? `${repo.owner}/${repo.repo}` : origin, maps: [] };
  if (repo) {
    const contains = (sha: string): Promise<boolean> => git.contains(sha, head);
    for (const mapId of await listMapIdsBoundToRepo(repo.owner, repo.repo)) {
      out.maps.push({ mapId, result: await markDeployed(mapId, now, { contains }) });
    }
  }
  // Stored last, and only when every ask went out: a failed one (a flaky
  // forge, a throw) is retried at the next start. Asked rows never ask twice.
  if (out.maps.every((m) => m.result.failed.length === 0)) await setSystemSetting(SELF_DEPLOY_SHA_KEY, head);
  return out;
}
