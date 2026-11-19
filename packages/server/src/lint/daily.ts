/**
 * The daily self-check (docs/plan-linter.md, "Daily self-check"): once a
 * day — and on demand — plan_lint (scope all) runs on every active map,
 * and each finding is handled the way its rule declares it (core
 * LINT_DAILY):
 *
 *   auto   — the safe case gets its fix through plan_fix's write path
 *            (applyLintFix: change history, claim trail, broadcast,
 *            outbound sync); anything else, or the map's `lintAutoFix`
 *            off for the rule, becomes an ask.
 *   ask    — a lint-<rule>-<node> row on the map's Questions card
 *            (services/derivedAsks.ts reads it from the newest run).
 *   digest — a count; one line per map in the daily mail.
 *
 * Each run is stored per map and local day (db/lintRuns.ts): the fixes
 * applied, the asks, the counts. A finding that stays from one run to the
 * next keeps its first-seen time, so its ask is the same row, not a new one.
 */
import {
  isForgeLink,
  isOrphanRequeueable,
  LINT_DAILY,
  lintAutoFixOn,
  lintDailyOptedIn,
  STALLED_ASK_AFTER_HOURS,
  WORKER_WAIT_NOTE,
  type LintActionId,
  type LintRun,
  type LintRunFix,
  type LintRuleId,
  type Node,
  type StalledLeaf,
} from '@mindblown/core';
import * as mapDb from '../db/maps.js';
import * as lintRunsDb from '../db/lintRuns.js';
import { applyLintFix } from './fix.js';
import { buildDonePredicate, type LintFinding, type LintRuleReport } from './engine.js';
import { buildLintReport } from './report.js';

const HOUR_MS = 3_600_000;

export interface DailyLintConfig {
  /** Local hour (0–23) from which the day's run starts — before the daily mail. null = scheduled run off. */
  hour: number | null;
  timeZone: string;
}

/**
 * LINT_DAILY_HOUR (default 6) in DIGEST_MAIL_TZ (default Europe/Zurich): the
 * run lands before the 08:00 mail. LINT_DAILY_HOUR=off switches the
 * scheduled run off (on-demand runs still work).
 */
export function dailyLintConfig(env: NodeJS.ProcessEnv = process.env): DailyLintConfig {
  const raw = (env.LINT_DAILY_HOUR ?? '').trim().toLowerCase();
  const hour = Number.parseInt(raw, 10);
  return {
    hour: raw === 'off' ? null : Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 6,
    timeZone: env.DIGEST_MAIL_TZ || 'Europe/Zurich',
  };
}

/** The node has a merged pull request on record (the webhook's stamp, or the linked-PR mirror). */
export function hasMergedPr(node: Pick<Node, 'externalLinks' | 'linkedPr'>): boolean {
  return (
    (node.externalLinks ?? []).some((l) => isForgeLink(l) && typeof l.mergedPrNumber === 'number') ||
    node.linkedPr?.state === 'merged'
  );
}

/**
 * The safe fix for a finding of an `auto` rule, or 'ask' when it is not the
 * safe case, or null when it should simply wait for the next run.
 *
 *   stale-blocked-reason      the blocker is a fleet worker's own note → clear-blocker
 *   status-progress-mismatch  a done leaf below 100 % → mark-done
 *   stalled-unclaimed         a merged PR → mark-done; a worker's orphan idle
 *                             24 h → requeue; a person's (never claimed, a
 *                             "Decision:" ticket) idle 24 h → ask; else wait
 */
export function autoAction(
  ruleId: LintRuleId,
  node: Node,
  ctx: { isDone: (status: string | null) => boolean; stalled?: StalledLeaf; now: Date },
): LintActionId | 'ask' | null {
  const leaf = (node.childrenIds?.length ?? 0) === 0;
  switch (ruleId) {
    case 'stale-blocked-reason':
      return WORKER_WAIT_NOTE.test(node.blockedReason ?? '') ? 'clear-blocker' : 'ask';
    case 'status-progress-mismatch':
      return leaf && ctx.isDone(node.status) && (node.percentComplete ?? 0) < 100 ? 'mark-done' : 'ask';
    case 'stalled-unclaimed': {
      if (hasMergedPr(node)) return 'mark-done';
      const s = ctx.stalled;
      if (!s || ctx.now.getTime() - Date.parse(s.lastChangeAt) < STALLED_ASK_AFTER_HOURS * HOUR_MS) return null;
      return isOrphanRequeueable(s, node.text) ? 'requeue' : 'ask';
    }
    default:
      return 'ask';
  }
}

export interface DailyLintOptions {
  now?: Date;
  /** Local calendar day the run is filed under (YYYY-MM-DD). */
  day: string;
}

