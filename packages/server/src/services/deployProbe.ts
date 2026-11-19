/**
 * Merged, not live — for every project (follow-up to #645).
 *
 * #645 sees only the checkout this server runs from. Every other project
 * (Navy, Tracer Avatar, Placet, …) says what it runs through its map's
 * `deployProbe`: a URL that returns the deployed commit (core
 * parseProbeBody). A tick reads each probe and asks the bound repo's forge
 * which commits on the default branch the deployed one lacks.
 *
 * Same threshold and surfaces as #645 (services/deployDrift.ts): the Fleet
 * tab banner of the map, a Pushover once the oldest waits past
 * DEPLOY_DRIFT_ALERT_HOURS and again daily while the same commit waits, a
 * line in the daily mail and in waiting_on_humans. A failed probe shows
 * as the error on the Fleet tab, never as stale numbers.
 */
import { and, isNull, isNotNull, sql } from 'drizzle-orm';
import { isProbeUrl, notLiveLabel, parseProbeBody } from '@mindblown/core';
import { db } from '../db/connection.js';
import { maps } from '../db/schema.js';
import { getSystemSetting, setSystemSetting } from '../db/settings.js';
import { getGitHubContextForMap, type ForgeMapContext } from '../lib/githubContext.js';
import { sendPush } from '../lib/pushover.js';
import {
  deployDriftForMap,
  driftAlertConfig,
  driftAlertDue,
  driftSummary,
  type DeployDrift,
  type DeployDriftSummary,
  type DriftAlertConfig,
  type UndeployedCommit,
} from './deployDrift.js';

export const PROBE_TIMEOUT_MS = 10_000;
/** A version endpoint answers in a line; more is not one. */
const PROBE_MAX_BYTES = 4096;

export class ProbeError extends Error {}

