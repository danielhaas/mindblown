/**
 * Merged, not deployed — MindBlown's own drift (follow-up to #641).
 *
 * The fleet merges trusted PRs on green CI, but nothing deploys them: prod
 * moves only when someone runs the deploy. On 18.–19.11.2026 four merged
 * PRs sat undeployed for up to 19 h and nobody could see it.
 *
 * A tick fetches the checkout's upstream and lists the commits on it that
 * the running process doesn't have. The running commit is the one this
 * process started on (pinnedGit), so a `git pull` that hasn't been
 * restarted into still counts as not deployed. When the oldest undeployed
 * commit has waited past the threshold, one Pushover goes out, and again
 * once a day while the same commit still waits. `/api/health` and the
 * Fleet tab of the maps bound to this repo show the count.
 *
 * Production only: a dev server in a worktree is always "behind".
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listMapIdsBoundToRepo } from '../db/maps.js';
import { getSystemSetting, setSystemSetting } from '../db/settings.js';
import { sendPush } from '../lib/pushover.js';
import { parseGitHubRemote, type Git } from './selfDeploy.js';

const run = promisify(execFile);

export interface UndeployedCommit {
  sha: string;
  /** Committer date (ISO) — for a squash merge, when it was merged. */
  at: string;
  subject: string;
}

export interface DeployDrift {
  /** The commit this process runs. */
  sha: string;
  /** owner/repo of the checkout's origin; null when it isn't a GitHub remote. */
  repo: string | null;
  /** On the upstream, not in the running commit — oldest first. */
  undeployed: UndeployedCommit[];
  checkedAt: string;
}

export interface DriftGit extends Pick<Git, 'head' | 'origin'> {
  /** Fetch the upstream; list what it has that `head` doesn't, oldest first. */
  undeployed(head: string): Promise<UndeployedCommit[]>;
}

/** Real git around a pinned HEAD (the running commit). */
export function driftGit(git: Pick<Git, 'head' | 'origin'>): DriftGit {
  return {
    ...git,
    undeployed: async (head) => {
      await run('git', ['fetch', '--quiet', 'origin'], { timeout: 60_000 });
      const { stdout } = await run(
        'git',
        ['log', '--reverse', '--format=%H%x09%cI%x09%s', `${head}..@{upstream}`],
        { timeout: 10_000 },
      );
      return parseLog(stdout);
    },
  };
}

export function parseLog(stdout: string): UndeployedCommit[] {
  return stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const [sha, at, ...rest] = l.split('\t');
      return { sha, at, subject: rest.join('\t') };
    });
}

let latest: DeployDrift | null = null;

/** The last tick's result, for /api/health and the Fleet tab; null before the first. */
export function latestDeployDrift(): DeployDrift | null {
  return latest;
}

/** Test hook. */
export function setLatestDeployDrift(d: DeployDrift | null): void {
  latest = d;
}

export async function checkDeployDrift(git: DriftGit, now: Date = new Date()): Promise<DeployDrift> {
  const sha = await git.head();
  const remote = parseGitHubRemote(await git.origin());
  const drift: DeployDrift = {
    sha,
    repo: remote ? `${remote.owner}/${remote.repo}` : null,
    undeployed: await git.undeployed(sha),
    checkedAt: now.toISOString(),
  };
  latest = drift;
  return drift;
}

export const DEPLOY_DRIFT_ALERT_KEY = 'deploy_drift_alert';

export interface DriftAlertConfig {
  /** Alert once the oldest undeployed commit is this old. */
  afterMs: number;
  /** Repeat while the same commit still waits. */
  repeatMs: number;
}

export function driftAlertConfig(env: NodeJS.ProcessEnv = process.env): DriftAlertConfig {
  const hours = Number.parseFloat(env.DEPLOY_DRIFT_ALERT_HOURS ?? '');
  return {
    afterMs: (Number.isFinite(hours) && hours > 0 ? hours : 2) * 3_600_000,
    repeatMs: 24 * 3_600_000,
  };
}

interface LastAlert {
  sha: string;
  at: string;
}

/** Pure: should this drift push now, given the last push? */
export function driftAlertDue(drift: DeployDrift, last: LastAlert | null, now: Date, cfg: DriftAlertConfig): boolean {
  const oldest = drift.undeployed[0];
  if (!oldest) return false;
  if (now.getTime() - Date.parse(oldest.at) < cfg.afterMs) return false;
  if (!last || last.sha !== oldest.sha) return true;
  return now.getTime() - Date.parse(last.at) >= cfg.repeatMs;
}

function hoursSince(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 3_600_000));
}

export function driftPushMessage(drift: DeployDrift, now: Date): { title: string; message: string } {
  const n = drift.undeployed.length;
  const oldest = drift.undeployed[0];
  const lines = drift.undeployed.slice(0, 5).map((c) => `• ${c.subject}`);
  if (n > 5) lines.push(`• … and ${n - 5} more`);
  return {
    title: `MindBlown: ${n} merged ${n === 1 ? 'change' : 'changes'} not deployed`,
    message: `Oldest waiting ${hoursSince(oldest.at, now)} h. Prod runs ${drift.sha.slice(0, 8)}.\n${lines.join('\n')}`,
  };
}

/** One tick: check, and push when due. Errors propagate to the caller's log. */
export async function runDeployDriftCheck(
  git: DriftGit,
  now: Date = new Date(),
  cfg: DriftAlertConfig = driftAlertConfig(),
  push: typeof sendPush = sendPush,
): Promise<{ drift: DeployDrift; pushed: boolean }> {
  const drift = await checkDeployDrift(git, now);
  const last = ((await getSystemSetting(DEPLOY_DRIFT_ALERT_KEY)) ?? null) as LastAlert | null;
  if (!driftAlertDue(drift, last, now, cfg)) return { drift, pushed: false };
  const pushed = await push(driftPushMessage(drift, now));
  if (pushed) await setSystemSetting(DEPLOY_DRIFT_ALERT_KEY, { sha: drift.undeployed[0].sha, at: now.toISOString() });
  return { drift, pushed };
}

/** What a client may see: no commit subjects on the public health route. */
export interface DeployDriftSummary {
  sha: string;
  undeployed: number;
  /** When the oldest undeployed commit was merged; null when none waits. */
  undeployedSince: string | null;
  checkedAt: string;
}

export function driftSummary(d: DeployDrift | null): DeployDriftSummary | null {
  if (!d) return null;
  return { sha: d.sha, undeployed: d.undeployed.length, undeployedSince: d.undeployed[0]?.at ?? null, checkedAt: d.checkedAt };
}

/**
 * The drift for the Fleet tab of `mapId`: only a map bound to the repo
 * this server runs from has one (its tickets are what's waiting); null
 * for every other map, and before the first check.
 */
export async function deployDriftForMap(
  mapId: string,
  boundTo: typeof listMapIdsBoundToRepo = listMapIdsBoundToRepo,
): Promise<(DeployDriftSummary & { commits: UndeployedCommit[] }) | null> {
  const d = latest;
  if (!d?.repo) return null;
  const [owner, repo] = d.repo.split('/');
  if (!(await boundTo(owner, repo)).includes(mapId)) return null;
  return { ...driftSummary(d)!, commits: d.undeployed };
}