/**
 * One map's run. Archived maps are skipped (null). The run is stored, and
 * returned with the map's name.
 */
export async function runDailyLintForMap(mapId: string, opts: DailyLintOptions): Promise<LintRun | null> {
  const now = opts.now ?? new Date();
  const data = await mapDb.getMap(mapId);
  if (!data || data.map.archivedAt) return null;
  const run: LintRun = { mapId, mapName: data.map.name, day: opts.day, ranAt: now.toISOString(), fixed: [], asked: [], digest: {}, error: null };

  let previous: LintRun | undefined;
  try {
    previous = (await lintRunsDb.latestRuns([mapId])).get(mapId);
    // The map's owner decides which other maps misfiled-repo can see.
    const built = await buildLintReport(data, { scope: 'all' }, data.map.createdBy, now);
    if ('error' in built) throw new Error(built.error);
    const { report, stalled } = built;

    const firstSeen = new Map((previous?.asked ?? []).map((a) => [`${a.ruleId}|${a.nodeId}`, a.firstSeenAt]));
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const stalledById = new Map((stalled ?? []).map((s) => [s.nodeId, s]));
    const isDone = buildDonePredicate(data.map.statusWorkflow);
    const rootId = data.map.rootNodeId;

    const ask = ({ ruleId, title }: LintRuleReport, f: LintFinding) => {
      const nodeId = f.nodeId ?? rootId;
      if (!nodeId) return;
      run.asked.push({
        ruleId,
        nodeId,
        nodeText: f.nodeText ?? data.map.name,
        title,
        detail: f.detail,
        actions: (f.actions ?? []).map((a) => a.id),
        firstSeenAt: firstSeen.get(`${ruleId}|${nodeId}`) ?? now.toISOString(),
      });
    };

    for (const rule of report.rules) {
      if (rule.ruleMuted || rule.skipped) continue;
      const active = rule.findings.filter((f) => !f.dismissed);
      if (active.length === 0) continue;
      const { handling } = LINT_DAILY[rule.ruleId];
      if (handling === 'off') continue;
      if (handling === 'digest') {
        run.digest[rule.ruleId] = active.length;
        continue;
      }
      for (const f of active) {
        if (handling === 'ask') {
          ask(rule, f);
          continue;
        }
        const node = f.nodeId ? byId.get(f.nodeId) : undefined;
        if (!node) continue;
        const action = autoAction(rule.ruleId, node, { isDone, stalled: stalledById.get(node.id), now });
        if (action === null) continue;
        if (action === 'ask' || !lintAutoFixOn(data.map.lintAutoFix, rule.ruleId)) {
          ask(rule, f);
          continue;
        }
        const fix: LintRunFix = { ruleId: rule.ruleId, nodeId: node.id, nodeText: node.text, action, ok: false };
        try {
          await applyLintFix(mapId, node.id, action, null);
          fix.ok = true;
        } catch (err) {
          fix.error = err instanceof Error ? err.message : String(err);
          ask(rule, f);
        }
        run.fixed.push(fix);
      }
    }
  } catch (err) {
    run.error = err instanceof Error ? err.message : String(err);
    // A failed run must not empty the Questions card: the last asks stay until a run succeeds.
    run.asked = previous?.asked ?? [];
  }

  const { mapName: _name, ...stored } = run;
  await lintRunsDb.saveRun(stored);
  return run;
}

export interface DailyLintResult {
  day: string;
  runs: LintRun[];
}

/**
 * Every active map that opted in (lintDailyOptedIn) and is not yet checked
 * on `day` (or every one with `force`). Named `mapIds` are run whether
 * opted in or not — someone asked for them. One map's failure is recorded
 * on its run and does not stop the others.
 */
export async function runDailyLint(opts: DailyLintOptions & { force?: boolean; mapIds?: string[] }): Promise<DailyLintResult> {
  const maps = (await mapDb.listMaps()).filter(
    (m) => !m.archivedAt && (opts.mapIds ? opts.mapIds.includes(m.id) : lintDailyOptedIn(m.lintAutoFix)),
  );
  const runs: LintRun[] = [];
  for (const m of maps) {
    if (!opts.force && (await lintRunsDb.hasRun(m.id, opts.day))) continue;
    const r = await runDailyLintForMap(m.id, opts).catch((err): LintRun => ({
      mapId: m.id,
      mapName: m.name,
      day: opts.day,
      ranAt: (opts.now ?? new Date()).toISOString(),
      fixed: [],
      asked: [],
      digest: {},
      error: err instanceof Error ? err.message : String(err),
    }));
    if (r) runs.push(r);
  }
  return { day: opts.day, runs };
}