/** The deployed commit the probe reports. Throws ProbeError: HTTP error, timeout, no sha in the body. */
export async function readProbe(url: string, fetchImpl: typeof fetch = fetch, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json, text/plain' } });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') throw new ProbeError(`probe timed out after ${timeoutMs / 1000} s`);
    throw new ProbeError(`probe unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new ProbeError(`probe answered HTTP ${res.status}`);
  const sha = parseProbeBody((await res.text()).slice(0, PROBE_MAX_BYTES));
  if (!sha) throw new ProbeError('probe answered without a commit (expected {"commit": "<sha>"} or the plain sha)');
  return sha;
}

interface CompareCommit {
  sha: string;
  commit: { message: string; committer?: { date?: string } | null; author?: { date?: string } | null };
}

/**
 * Commits on the repo's default branch that `deployed` lacks, oldest
 * first (GitHub and Gitea both answer `compare/base...head` in this shape).
 */
export async function undeployedOnDefaultBranch(ctx: ForgeMapContext, deployed: string): Promise<{ branch: string; commits: UndeployedCommit[] }> {
  const { defaultBranch } = await ctx.forge.getRepoMergeSettings(ctx.owner, ctx.repo);
  const res = await ctx.forge.requestJson<{ commits?: CompareCommit[] | null }>(
    `/repos/${ctx.owner}/${ctx.repo}/compare/${encodeURIComponent(deployed)}...${encodeURIComponent(defaultBranch)}`,
  );
  const commits = (res.commits ?? [])
    .map((c) => ({
      sha: c.sha,
      at: c.commit.committer?.date ?? c.commit.author?.date ?? '',
      subject: c.commit.message.split('\n')[0],
    }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { branch: defaultBranch, commits };
}

/** A map's last probe: the drift, or why it could not be read. */
export type ProbeResult = { drift: DeployDrift; error?: undefined } | { drift?: undefined; error: string; checkedAt: string };

const latest = new Map<string, ProbeResult>();

/** The last tick's result for the map; undefined before the first, or once the probe is gone. */
export function latestProbeResult(mapId: string): ProbeResult | undefined {
  return latest.get(mapId);
}

/** Test hook. */
export function setLatestProbeResult(mapId: string, r: ProbeResult | undefined): void {
  if (r) latest.set(mapId, r);
  else latest.delete(mapId);
}

/** Every map's last drift with merges waiting — for the mail and waiting_on_humans. */
export function probeDrifts(): Array<{ mapId: string; drift: DeployDrift }> {
  return [...latest].flatMap(([mapId, r]) => (r.drift && r.drift.undeployed.length > 0 ? [{ mapId, drift: r.drift }] : []));
}

/** Is the oldest merge past the alert threshold? (The mail and waiting_on_humans say only those.) */
export function overThreshold(drift: DeployDrift, now: Date, cfg: DriftAlertConfig = driftAlertConfig()): boolean {
  const oldest = drift.undeployed[0];
  return !!oldest && now.getTime() - Date.parse(oldest.at) >= cfg.afterMs;
}

export interface ProbeMap {
  id: string;
  name: string;
  deployProbe: string;
}

/** Live maps with a probe URL and a bound repo. */
export async function listProbeMaps(): Promise<ProbeMap[]> {
  const rows = await db
    .select({ id: maps.id, name: maps.name, deployProbe: maps.deployProbe })
    .from(maps)
    .where(and(isNull(maps.archivedAt), isNotNull(maps.githubRepoName), sql`${maps.deployProbe} ~* '^https?://'`));
  return rows.filter((r): r is ProbeMap => isProbeUrl(r.deployProbe));
}

export const probeAlertKey = (mapId: string) => `deploy_drift_alert:${mapId}`;

export function probePushMessage(map: { name: string }, drift: DeployDrift, now: Date): { title: string; message: string } {
  const n = drift.undeployed.length;
  const lines = drift.undeployed.slice(0, 5).map((c) => `• ${c.subject}`);
  if (n > 5) lines.push(`• … and ${n - 5} more`);
  return {
    title: `${map.name}: ${n} merged ${n === 1 ? 'change' : 'changes'} not live`,
    message: `${notLiveLabel(n, map.name, drift.undeployed[0].at, now)}. Deployed: ${drift.sha.slice(0, 8)}.\n${lines.join('\n')}`,
  };
}

export interface ProbeDeps {
  readProbe: (url: string) => Promise<string>;
  context: (mapId: string) => Promise<ForgeMapContext | null>;
  compare: typeof undeployedOnDefaultBranch;
  push: typeof sendPush;
  getSetting: typeof getSystemSetting;
  setSetting: typeof setSystemSetting;
}

const realDeps: ProbeDeps = {
  readProbe: (url) => readProbe(url),
  context: (mapId) => getGitHubContextForMap(mapId),
  compare: undeployedOnDefaultBranch,
  push: sendPush,
  getSetting: getSystemSetting,
  setSetting: setSystemSetting,
};

/** One map: read the probe, compare, remember, push when due. Never throws — a failure is the map's result. */
export async function checkProbeMap(
  map: ProbeMap,
  now: Date = new Date(),
  cfg: DriftAlertConfig = driftAlertConfig(),
  deps: ProbeDeps = realDeps,
): Promise<{ result: ProbeResult; pushed: boolean }> {
  let result: ProbeResult;
  try {
    const sha = await deps.readProbe(map.deployProbe);
    const ctx = await deps.context(map.id);
    if (!ctx) throw new ProbeError("the map's repo is not reachable — no forge binding");
    const { commits } = await deps.compare(ctx, sha);
    result = { drift: { sha, repo: `${ctx.owner}/${ctx.repo}`, undeployed: commits, checkedAt: now.toISOString() } };
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err), checkedAt: now.toISOString() };
  }
  latest.set(map.id, result);
  if (!result.drift) return { result, pushed: false };
  const last = ((await deps.getSetting(probeAlertKey(map.id))) ?? null) as { sha: string; at: string } | null;
  if (!driftAlertDue(result.drift, last, now, cfg)) return { result, pushed: false };
  const pushed = await deps.push(probePushMessage(map, result.drift, now));
  if (pushed) await deps.setSetting(probeAlertKey(map.id), { sha: result.drift.undeployed[0].sha, at: now.toISOString() });
  return { result, pushed };
}

/** The tick: every map with a probe; results of maps whose probe is gone are dropped. */
export async function runProbeChecks(now: Date = new Date(), list: typeof listProbeMaps = listProbeMaps, deps: ProbeDeps = realDeps): Promise<{ checked: number; failed: string[]; pushed: number }> {
  const probeMaps = await list();
  const ids = new Set(probeMaps.map((m) => m.id));
  for (const id of [...latest.keys()]) if (!ids.has(id)) latest.delete(id);
  const out = { checked: 0, failed: [] as string[], pushed: 0 };
  for (const m of probeMaps) {
    const { result, pushed } = await checkProbeMap(m, now, driftAlertConfig(), deps);
    out.checked++;
    if (result.error) out.failed.push(`${m.name}: ${result.error}`);
    if (pushed) out.pushed++;
  }
  return out;
}

export interface DeployDriftView {
  drift: (DeployDriftSummary & { commits: UndeployedCommit[] }) | null;
  /** The map's probe could not be read on the last tick — why. */
  probeError: string | null;
}

/**
 * What the Fleet tab shows for a map: its probe's drift (or why the probe
 * failed); without a probe result, #645's own-checkout drift when the map
 * is bound to the repo this server runs from.
 */
export async function deployDriftView(mapId: string, self: typeof deployDriftForMap = deployDriftForMap): Promise<DeployDriftView> {
  const p = latest.get(mapId);
  if (p?.drift) return { drift: { ...driftSummary(p.drift)!, commits: p.drift.undeployed }, probeError: null };
  if (p?.error) return { drift: null, probeError: p.error };
  return { drift: await self(mapId), probeError: null };
}
