/**
 * Plan-lint engine — the 8 plan-quality checks behind the plan_lint MCP
 * tool and the mindmap plan-health panel (docs/plan-linter.md).
 *
 * Pure function: callers supply nodes, change-history digests, and
 * dismissals; no DB or clock access in here (`now` is a parameter).
 * Thresholds are opinionated defaults, deliberately not configurable.
 */
import type { Node } from '@mindblown/core';

export const LINT_RULE_IDS = [
  'unestimated-leaf',
  'oversized-leaf',
  'stale-progress',
  'overdue-unreplanned',
  'calibration-drift',
  'no-done-criteria',
  'stale-plan',
  'dates-without-dependencies',
  // Requirements pack — evaluated map-wide (the register is map-global).
  'uncovered-requirement',
  'stale-acceptance',
  'unscheduled-must',
] as const;
export type LintRuleId = (typeof LINT_RULE_IDS)[number];
export type LintSeverity = 'warn' | 'info';

export interface LintFinding {
  nodeId: string | null; // null for map-level findings
  nodeText: string | null;
  priority: string | null;
  detail: string;
  dismissed: boolean;
}

export interface LintRuleReport {
  ruleId: LintRuleId;
  severity: LintSeverity;
  title: string;
  why: string;
  fix: string;
  findings: LintFinding[];
  activeCount: number; // findings not dismissed
  dismissedCount: number;
  ruleMuted: boolean; // map-level mute (dismissal with nodeId = null)
  skipped?: string; // set when the rule couldn't run (e.g. no change history)
}

export interface LintReport {
  scopeLabel: string;
  warnCount: number; // active warn findings across rules
  infoCount: number; // active info findings across rules
  rules: LintRuleReport[];
}

/** Digest of change_events the history-backed rules need. */
export interface LintHistory {
  ok: boolean;
  /** nodeId → ISO timestamp of the latest percentComplete change. */
  lastProgressChange: Map<string, string>;
  /** nodeId → ISO timestamps of dueDate/startDate/effortEstimate changes. */
  replanEvents: Map<string, string[]>;
  /** Whether ANY change event exists in the stale-plan window. */
  anyRecentEvent: boolean;
}

export interface LintDismissal {
  nodeId: string | null; // null = mute the whole rule on this map
  ruleId: string;
}

/** Active requirement sign-off (see db/acceptances.ts) for stale-acceptance. */
export interface AcceptanceInfo {
  nodeId: string;
  userName: string;
  acceptedAt: string;
  progressAtAcceptance: number;
  nodeRevisionAtAcceptance: number;
  /** Which gate went stale. Absent on pre-split rows, which were business. */
  gate?: 'it' | 'business';
}

export interface LintOptions {
  map: {
    statusWorkflow?: Array<{ id: string; category: string }> | null;
    effortUnit?: string | null;
  };
  nodes: Node[];
  unitsPerDay: number;
  history: LintHistory;
  dismissals: LintDismissal[];
  /** Active acceptances; omit to skip the stale-acceptance rule. */
  acceptances?: AcceptanceInfo[];
  /** Rolled-up progress per node (core computeTree); enables requirement rules on parent nodes. */
  computedProgress?: Map<string, number>;
  nodeId?: string;
  versionId?: string;
  cycleId?: string;
  stalledDays?: number;
  now?: Date;
}

// Opinionated defaults (docs/plan-linter.md — not configuration).
const OVERSIZED_DAYS = 5;
const OVERSIZED_MAP_SHARE = 0.15;
const OVERSIZED_SHARE_MIN_LEAVES = 8;
const DONE_CRITERIA_MIN_DAYS = 2;
export const STALE_PLAN_DAYS = 14;
const MIN_CALIBRATION_SAMPLES = 5;
const CALIBRATION_LOW = 0.8;
const CALIBRATION_HIGH = 1.25;
const MIN_DATED_LEAVES_FOR_DEPS = 10;
export const REPLAN_LOOKBACK_DAYS = 90;
export const DEFAULT_STALLED_DAYS = 7;

