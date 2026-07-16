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
import * as mapDb from '../db/maps.js';
import * as permDb from '../db/permissions.js';
import * as lintDb from '../db/lint.js';
import { listEvents } from '../db/events.js';
import {
  computePlanLint,
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
    const [progress, due, start, est, recent] = await Promise.all([
      listEvents({ mapId, fieldName: 'percentComplete', since: replanSince, limit: 1000 }),
      listEvents({ mapId, fieldName: 'dueDate', since: replanSince, limit: 1000 }),
      listEvents({ mapId, fieldName: 'startDate', since: replanSince, limit: 1000 }),
      listEvents({ mapId, fieldName: 'effortEstimate', since: replanSince, limit: 1000 }),
      listEvents({ mapId, since: staleSince, limit: 1 }),
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
    return { ok: true, lastProgressChange, replanEvents, anyRecentEvent: recent.length > 0 };
  } catch {
    return { ok: false, lastProgressChange: new Map(), replanEvents: new Map(), anyRecentEvent: false };
  }
}

export async function lintRoutes(app: FastifyInstance) {
  // ── GET /api/maps/:id/lint ─────────────────────────────────────
  app.get<{
    Params: { id: string };
    Querystring: { nodeId?: string; versionId?: string; stalledDays?: string; rule?: string };
  }>('/api/maps/:id/lint', async (req, reply) => {
    const userId = req.userId;
    if (userId) {
      const perm = await permDb.getPermission(req.params.id, userId);
      if (!permDb.hasPermission(perm, 'view')) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'You do not have access to this map' },
        });
      }
    }

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
    const [history, dismissalRows] = await Promise.all([
      loadHistory(req.params.id, now),
      lintDb.listDismissals(req.params.id),
    ]);

    const report = computePlanLint({
      map: data.map,
      nodes: data.nodes,
      unitsPerDay,
      history,
      dismissals: dismissalRows.map((d) => ({ nodeId: d.nodeId, ruleId: d.ruleId })),
      nodeId: req.query.nodeId,
      versionId: req.query.versionId,
      stalledDays,
      now,
    });
    if ('error' in report) {
      return reply.status(404).send({ error: { code: 'NODE_NOT_FOUND', message: report.error } });
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
    if (userId) {
      const perm = await permDb.getPermission(req.params.id, userId);
      if (!permDb.hasPermission(perm, 'edit')) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'Edit permission required' },
        });
      }
    }

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
    if (userId) {
      const perm = await permDb.getPermission(req.params.id, userId);
      if (!permDb.hasPermission(perm, 'edit')) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'Edit permission required' },
        });
      }
    }

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
