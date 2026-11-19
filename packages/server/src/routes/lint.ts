/**
 * Plan-lint routes — the REST surface behind the plan-health panel and
 * the plan_lint MCP tool (docs/plan-linter.md).
 *
 *   GET    /api/maps/:id/lint              — run the linter, structured report
 *   POST   /api/maps/:id/lint/dismissals   — dismiss a finding / mute a rule
 *   DELETE /api/maps/:id/lint/dismissals   — undo a dismissal (querystring)
 *   POST   /api/maps/:id/lint/fix          — apply one fix a finding offers
 *   GET    /api/maps/:id/lint/runs         — the daily self-check's runs of this map
 *   POST   /api/maps/:id/lint/runs         — run the daily self-check on this map now
 *   GET    /api/lint/runs                  — the runs of every map the caller can view
 *
 * The engine itself is pure (../lint/engine.ts); ../lint/report.ts supplies
 * its data (change-event digests, dismissals, forge checks …), shared with
 * the daily self-check (../lint/daily.ts, routes/lintRuns.ts).
 */
import type { FastifyInstance } from 'fastify';
import { computeTree } from '@mindblown/core';
import { requireMapAccess } from '../lib/mapAccess.js';
import * as mapDb from '../db/maps.js';
import * as lintDb from '../db/lint.js';
import { stalledForMap } from '../lib/stalled.js';
import { applyLintFix, LintFixError } from '../lint/fix.js';
import { buildLintReport } from '../lint/report.js';
import { runDailyLintForMap, dailyLintConfig } from '../lint/daily.js';
import * as lintRunsDb from '../db/lintRuns.js';
import { localDay } from '../lib/localDay.js';
import { MoveToMapError } from '../services/moveToMap.js';
import {
  computePlanLint,
  LINT_FIX_ACTIONS,
  LINT_RULE_IDS,
  type LintActionId,
  type LintRuleId,
} from '../lint/engine.js';

export { FORGE_PR_CHECK_CAP, resetForgePrCache } from '../lint/report.js';

/** Rules whose findings depend on the map alone, so a fix can re-verify them first. */
const RECHECKED_RULES = new Set<LintRuleId>([
  'status-progress-mismatch',
  'done-parent-open-child',
  'issue-state-mismatch',
  'stale-blocked-reason',
]);

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

    const built = await buildLintReport(
      data,
      { nodeId: req.query.nodeId, versionId: req.query.versionId, cycleId: req.query.cycleId, stalledDays, rule, scope: req.query.scope },
      userId,
    );
    if ('error' in built) {
      return reply.status(404).send({ error: { code: 'NODE_NOT_FOUND', message: built.error } });
    }
    const { report } = built;

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

    // A stale panel must not apply a fix the CURRENT finding would not
    // offer. The rules that need only the map are recomputed for this
    // node right now; done-without-pr and claim-churn are not (their
    // actions — park, reopen — are safe against a vanished finding).
    if (RECHECKED_RULES.has(ruleId as LintRuleId)) {
      const data = await mapDb.getMap(req.params.id);
      if (!data) {
        return reply.status(404).send({
          error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.id} not found` },
        });
      }
      const computed = computeTree(data.nodes, data.map.healthThreshold);
      const computedProgress = new Map<string, number>();
      for (const [id, cv] of computed) computedProgress.set(id, cv.computedProgress);
      const current = computePlanLint({
        map: data.map,
        nodes: data.nodes,
        unitsPerDay: 1,
        history: { ok: false, lastProgressChange: new Map(), replanEvents: new Map(), anyRecentEvent: false },
        dismissals: [],
        computedProgress,
      });
      const found =
        'error' in current
          ? undefined
          : current.rules.find((r) => r.ruleId === ruleId)?.findings.find((f) => f.nodeId === nodeId);
      if (!found || !found.actions?.some((a) => a.id === action)) {
        return reply.status(409).send({
          error: {
            code: 'STALE_FINDING',
            message: 'That finding no longer applies to the node as it is now — re-run the checks.',
          },
        });
      }
    }
    // stalled-unclaimed needs the change log, so it is re-checked through
    // the same stalledForMap: every fix drops a claim taken since, and
    // mark-done would close a node somebody picked up again.
    if (ruleId === 'stalled-unclaimed') {
      const data = await mapDb.getMap(req.params.id);
      if (!data) {
        return reply.status(404).send({
          error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.id} not found` },
        });
      }
      const stalled = await stalledForMap(data.map, data.nodes).catch(() => []);
      if (!stalled.some((s) => s.nodeId === nodeId)) {
        return reply.status(409).send({
          error: {
            code: 'STALE_FINDING',
            message: 'That node is no longer stalled (claimed, changed, blocked or finished since) — re-run the checks.',
          },
        });
      }
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
      if (err instanceof MoveToMapError) {
        return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
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

  // ── Daily self-check runs (lint/daily.ts) ──────────────────────
  // ?days=N (default 7, max 90): runs from N-1 days ago on, newest first.
  const sinceDay = (daysRaw: string | undefined): string | { error: string } => {
    const days = daysRaw == null ? 7 : Number(daysRaw);
    if (!Number.isInteger(days) || days < 1 || days > 90) return { error: 'days must be an integer from 1 to 90' };
    return localDay(new Date(Date.now() - (days - 1) * 86_400_000), dailyLintConfig().timeZone);
  };

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>('/api/maps/:id/lint/runs', async (req, reply) => {
    if (!(await requireMapAccess(req, reply, req.params.id, 'view'))) return reply;
    const since = sinceDay(req.query.days);
    if (typeof since !== 'string') return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: since.error } });
    return reply.send({ runs: await lintRunsDb.listRuns([req.params.id], since) });
  });

  // Run it now — same run as the nightly one, filed under today (replaces
  // today's row). Edit: it applies the safe fixes.
  app.post<{ Params: { id: string } }>('/api/maps/:id/lint/runs', async (req, reply) => {
    if (!(await requireMapAccess(req, reply, req.params.id, 'edit'))) return reply;
    const now = new Date();
    const run = await runDailyLintForMap(req.params.id, { now, day: localDay(now, dailyLintConfig().timeZone) });
    if (!run) {
      return reply.status(409).send({ error: { code: 'MAP_ARCHIVED', message: 'The map is archived or gone — the daily check skips it' } });
    }
    return reply.send(run);
  });

  app.get<{ Querystring: { days?: string } }>('/api/lint/runs', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    const since = sinceDay(req.query.days);
    if (typeof since !== 'string') return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: since.error } });
    const maps = await mapDb.listMapsForUser(req.userId);
    return reply.send({ runs: await lintRunsDb.listRuns(maps.map((m) => m.id), since) });
  });
}
