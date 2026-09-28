/**
 * Plan-lint routes — the REST surface behind the plan-health panel and
 * the plan_lint MCP tool (docs/plan-linter.md).
 *
 *   GET    /api/maps/:id/lint              — run the linter, structured report
 *   POST   /api/maps/:id/lint/dismissals   — dismiss a finding / mute a rule
 *   DELETE /api/maps/:id/lint/dismissals   — undo a dismissal (querystring)
 *   POST   /api/maps/:id/lint/fix          — apply one fix a finding offers
 *
 * The engine itself is pure (../lint/engine.ts); this file supplies data:
 * nodes from the map, change-event digests, dismissals, unitsPerDay.
 */
import type { FastifyInstance } from 'fastify';
import { computeTree, isForgeLink, type ExternalLink, type Node } from '@mindblown/core';
import { getForgeContextForMap } from '../lib/githubContext.js';
import { requireMapAccess } from '../lib/mapAccess.js';
import * as mapDb from '../db/maps.js';
import * as versionDb from '../db/versions.js';
import { pickActiveLane } from '../lib/activeLane.js';
import * as lintDb from '../db/lint.js';
import { listActiveAcceptances } from '../db/acceptances.js';
import { listEvents } from '../db/events.js';
import { applyLintFix, LintFixError } from '../lint/fix.js';
import {
  buildDonePredicate,
  computePlanLint,
  CLAIM_CHURN_HOURS,
  LINT_FIX_ACTIONS,
  LINT_RULE_IDS,
  REPLAN_LOOKBACK_DAYS,
  scopeLeaves,
  STALE_PLAN_DAYS,
  type ForgePrCheck,
  type LintActionId,
  type LintHistory,
  type LintRuleId,
} from '../lint/engine.js';

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

