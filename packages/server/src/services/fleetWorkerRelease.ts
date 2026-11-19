/**
 * Which claude-fleet commit a worker without a GitHub token may update to
 * (claude-fleet #120): the newest commit on the worker repo's `main` whose
 * CI is green.
 *
 * Read through the GitHub App installation of the map bound to that repo
 * (looked up by repo, `FLEET_WORKER_REPO`, default danielhaas/claude-fleet).
 * Walks the last 20 commits of `main`, newest first; the first whose checks
 * all passed (success, or neutral/skipped next to at least one success) wins.
 * A commit with no checks at all is not green.
 *
 * One answer is cached for 3 minutes (and one lookup shared while in
 * flight), so N workers polling don't hit GitHub N times. A miss (no
 * binding, forge unreachable, nothing green) is cached too — the worker
 * stays put either way.
 */
import { findAppBoundMapIdForRepo } from '../db/maps.js';
import { getForgeContextForMap } from '../lib/githubContext.js';

export const WORKER_RELEASE_BRANCH = 'main';
const DEFAULT_REPO = 'danielhaas/claude-fleet';
const COMMITS_WALKED = 20;
const CACHE_MS = 3 * 60_000;
const SHA_RE = /^[0-9a-f]{40}$/;

export type WorkerRelease = { sha: string; green: true; checkedAt: string };
export type WorkerReleaseMiss = { error: string; checkedAt: string };
type Answer = WorkerRelease | WorkerReleaseMiss;

let cached: { at: number; answer: Promise<Answer> } | null = null;

export function _resetWorkerReleaseCacheForTests(): void {
  cached = null;
}

export function workerRepo(): { owner: string; repo: string } | null {
  const raw = (process.env.FLEET_WORKER_REPO || DEFAULT_REPO).trim();
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(raw);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export async function latestGreenWorkerCommit(now = Date.now()): Promise<Answer> {
  if (cached && now - cached.at < CACHE_MS) return cached.answer;
  const answer = lookup(new Date(now).toISOString());
  cached = { at: now, answer };
  return answer;
}

async function lookup(checkedAt: string): Promise<Answer> {
  const miss = (error: string): WorkerReleaseMiss => ({ error, checkedAt });
  const target = workerRepo();
  if (!target) return miss(`FLEET_WORKER_REPO is not owner/repo: ${process.env.FLEET_WORKER_REPO}`);
  const name = `${target.owner}/${target.repo}`;
  try {
    const mapId = await findAppBoundMapIdForRepo(target.owner, target.repo);
    if (!mapId) return miss(`No map is bound to ${name} through the GitHub App`);
    const ctx = await getForgeContextForMap(mapId);
    if (!ctx) return miss(`The GitHub App binding for ${name} gave no client`);
    const { forge, owner, repo } = ctx;
    const commits = await forge.requestJson<Array<{ sha?: unknown }>>(
      `/repos/${owner}/${repo}/commits?sha=${WORKER_RELEASE_BRANCH}&per_page=${COMMITS_WALKED}&limit=${COMMITS_WALKED}`,
    );
    for (const c of (Array.isArray(commits) ? commits : []).slice(0, COMMITS_WALKED)) {
      const sha = typeof c.sha === 'string' ? c.sha.toLowerCase() : '';
      if (!SHA_RE.test(sha)) continue;
      const checks = await forge.listCommitChecks(owner, repo, sha);
      const passed = checks.length > 0 && checks.some((k) => k.state === 'success') && checks.every((k) => k.state === 'success' || k.state === 'neutral');
      if (passed) return { sha, green: true, checkedAt };
    }
    return miss(`None of the last ${COMMITS_WALKED} commits on ${name} ${WORKER_RELEASE_BRANCH} has green CI`);
  } catch (err) {
    return miss(`Could not read ${name} from GitHub: ${err instanceof Error ? err.message : String(err)}`);
  }
}
