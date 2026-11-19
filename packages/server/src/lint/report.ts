/**
 * The data side of a plan-lint run, shared by GET /api/maps/:id/lint and
 * the daily self-check (lint/daily.ts): change-event digests, dismissals,
 * acceptances, the forge PR check, sprints, stalled work, the repo
 * connection, open asks and misfiled tickets, fed into the pure engine.
 */
import * as cycleDb from '../db/cycles.js';
import { computeTree, isForgeLink, type ExternalLink, type Node, type StalledLeaf } from '@mindblown/core';
import { getForgeContextForMap } from '../lib/githubContext.js';
import * as versionDb from '../db/versions.js';
import { pickActiveLane } from '../lib/activeLane.js';
import * as lintDb from '../db/lint.js';
import { listActiveAcceptances } from '../db/acceptances.js';
import { listEvents } from '../db/events.js';
import { stalledForMap } from '../lib/stalled.js';
import { forgeProblemForMap } from '../lib/forgeProblem.js';
import * as asksDb from '../db/asks.js';
import * as fleetEntityDb from '../db/fleets.js';
import type * as mapDb from '../db/maps.js';
import { misfiledForMap } from '../services/misfiled.js';
import {
  buildDonePredicate,
  computePlanLint,
  CLAIM_CHURN_HOURS,
  REPLAN_LOOKBACK_DAYS,
  scopeLeaves,
  STALE_PLAN_DAYS,
  type ForgePrCheck,
  type LintHistory,
  type LintReport,
  type LintRuleId,
} from './engine.js';

const MS_PER_DAY = 86_400_000;

async function loadHistory(mapId: string, now: Date): Promise<LintHistory> {
  try {
    const replanSince = new Date(now.getTime() - REPLAN_LOOKBACK_DAYS * MS_PER_DAY);
    const staleSince = new Date(now.getTime() - STALE_PLAN_DAYS * MS_PER_DAY);
    const churnSince = new Date(now.getTime() - CLAIM_CHURN_HOURS * 3_600_000);
    const [progress, due, start, est, recent, claims] = await Promise.all([
      listEvents({ mapId, fieldName: 'percentComplete', since: replanSince, limit: 1000 }),
      listEvents({ mapId, fieldName: 'dueDate', since: replanSince, limit: 1000 }),
      listEvents({ mapId, fieldName: 'startDate', since: replanSince, limit: 1000 }),
      listEvents({ mapId, fieldName: 'effortEstimate', since: replanSince, limit: 1000 }),
      listEvents({ mapId, since: staleSince, limit: 1 }),
      // A spinning worker writes one pickup every tick — 720/day at a
      // 2-minute cadence — so the window needs room for a few of them.
      listEvents({ mapId, eventType: 'node.claimed', since: churnSince, limit: 5000 }),
    ]);
    // Events arrive newest-first; first hit per node is its latest change.
    const lastProgressChange = new Map<string, string>();
    for (const e of progress) {
      if (e.nodeId && !lastProgressChange.has(e.nodeId)) lastProgressChange.set(e.nodeId, e.createdAt);
    }
    const replanEvents = new Map<string, string[]>();
    for (const e of [...due, ...start, ...est]) {
      if (!e.nodeId) continue;
      const list = replanEvents.get(e.nodeId) ?? [];
      list.push(e.createdAt);
      replanEvents.set(e.nodeId, list);
    }
    const claimPickups = new Map<string, number>();
    for (const e of claims) {
      if (e.nodeId) claimPickups.set(e.nodeId, (claimPickups.get(e.nodeId) ?? 0) + 1);
    }
    return { ok: true, lastProgressChange, replanEvents, anyRecentEvent: recent.length > 0, claimPickups };
  } catch {
    return { ok: false, lastProgressChange: new Map(), replanEvents: new Map(), anyRecentEvent: false };
  }
}

/** Most recently updated done+linked nodes checked per run — keeps a panel open to a bounded forge budget. */
export const FORGE_PR_CHECK_CAP = 20;
const FORGE_PR_CHECK_TIMEOUT_MS = 8_000;
// The panel re-runs the lint after every dismiss, and agents call plan_lint
// in loops; a node's PR set cannot change without its updatedAt moving, so
// a short cache keyed on that turns those re-runs into zero forge calls.
const FORGE_PR_CACHE_TTL_MS = 15 * 60_000;
const FORGE_PR_CACHE_MAX = 2000;
const forgePrCache = new Map<string, { value: ForgePrCheck; at: number }>();

function cacheKey(mapId: string, n: Node, externalId: string): string {
  return `${mapId}:${n.id}:${externalId}:${n.updatedAt}`;
}

