/**
 * Plan-lint routes — the REST surface behind the plan-health panel and
 * the plan_lint MCP tool (docs/plan-linter.md).
 *
 *   GET    /api/maps/:id/lint              — run the linter, structured report
 *   POST   /api/maps/:id/lint/dismissals   — dismiss a finding / mute a rule
 *   DELETE /api/maps/:id/lint/dismissals   — undo a dismissal (querystring)
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
import {
  computePlanLint,
  CLAIM_CHURN_HOURS,
  LINT_RULE_IDS,
  REPLAN_LOOKBACK_DAYS,
  STALE_PLAN_DAYS,
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

/**
 * done-without-pr input: for the most recent done nodes that carry a forge
 * link, ask the forge which pull requests reference the issue. Returns
 * undefined (rule skipped) when the map has no forge or the lookups fail
 * or time out — a slow forge must not hold the whole lint run hostage.
 */
async function loadForgePrs(
  mapId: string,
  nodes: Node[],
  doneIds: Set<string>,
): Promise<{ forgePrs: Map<string, number[]>; capped: boolean } | undefined> {
  const candidates = nodes
    .filter((n) => n.status != null && doneIds.has(n.status))
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

  const checked = candidates.slice(0, FORGE_PR_CHECK_CAP);
  const lookups = Promise.all(
    checked.map(async ({ n, link }) => {
      // externalId is "owner/repo#N"; only issues on the bound repo are ours to ask about.
      const m = /^(.+)\/(.+)#(\d+)$/.exec(link.externalId);
      if (!m || m[1] !== ctx!.owner || m[2] !== ctx!.repo) return null;
      const prs = await ctx!.forge.listCrossReferencingPullRequests(m[1], m[2], Number(m[3]));
      return [n.id, prs] as const;
    }),
  );
  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), FORGE_PR_CHECK_TIMEOUT_MS).unref?.(),
  );
  try {
    const result = await Promise.race([lookups, timeout]);
    if (result === 'timeout') return undefined;
    const forgePrs = new Map<string, number[]>();
    for (const r of result) if (r) forgePrs.set(r[0], [...r[1]]);
    return { forgePrs, capped: candidates.length > checked.length };
  } catch {
    return undefined;
  }
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
    const doneStatusIds = new Set(
      (data.map.statusWorkflow ?? []).filter((s) => s.category === 'done').map((s) => s.id),
    );
    const [history, dismissalRows, acceptances, forge] = await Promise.all([
      loadHistory(req.params.id, now),
      lintDb.listDismissals(req.params.id),
      // Best-effort: a failed acceptance load skips stale-acceptance
      // (reported as such) instead of failing the whole lint run.
      listActiveAcceptances(req.params.id).catch(() => undefined),
      // Same contract for the forge: unreachable → done-without-pr skipped.
      loadForgePrs(req.params.id, data.nodes, doneStatusIds).catch(() => undefined),
    ]);

    // Rolled-up progress so requirement rules work on parent nodes too.
    const computed = computeTree(data.nodes, data.map.healthThreshold);
    const computedProgress = new Map<string, number>();
    for (const [id, cv] of computed) computedProgress.set(id, cv.computedProgress);

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