const isLeaf = (n: Node) => (n.childrenIds?.length ?? 0) === 0;

/** Subtree + inherited version/cycle scoping (same semantics as the MI suite). */
function scopeLeaves(
  nodes: Node[],
  opts: { nodeId?: string; versionId?: string; cycleId?: string },
): { leaves: Node[]; scopeLabel: string } | { error: string } {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  let leaves: Node[];
  let scopeLabel = 'whole map';

  if (opts.nodeId) {
    const root = nodeById.get(opts.nodeId);
    if (!root) return { error: `Node ${opts.nodeId} not found` };
    scopeLabel = `subtree of "${root.text}" (${opts.nodeId})`;
    leaves = [];
    const stack = [root];
    while (stack.length) {
      const n = stack.pop()!;
      if (isLeaf(n)) leaves.push(n);
      else for (const cid of n.childrenIds) {
        const c = nodeById.get(cid);
        if (c) stack.push(c);
      }
    }
  } else {
    leaves = nodes.filter(isLeaf);
  }

  // A leaf is in scope when it OR any ancestor carries the tag.
  const inheritsTag = (leaf: Node, field: 'versionId' | 'cycleId', value: string): boolean => {
    let cur: Node | undefined = leaf;
    while (cur) {
      if (cur[field] === value) return true;
      cur = cur.parentId ? nodeById.get(cur.parentId) : undefined;
    }
    return false;
  };

  if (opts.versionId) {
    scopeLabel = `version ${opts.versionId}` + (opts.nodeId ? ` within ${scopeLabel}` : '');
    leaves = leaves.filter((l) => inheritsTag(l, 'versionId', opts.versionId!));
  }
  if (opts.cycleId) {
    scopeLabel = `sprint ${opts.cycleId} within ${scopeLabel}`;
    leaves = leaves.filter((l) => inheritsTag(l, 'cycleId', opts.cycleId!));
  }

  return { leaves, scopeLabel };
}