function cachePut(key: string, value: ForgePrCheck, now: number): void {
  if (forgePrCache.size >= FORGE_PR_CACHE_MAX) {
    for (const [k, v] of forgePrCache) if (now - v.at > FORGE_PR_CACHE_TTL_MS) forgePrCache.delete(k);
    if (forgePrCache.size >= FORGE_PR_CACHE_MAX) forgePrCache.delete(forgePrCache.keys().next().value!);
  }
  forgePrCache.set(key, { value, at: now });
}

/** Test seam: forget every cached forge answer. */
export function resetForgePrCache(): void {
  forgePrCache.clear();
}

/**
 * done-without-pr input: for the most recently updated done nodes IN SCOPE
 * that carry a forge link, ask the forge which pull requests reference the
 * issue. A node linked straight to a pull request counts that PR without a
 * lookup. Returns undefined (rule skipped) when the map has no forge or the
 * batch times out; a single failed lookup only drops that node — a slow or
 * partially broken forge must not hold the whole lint run hostage.
 */
async function loadForgePrs(
  mapId: string,
  scopedNodes: Node[],
  isDoneStatus: (status: string | null) => boolean,
  now: Date,
): Promise<{ forgePrs: Map<string, ForgePrCheck>; capped: boolean } | undefined> {
  const candidates = scopedNodes
    .filter((n) => isDoneStatus(n.status))
    .map((n) => ({ n, link: (n.externalLinks ?? []).find(isForgeLink) }))
    .filter((x): x is { n: Node; link: ExternalLink } => x.link != null)
    .sort((a, b) => (b.n.updatedAt > a.n.updatedAt ? 1 : b.n.updatedAt < a.n.updatedAt ? -1 : 0));
  if (candidates.length === 0) return { forgePrs: new Map(), capped: false };

  let ctx: Awaited<ReturnType<typeof getForgeContextForMap>>;
  try {
    ctx = await getForgeContextForMap(mapId);
  } catch {
    return undefined;
  }
  if (!ctx) return undefined;
  const boundOwner = ctx.owner.toLowerCase();
  const boundRepo = ctx.repo.toLowerCase();
  const forge = ctx.forge;

  const checked = candidates.slice(0, FORGE_PR_CHECK_CAP);
  const forgePrs = new Map<string, ForgePrCheck>();
  const pending: Array<{ n: Node; externalId: string; owner: string; repo: string; number: number }> = [];
  for (const { n, link } of checked) {
    // externalId is "owner/repo#N"; only items on the bound repo are ours to ask about.
    // GitHub full names are case-insensitive; the binding may be user-typed.
    const m = /^([^/#]+)\/([^/#]+)#(\d+)$/.exec(link.externalId);
    if (!m || m[1].toLowerCase() !== boundOwner || m[2].toLowerCase() !== boundRepo) continue;
    const number = Number(m[3]);
    if (link.isPullRequest) {
      forgePrs.set(n.id, { externalId: link.externalId, prs: [number] });
      continue;
    }
    const hit = forgePrCache.get(cacheKey(mapId, n, link.externalId));
    if (hit && now.getTime() - hit.at <= FORGE_PR_CACHE_TTL_MS) {
      forgePrs.set(n.id, hit.value);
      continue;
    }
    pending.push({ n, externalId: link.externalId, owner: m[1], repo: m[2], number });
  }

  const lookups = Promise.allSettled(
    pending.map(async (p) => {
      const prs = await forge.listCrossReferencingPullRequests(p.owner, p.repo, p.number);
      const value: ForgePrCheck = { externalId: p.externalId, prs: [...prs] };
      // Fill the cache even when this run has already timed out: the next run benefits.
      cachePut(cacheKey(mapId, p.n, p.externalId), value, Date.now());
      return [p.n.id, value] as const;
    }),
  );
  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), FORGE_PR_CHECK_TIMEOUT_MS).unref?.(),
  );
  const result = await Promise.race([lookups, timeout]);
  if (result === 'timeout') return undefined;
  for (const r of result) if (r.status === 'fulfilled') forgePrs.set(r.value[0], r.value[1]);
  return { forgePrs, capped: candidates.length > checked.length };
}

/** The nodes an open ask on the map's Questions card is about; undefined = the map has no card (no fleet). */
export async function openAskNodeIdsForMap(mapId: string): Promise<Set<string> | undefined> {
  const fleetId = await fleetEntityDb.getMapFleetId(mapId);
  if (!fleetId) return undefined;
  const rows = await asksDb.listAsks({ fleetId, mapId }, { status: 'open' });
  return new Set(rows.map((r) => r.ask.unblocks?.node_id).filter((id): id is string => !!id));
}

export interface LintRunQuery {
  nodeId?: string;
  versionId?: string;
  cycleId?: string;
  stalledDays?: number;
  rule?: LintRuleId;
  /** 'all' = the whole map instead of the active-lane default. */
  scope?: string;
}

type MapData = NonNullable<Awaited<ReturnType<typeof mapDb.getMap>>>;