export async function lintRoutes(app: FastifyInstance) {
  // ── GET /api/maps/:id/lint ─────────────────────────────────────
  app.get<{
    Params: { id: string };
    Querystring: {
      nodeId?: string;
      versionId?: string;
      cycleId?: string;
      stalledDays?: string;
      rule?: string;
      scope?: string;
    };
  }>('/api/maps/:id/lint', async (req, reply) => {
    const userId = req.userId;
    if (!(await requireMapAccess(req, reply, req.params.id, 'view'))) return reply;

    const data = await mapDb.getMap(req.params.id);
    if (!data) {
      return reply.status(404).send({
        error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.id} not found` },
      });
    }

    const rule = req.query.rule as LintRuleId | undefined;
    if (rule && !LINT_RULE_IDS.includes(rule)) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: `Unknown rule "${rule}"` },
      });
    }
    const stalledDays = req.query.stalledDays ? Number(req.query.stalledDays) : undefined;
    if (stalledDays != null && (!Number.isInteger(stalledDays) || stalledDays < 1)) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'stalledDays must be a positive integer' },
      });
    }

    // Same effort-unit → days conversion as GET /:id/schedule.
    const unitsPerDay = data.map.effortUnit === 'hours' ? (data.map.hoursPerDay ?? 8) : 1;

    const now = new Date();

    // ── Active-lane default scope ─────────────────────────────
    // Unscoped lint over a mature map is background noise (900+
    // standing warnings on the primary map — nobody reads them). When
    // the caller names NO scope, default to the map's active release
    // lane: the work that is actually being dispatched is the work
    // whose hygiene matters right now. `scope=all` restores the
    // whole-map run; any explicit nodeId/versionId/cycleId wins.
    let effectiveVersionId = req.query.versionId;
    let defaultedToLane: { id: string; name: string } | null = null;
    if (
      !req.query.nodeId &&
      !req.query.versionId &&
      !req.query.cycleId &&
      req.query.scope !== 'all'
    ) {
      const lane = pickActiveLane(await versionDb.listVersions(req.params.id));
      if (lane) {
        effectiveVersionId = lane.id;
        defaultedToLane = { id: lane.id, name: lane.name };
      }
    }

    // The forge check spends real API budget, so it only sees the nodes
    // the report will show (same scope resolution as the engine) and only
    // runs when its rule is part of the answer.
    const scoped = scopeLeaves(data.nodes, {
      nodeId: req.query.nodeId,
      versionId: effectiveVersionId,
      cycleId: req.query.cycleId,
    });
    if ('error' in scoped) {
      return reply.status(404).send({ error: { code: 'NODE_NOT_FOUND', message: scoped.error } });
    }
    const wantsForge = rule == null || rule === 'done-without-pr';

    const [history, dismissalRows, acceptances, forge] = await Promise.all([
      loadHistory(req.params.id, now),
      lintDb.listDismissals(req.params.id),
      // Best-effort: a failed acceptance load skips stale-acceptance
      // (reported as such) instead of failing the whole lint run.
      listActiveAcceptances(req.params.id).catch(() => undefined),
      // Same contract for the forge: unreachable → done-without-pr skipped.
      wantsForge
        ? loadForgePrs(
            req.params.id,
            scoped.scopedNodes,
            buildDonePredicate(data.map.statusWorkflow),
            now,
          ).catch(() => undefined)
        : Promise.resolve(undefined),
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
      nodeId: req.query.nodeId,
      versionId: effectiveVersionId,
      cycleId: req.query.cycleId,
      stalledDays,
      now,
    });
    if ('error' in report) {
      return reply.status(404).send({ error: { code: 'NODE_NOT_FOUND', message: report.error } });
    }
    if (defaultedToLane) {
      // Machine consumers read report.scope; the label is for humans.
      // The escape-hatch hint is composed per surface (the MCP tool
      // phrases it in its own parameter syntax), not baked in here.
      report.scope.defaultedToLane = true;
      report.scope.versionName = defaultedToLane.name;
      report.scopeLabel = `${defaultedToLane.name} (active lane — default)`;
    }

    if (rule) {
      const filtered = report.rules.filter((r) => r.ruleId === rule);
      return reply.send({
        ...report,
        rules: filtered,
        warnCount: filtered.filter((r) => r.severity === 'warn').reduce((s, r) => s + r.activeCount, 0),
        infoCount: filtered.filter((r) => r.severity === 'info').reduce((s, r) => s + r.activeCount, 0),
      });
    }
    return reply.send(report);
  });

  // ── POST /api/maps/:id/lint/dismissals ─────────────────────────
  // Body: { ruleId, nodeId? } — nodeId omitted/null mutes the rule
  // map-wide. Idempotent: re-dismissing returns the existing row.
  app.post<{
    Params: { id: string };
    Body: { ruleId?: unknown; nodeId?: unknown };
  }>('/api/maps/:id/lint/dismissals', async (req, reply) => {
    const userId = req.userId;
    if (!(await requireMapAccess(req, reply, req.params.id, 'edit'))) return reply;

    const ruleId = req.body?.ruleId;
    const nodeId = req.body?.nodeId ?? null;
    if (typeof ruleId !== 'string' || !LINT_RULE_IDS.includes(ruleId as LintRuleId)) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: `ruleId must be one of: ${LINT_RULE_IDS.join(', ')}` },
      });
    }
    if (nodeId != null && typeof nodeId !== 'string') {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'nodeId must be a string or omitted' },
      });
    }

    const { row, created } = await lintDb.upsertDismissal(
      req.params.id,
      ruleId,
      nodeId as string | null,
      userId ?? null,
    );
    return reply.status(created ? 201 : 200).send(row);
  });

  // ── POST /api/maps/:id/lint/fix ────────────────────────────────
  // Body: { ruleId, nodeId, action, note? } — the action must be one the
  // rule offers (engine LINT_FIX_ACTIONS), so a stale panel cannot apply
  // a fix the current finding would not show.
  app.post<{
    Params: { id: string };
    Body: { ruleId?: unknown; nodeId?: unknown; action?: unknown; note?: unknown };
  }>('/api/maps/:id/lint/fix', async (req, reply) => {
    if (!(await requireMapAccess(req, reply, req.params.id, 'edit'))) return reply;

    const { ruleId, nodeId, action, note } = req.body ?? {};
    if (typeof ruleId !== 'string' || !LINT_RULE_IDS.includes(ruleId as LintRuleId)) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: `ruleId must be one of: ${LINT_RULE_IDS.join(', ')}` },
      });
    }
    if (typeof nodeId !== 'string' || nodeId === '') {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'nodeId is required' },
      });
    }
    const allowed = LINT_FIX_ACTIONS[ruleId as LintRuleId] ?? [];
    if (typeof action !== 'string' || !allowed.includes(action as LintActionId)) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message:
            allowed.length > 0
              ? `action for ${ruleId} must be one of: ${allowed.join(', ')}`
              : `${ruleId} offers no automatic fix`,
        },
      });
    }
    if (note != null && typeof note !== 'string') {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'note must be a string' },
      });
    }

    try {
      const outcome = await applyLintFix(req.params.id, nodeId, action as LintActionId, req.userId ?? null, {
        note: note as string | undefined,
      });
      return reply.send(outcome);
    } catch (err) {
      if (err instanceof LintFixError) {
        const status = err.code === 'NODE_NOT_FOUND' ? 404 : err.code === 'BAD_ACTION' ? 400 : 409;
        return reply.status(status).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  // ── DELETE /api/maps/:id/lint/dismissals?ruleId=…&nodeId=… ─────
  // nodeId omitted = undo the map-wide rule mute.
  app.delete<{
    Params: { id: string };
    Querystring: { ruleId?: string; nodeId?: string };
  }>('/api/maps/:id/lint/dismissals', async (req, reply) => {
    const userId = req.userId;
    if (!(await requireMapAccess(req, reply, req.params.id, 'edit'))) return reply;

    const { ruleId, nodeId } = req.query;
    if (!ruleId) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'ruleId query parameter is required' },
      });
    }
    await lintDb.deleteDismissal(req.params.id, ruleId, nodeId ?? null);
    return reply.status(204).send();
  });
}