export function computePlanLint(opts: LintOptions): LintReport | { error: string } {
  const { map, nodes, unitsPerDay, history, dismissals } = opts;
  const stalledDays = opts.stalledDays ?? DEFAULT_STALLED_DAYS;
  const now = opts.now ?? new Date();

  const scoped = scopeLeaves(nodes, {
    nodeId: opts.nodeId,
    versionId: opts.versionId,
    cycleId: opts.cycleId,
  });
  if ('error' in scoped) return { error: scoped.error };
  const { leaves, scopeLabel } = scoped;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const progressOf = (n: Node): number =>
    opts.computedProgress?.get(n.id) ?? n.percentComplete ?? 0;

  const unit = map.effortUnit ?? 'units';
  const incomplete = leaves.filter((l) => (l.percentComplete ?? 0) < 100);
  const totalEffort = leaves.reduce((s, l) => s + (l.effortEstimate ?? 0), 0);

  const inProgressStatusIds = new Set(
    (map.statusWorkflow ?? []).filter((s) => s.category === 'in_progress').map((s) => s.id),
  );
  const isInProgress = (n: Node) =>
    (n.status != null && inProgressStatusIds.has(n.status)) ||
    ((n.percentComplete ?? 0) > 0 && (n.percentComplete ?? 0) < 100);

  const finding = (n: Node, detail: string): LintFinding => ({
    nodeId: n.id,
    nodeText: n.text,
    priority: n.priority ?? null,
    detail,
    dismissed: false,
  });
  const mapFinding = (detail: string): LintFinding => ({
    nodeId: null,
    nodeText: null,
    priority: null,
    detail,
    dismissed: false,
  });

  type RawRule = Omit<LintRuleReport, 'activeCount' | 'dismissedCount' | 'ruleMuted'>;
  const rules: RawRule[] = [];

  // 1. unestimated-leaf
  rules.push({
    ruleId: 'unestimated-leaf',
    severity: 'warn',
    title: 'Leaves without an effort estimate',
    why: 'Unestimated work is invisible to the forecast — your finish date is under-counting.',
    fix: 'Set an estimate on each; the AI estimator can draft one.',
    findings: incomplete.filter((l) => l.effortEstimate == null).map((l) => finding(l, 'no estimate')),
  });

  // 2. oversized-leaf
  const oversizedAbs = OVERSIZED_DAYS * unitsPerDay;
  const shareRuleActive = totalEffort > 0 && leaves.length >= OVERSIZED_SHARE_MIN_LEAVES;
  rules.push({
    ruleId: 'oversized-leaf',
    severity: 'warn',
    title: `Oversized leaves (> ${OVERSIZED_DAYS} days${shareRuleActive ? ` or > ${OVERSIZED_MAP_SHARE * 100}% of the plan` : ''})`,
    why: 'Small pieces get estimated far more accurately — projects built from small chunks succeed dramatically more often.',
    fix: 'Split it into smaller children; the AI breakdown can suggest a split.',
    findings: incomplete
      .filter(
        (l) =>
          l.effortEstimate != null &&
          (l.effortEstimate > oversizedAbs ||
            (shareRuleActive && l.effortEstimate > OVERSIZED_MAP_SHARE * totalEffort)),
      )
      .sort((a, b) => (b.effortEstimate ?? 0) - (a.effortEstimate ?? 0))
      .map((l) => finding(l, `${l.effortEstimate} ${unit}`)),
  });

  // 3. stale-progress
  const staleCutoff = now.getTime() - stalledDays * 86_400_000;
  rules.push({
    ruleId: 'stale-progress',
    severity: 'warn',
    title: `In-progress work with no progress update in ${stalledDays}+ days`,
    why: 'A task that stops moving is usually stuck, not slow — surface it before it slips the schedule.',
    fix: 'Update its % complete, or flag what blocks it.',
    findings: history.ok
      ? incomplete
          .filter((l) => {
            if (!isInProgress(l)) return false;
            const last = history.lastProgressChange.get(l.id);
            return last == null || new Date(last).getTime() < staleCutoff;
          })
          .map((l) => {
            const last = history.lastProgressChange.get(l.id);
            return finding(
              l,
              last
                ? `${l.percentComplete ?? 0}%, last progress change ${last.slice(0, 10)}`
                : `${l.percentComplete ?? 0}%, no progress change on record`,
            );
          })
      : [],
    skipped: history.ok ? undefined : 'change history unavailable',
  });

  // 4. overdue-unreplanned
  const todayIso = now.toISOString().slice(0, 10);
  rules.push({
    ruleId: 'overdue-unreplanned',
    severity: 'warn',
    title: 'Overdue leaves never re-planned',
    why: 'Plans only work if they are amended when reality diverges — an ignored overdue date makes every downstream date fiction.',
    fix: 'Re-plan it: move the due date, split the remainder, or descope.',
    findings: history.ok
      ? incomplete
          .filter((l) => {
            if (!l.dueDate || l.dueDate.slice(0, 10) >= todayIso) return false;
            const evs = history.replanEvents.get(l.id) ?? [];
            return !evs.some((ts) => ts > l.dueDate!);
          })
          .map((l) => finding(l, `due ${l.dueDate!.slice(0, 10)}, ${l.percentComplete ?? 0}%`))
      : [],
    skipped: history.ok ? undefined : 'change history unavailable',
  });

  // 5. calibration-drift (map-level — always evaluated on the whole map)
  const calibrationLeaves = nodes.filter(
    (n) => isLeaf(n) && n.effortEstimate != null && n.actualEffort != null,
  );
  const calibEstimate = calibrationLeaves.reduce((s, n) => s + (n.effortEstimate ?? 0), 0);
  const calibActual = calibrationLeaves.reduce((s, n) => s + (n.actualEffort ?? 0), 0);
  const fudge = calibEstimate > 0 ? calibActual / calibEstimate : null;
  const drifted =
    fudge != null &&
    calibrationLeaves.length >= MIN_CALIBRATION_SAMPLES &&
    (fudge < CALIBRATION_LOW || fudge > CALIBRATION_HIGH);
  rules.push({
    ruleId: 'calibration-drift',
    severity: 'info',
    title: 'Estimation calibration drift (map-level)',
    why:
      fudge != null
        ? `Your estimates historically run ${fudge.toFixed(2)}× — the velocity-adjusted forecast already corrects for this; consider sizing new estimates accordingly.`
        : 'Once completed leaves carry both estimate and actual, the linter watches your calibration.',
    fix: 'See the estimation-accuracy breakdown for per-node detail.',
    findings: drifted
      ? [mapFinding(`fudge factor ${fudge!.toFixed(2)}× over ${calibrationLeaves.length} completed leaves`)]
      : [],
  });

  // 6. no-done-criteria
  rules.push({
    ruleId: 'no-done-criteria',
    severity: 'info',
    title: `Sizeable leaves (≥ ${DONE_CRITERIA_MIN_DAYS} days) without a done-definition`,
    why: 'A task without a definition of done tends to be 90% finished forever — one sentence of "done means…" prevents it.',
    fix: 'Add a sentence to the description. Nodes linked to a requirement are exempt.',
    findings: incomplete
      .filter(
        (l) =>
          l.requirementId == null &&
          l.effortEstimate != null &&
          l.effortEstimate >= DONE_CRITERIA_MIN_DAYS * unitsPerDay &&
          (l.description ?? '').trim() === '',
      )
      .map((l) => finding(l, `${l.effortEstimate} ${unit}`)),
  });

  // 7. stale-plan (map-level)
  const mapIncomplete = nodes.filter(isLeaf).some((l) => (l.percentComplete ?? 0) < 100);
  rules.push({
    ruleId: 'stale-plan',
    severity: 'info',
    title: `Stale plan (no changes in ${STALE_PLAN_DAYS}+ days, map-level)`,
    why: 'A plan that is not touched weekly is a document, not a plan — a 2-minute review keeps the forecast honest.',
    fix: 'Do a short review: update the progress and dates that changed.',
    findings:
      history.ok && mapIncomplete && !history.anyRecentEvent
        ? [mapFinding(`map is incomplete with no recorded change in ${STALE_PLAN_DAYS} days`)]
        : [],
    skipped: history.ok ? undefined : 'change history unavailable',
  });

  // 8. dates-without-dependencies (map-level)
  const datedLeaves = nodes.filter((n) => isLeaf(n) && (n.dueDate || n.startDate));
  const totalDeps = nodes.reduce((s, n) => s + (n.dependencies?.length ?? 0), 0);
  rules.push({
    ruleId: 'dates-without-dependencies',
    severity: 'info',
    title: 'Scheduled plan with zero dependencies (map-level)',
    why: 'Without dependencies the schedule assumes everything can happen in parallel — the critical path is what makes a finish date real.',
    fix: 'Add dependencies between sequential tasks.',
    findings:
      datedLeaves.length >= MIN_DATED_LEAVES_FOR_DEPS && totalDeps === 0
        ? [mapFinding(`${datedLeaves.length} dated leaves, 0 dependencies`)]
        : [],
  });

  // ── Requirements pack (map-wide — the register is map-global) ──
  const mustRequirements = nodes.filter(
    (n) => n.requirementId != null && n.requirementPriority === 'must',
  );
  const subtreeEstimate = (root: Node): number => {
    let sum = 0;
    const stack = [root];
    while (stack.length) {
      const n = stack.pop()!;
      if (isLeaf(n)) sum += n.effortEstimate ?? 0;
      else for (const cid of n.childrenIds) {
        const c = nodeById.get(cid);
        if (c) stack.push(c);
      }
    }
    return sum;
  };
  const hasVersionTag = (node: Node): boolean => {
    let cur: Node | undefined = node;
    while (cur) {
      if (cur.versionId != null) return true;
      cur = cur.parentId ? nodeById.get(cur.parentId) : undefined;
    }
    return false;
  };

  // 9. uncovered-requirement
  rules.push({
    ruleId: 'uncovered-requirement',
    severity: 'warn',
    title: 'Must-requirements with no estimated work (map-level)',
    why: 'A requirement without estimated implementation work exists only on paper — the forecast has no idea it is missing.',
    fix: 'Break the requirement into estimated child tasks, or estimate the node itself.',
    findings: mustRequirements
      .filter((r) => progressOf(r) < 99.5 && subtreeEstimate(r) === 0)
      .map((r) => finding(r, `${r.requirementId}: no estimated work in its subtree`)),
  });

  // 10. stale-acceptance — staleness mirrors the requirements register:
  // progress moved by more than a point, or the node was edited (revision).
  const acceptances = opts.acceptances ?? [];
  rules.push({
    ruleId: 'stale-acceptance',
    severity: 'warn',
    title: 'Accepted requirements changed since sign-off (map-level)',
    why: 'A sign-off is a snapshot — when the work changes afterwards, the acceptance silently stops meaning anything.',
    fix: 'Re-review with the acceptor: re-accept, or revoke until the change is verified.',
    findings: acceptances
      .map((a) => ({ a, node: nodeById.get(a.nodeId) }))
      .filter((x): x is { a: AcceptanceInfo; node: Node } => x.node != null)
      .filter(
        ({ a, node }) =>
          Math.abs(progressOf(node) - a.progressAtAcceptance) > 1 ||
          node.revision !== a.nodeRevisionAtAcceptance,
      )
      .map(({ a, node }) =>
        finding(
          node,
          // Name the gate: with two verdicts per node, "re-review with the
          // acceptor" is only actionable if you know which one went stale.
          `${a.gate ?? 'business'} gate signed by ${a.userName} on ${a.acceptedAt.slice(0, 10)} at ${a.progressAtAcceptance.toFixed(0)}% (rev ${a.nodeRevisionAtAcceptance}) — now ${progressOf(node).toFixed(0)}% (rev ${node.revision})`,
        ),
      ),
    skipped: opts.acceptances == null ? 'acceptance data unavailable' : undefined,
  });

  // 11. unscheduled-must
  rules.push({
    ruleId: 'unscheduled-must',
    severity: 'info',
    title: 'Must-requirements with no target version (map-level)',
    why: 'A must-requirement with no release assignment is committed scope floating outside every plan.',
    fix: 'Tag it with a version so the release forecast owns it.',
    findings: mustRequirements
      .filter((r) => progressOf(r) < 99.5 && !hasVersionTag(r))
      .map((r) => finding(r, `${r.requirementId}: no target version`)),
  });

  // ── Apply dismissals ──
  const mutedRules = new Set(dismissals.filter((d) => d.nodeId == null).map((d) => d.ruleId));
  const nodeDismissals = new Set(
    dismissals.filter((d) => d.nodeId != null).map((d) => `${d.ruleId}:${d.nodeId}`),
  );

  const reports: LintRuleReport[] = rules.map((r) => {
    const ruleMuted = mutedRules.has(r.ruleId);
    const findings = r.findings.map((f) => ({
      ...f,
      dismissed: ruleMuted || (f.nodeId != null && nodeDismissals.has(`${r.ruleId}:${f.nodeId}`)),
    }));
    const dismissedCount = findings.filter((f) => f.dismissed).length;
    return {
      ...r,
      findings,
      dismissedCount,
      activeCount: findings.length - dismissedCount,
      ruleMuted,
    };
  });

  return {
    scopeLabel,
    warnCount: reports.filter((r) => r.severity === 'warn').reduce((s, r) => s + r.activeCount, 0),
    infoCount: reports.filter((r) => r.severity === 'info').reduce((s, r) => s + r.activeCount, 0),
    rules: reports,
  };
}