/**
 * Run the linter on a loaded map. `userId` decides which other maps
 * misfiled-repo can see. Returns the report plus the stalled list it read
 * (the daily check decides its fixes from it), or the scoping error.
 */
export async function buildLintReport(
  data: MapData,
  q: LintRunQuery,
  userId: string | null | undefined,
  now: Date = new Date(),
): Promise<{ report: LintReport; stalled: StalledLeaf[] | undefined } | { error: string }> {
  const mapId = data.map.id;
    // Same effort-unit → days conversion as GET /:id/schedule.
    const unitsPerDay = data.map.effortUnit === 'hours' ? (data.map.hoursPerDay ?? 8) : 1;

    // ── Active-lane default scope ─────────────────────────────
    // Unscoped lint over a mature map is background noise (900+
    // standing warnings on the primary map — nobody reads them). When
    // the caller names NO scope, default to the map's active release
    // lane: the work that is actually being dispatched is the work
    // whose hygiene matters right now. `scope=all` restores the
    // whole-map run; any explicit nodeId/versionId/cycleId wins.
    let effectiveVersionId = q.versionId;
    let defaultedToLane: { id: string; name: string } | null = null;
    if (
      !q.nodeId &&
      !q.versionId &&
      !q.cycleId &&
      q.scope !== 'all'
    ) {
      const lane = pickActiveLane(await versionDb.listVersions(mapId));
      if (lane) {
        effectiveVersionId = lane.id;
        defaultedToLane = { id: lane.id, name: lane.name };
      }
    }

    // The forge check spends real API budget, so it only sees the nodes
    // the report will show (same scope resolution as the engine) and only
    // runs when its rule is part of the answer.
    const scoped = scopeLeaves(data.nodes, {
      nodeId: q.nodeId,
      versionId: effectiveVersionId,
      cycleId: q.cycleId,
    });
    if ('error' in scoped) return { error: scoped.error };
    const wantsForge = q.rule == null || q.rule === 'done-without-pr';

    const [history, dismissalRows, acceptances, forge, sprints, stalled, forgeProblem, openAskNodeIds, misfiled] = await Promise.all([
      loadHistory(mapId, now),
      lintDb.listDismissals(mapId),
      // Best-effort: a failed acceptance load skips stale-acceptance
      // (reported as such) instead of failing the whole lint run.
      listActiveAcceptances(mapId).catch(() => undefined),
      // Same contract for the forge: unreachable → done-without-pr skipped.
      wantsForge
        ? loadForgePrs(
            mapId,
            scoped.scopedNodes,
            buildDonePredicate(data.map.statusWorkflow),
            now,
          ).catch(() => undefined)
        : Promise.resolve(undefined),
      // Same contract: a failed load skips sprint-state, not the run.
      cycleDb.listCycles(mapId).catch(() => undefined),
      // The same stalled list the map payload carries (blocked_digest, panels).
      stalledForMap(data.map, data.nodes, now).catch(() => undefined),
      // Same contract: a failed check skips broken-repo-connection.
      forgeProblemForMap(data.map).catch(() => undefined),
      // Same contract: no fleet (no Questions card) or a failed read skips blocker-without-question.
      openAskNodeIdsForMap(mapId).catch(() => undefined),
      // Same contract: an unbound map or a failed read skips misfiled-repo.
      misfiledForMap(mapId, data.nodes, userId).catch(() => undefined),
    ]);

    // Rolled-up progress so requirement rules work on parent nodes too.
    const computed = computeTree(data.nodes, data.map.healthThreshold);
    const computedProgress = new Map<string, number>();
    for (const [id, cv] of computed) computedProgress.set(id, cv.computedProgress);

    const report = computePlanLint({
      map: data.map,
      nodes: data.nodes,
      unitsPerDay,
      history,
      dismissals: dismissalRows.map((d) => ({ nodeId: d.nodeId, ruleId: d.ruleId })),
      acceptances,
      computedProgress,
      forgePrs: forge?.forgePrs,
      forgePrsCap: forge?.capped ? FORGE_PR_CHECK_CAP : undefined,
      sprints,
      stalled,
      forgeProblem,
      openAskNodeIds,
      misfiled,
      nodeId: q.nodeId,
      versionId: effectiveVersionId,
      cycleId: q.cycleId,
      stalledDays: q.stalledDays,
      now,
    });
    if ('error' in report) return report;
    if (defaultedToLane) {
      // Machine consumers read report.scope; the label is for humans.
      // The escape-hatch hint is composed per surface (the MCP tool
      // phrases it in its own parameter syntax), not baked in here.
      report.scope.defaultedToLane = true;
      report.scope.versionName = defaultedToLane.name;
      report.scopeLabel = `${defaultedToLane.name} (active lane — default)`;
    }
    return { report, stalled };
}

