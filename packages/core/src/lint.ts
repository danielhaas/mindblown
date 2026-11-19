/**
 * Plan-lint vocabulary shared by the engine (server), the MCP tool
 * (packages/mcp) and the panel: rule ids, fix-action ids, and which
 * fixes a rule may offer. One list, so an id printed by plan_lint is by
 * construction one that plan_fix and the route accept.
 * Rule semantics live in docs/plan-linter.md; the engine is
 * packages/server/src/lint/engine.ts.
 */
import type { Ask } from './asks.js';

export const LINT_RULE_IDS = [
  'unestimated-leaf',
  'ai-draft-estimate',
  'oversized-leaf',
  'stale-progress',
  'overdue-unreplanned',
  'calibration-drift',
  'no-done-criteria',
  'stale-plan',
  'dates-without-dependencies',
  'sprint-state',
  // Requirements pack — evaluated map-wide (the register is map-global).
  'uncovered-requirement',
  'stale-acceptance',
  'unscheduled-must',
  // Sync pack — the map disagreeing with itself, its issues, or its code.
  'status-progress-mismatch',
  'done-parent-open-child',
  'issue-state-mismatch',
  'done-without-pr',
  'stale-blocked-reason',
  'claim-churn',
  'duplicate-issue-link',
  'stalled-unclaimed',
  'broken-repo-connection',
  // Stuck-work pack — work that waits without anyone being asked.
  'blocker-without-question',
  'hold-on-parent',
  // Wrong-map guard — a ticket naming the repo another map plans.
  'misfiled-repo',
] as const;
export type LintRuleId = (typeof LINT_RULE_IDS)[number];

/**
 * One-click fixes a finding may offer. `bulk` marks the ones a panel may
 * apply to every finding of a rule in one click: only the writes that
 * cannot fabricate progress or flip a ticket's done state.
 */
export const LINT_ACTIONS = {
  'mark-done': { label: 'Mark done (status + 100 %)', bulk: false },
  reopen: { label: 'Reopen the node (todo, 0 %)', bulk: false },
  'close-issue': { label: 'Close the issue', bulk: false },
  'reopen-issue': { label: 'Reopen the issue', bulk: false },
  'clear-blocker': { label: 'Clear the blocker text', bulk: true },
  park: { label: 'Park it (status blocked)', bulk: true },
  requeue: { label: 'Back to the queue (todo, progress kept)', bulk: false },
  'to-fleet': { label: 'Fleet can do it (skip tags off, back to the queue)', bulk: false },
  'fleet-fix': { label: 'Fleet can fix it (the worker reworks its own PR)', bulk: false },
  'fleet-check': { label: 'Fleet can fix it (the queue hands it out again, blocker in the brief)', bulk: false },
  'needs-human': { label: 'For a person (needs-human; blocker text into the description)', bulk: false },
  'write-brief': { label: 'Write the brief (the text becomes the description)', bulk: false },
  'move-to-map': { label: 'Move it to the map that plans its repo', bulk: false },
} as const;
export type LintActionId = keyof typeof LINT_ACTIONS;
export const LINT_ACTION_IDS = Object.keys(LINT_ACTIONS) as [LintActionId, ...LintActionId[]];

/** Which fixes a rule may offer — the route refuses anything else. */
export const LINT_FIX_ACTIONS: Partial<Record<LintRuleId, LintActionId[]>> = {
  'status-progress-mismatch': ['reopen', 'mark-done'],
  'done-parent-open-child': ['reopen'],
  'issue-state-mismatch': ['close-issue', 'reopen', 'mark-done', 'reopen-issue'],
  'done-without-pr': ['reopen'],
  'stale-blocked-reason': ['clear-blocker'],
  'claim-churn': ['park'],
  // Finished, back to the queue, or a person's next step — the same three
  // answers the stalled ask on the Questions card offers.
  'stalled-unclaimed': ['mark-done', 'requeue', 'needs-human'],
  // A person's step, not a wait: tag it, keep the text as the next step.
  'blocker-without-question': ['needs-human'],
  'misfiled-repo': ['move-to-map'],
};

/**
 * What the daily self-check (server lint/daily.ts) does with a rule's
 * findings — declared here, next to the rule ids, so a new rule is wired
 * in by adding its entry (the Record makes a missing one a type error):
 *
 *   auto   — apply the safe fix through plan_fix's write path when the
 *            finding is the safe case (lint/daily.ts autoAction), else ask.
 *            Off per rule with the map's `lintAutoFix` → ask.
 *   ask    — one ask per finding on the map's Questions card
 *            (`lint-<rule>-<node>`), options from the finding's fixes.
 *   digest — counted into one line per map in the daily mail.
 *   off    — not part of the daily check (the panel and plan_lint still show it).
 *
 * `label` is the digest wording: "24 without estimate".
 */
export type LintHandling = 'auto' | 'ask' | 'digest' | 'off';
export const LINT_DAILY: Record<LintRuleId, { handling: LintHandling; label?: string }> = {
  'unestimated-leaf': { handling: 'digest', label: 'without estimate' },
  'ai-draft-estimate': { handling: 'digest', label: 'AI drafts to confirm' },
  'oversized-leaf': { handling: 'digest', label: 'oversized' },
  'stale-progress': { handling: 'off' },
  'overdue-unreplanned': { handling: 'off' },
  'calibration-drift': { handling: 'off' },
  'no-done-criteria': { handling: 'digest', label: 'without done criteria' },
  'stale-plan': { handling: 'digest', label: 'plan untouched for 14 days' },
  'dates-without-dependencies': { handling: 'off' },
  'sprint-state': { handling: 'off' },
  'uncovered-requirement': { handling: 'off' },
  'stale-acceptance': { handling: 'off' },
  'unscheduled-must': { handling: 'off' },
  'status-progress-mismatch': { handling: 'auto' },
  'done-parent-open-child': { handling: 'ask' },
  'issue-state-mismatch': { handling: 'ask' },
  'done-without-pr': { handling: 'digest', label: 'done without a PR' },
  'stale-blocked-reason': { handling: 'auto' },
  'claim-churn': { handling: 'off' },
  'duplicate-issue-link': { handling: 'off' },
  'stalled-unclaimed': { handling: 'auto' },
  'broken-repo-connection': { handling: 'ask' },
  'blocker-without-question': { handling: 'ask' },
  'hold-on-parent': { handling: 'off' },
  'misfiled-repo': { handling: 'ask' },
};

/** The rules whose handling is `auto` — the keys `lintAutoFix` may switch off. */
export const LINT_AUTO_RULES = LINT_RULE_IDS.filter((r) => LINT_DAILY[r].handling === 'auto');

/**
 * Per-map switch for the daily auto-fixes: rule id → false turns that
 * rule's auto-fix off (its findings become asks); a missing key is on.
 */
export type LintAutoFix = Partial<Record<LintRuleId, boolean>>;

export function lintAutoFixOn(setting: LintAutoFix | null | undefined, ruleId: LintRuleId): boolean {
  return LINT_DAILY[ruleId].handling === 'auto' && setting?.[ruleId] !== false;
}

/** A daily-check finding on the Questions card: `lint-<rule>-<node uuid>`. */
export const LINT_ASK_PREFIX = 'lint-';
const LINT_ASK_RE = /^lint-([a-z-]+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function lintAskId(ruleId: LintRuleId, nodeId: string): string {
  return `${LINT_ASK_PREFIX}${ruleId}-${nodeId}`;
}

/** The rule and node a lint ask is about, or null for any other ask id. */
export function parseLintAskId(askId: string): { ruleId: LintRuleId; nodeId: string } | null {
  const m = LINT_ASK_RE.exec(askId);
  if (!m || !(LINT_RULE_IDS as readonly string[]).includes(m[1])) return null;
  return { ruleId: m[1] as LintRuleId, nodeId: m[2] };
}

export function lintAskNodeId(askId: string): string | null {
  return parseLintAskId(askId)?.nodeId ?? null;
}

/** "Leave it" on a lint ask: recorded, nothing written; the ask stays answered while the finding is unchanged. */
export const LINT_ASK_LEAVE = 'Leave it';

/**
 * Which fix an answer to a lint ask means: an option (a fix's label or id)
 * → that fix; anything else → null (recorded only), except free text on a
 * rule that offers `needs-human`, which becomes that person's next step.
 */
export function lintAnswerAction(offered: LintActionId[], decision: string): { action: LintActionId; note?: string } | null {
  const d = decision.trim().toLowerCase();
  if (!d || d === LINT_ASK_LEAVE.toLowerCase()) return null;
  for (const id of offered) {
    if (d === id || d === LINT_ACTIONS[id].label.toLowerCase()) return { action: id };
  }
  if (offered.includes('needs-human')) return { action: 'needs-human', note: decision.trim() };
  return null;
}

/** Keep only `auto` rule ids with a boolean — what a stored or sent `lintAutoFix` may hold. */
export function sanitizeLintAutoFix(v: unknown): LintAutoFix {
  const out: LintAutoFix = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, on] of Object.entries(v as Record<string, unknown>)) {
    if (typeof on === 'boolean' && (LINT_AUTO_RULES as string[]).includes(k)) out[k as LintRuleId] = on;
  }
  return out;
}

/** A fix the daily check applied (or tried to). */
export interface LintRunFix {
  ruleId: LintRuleId;
  nodeId: string;
  nodeText: string;
  action: LintActionId;
  ok: boolean;
  error?: string;
}

/** A finding the daily check put on the Questions card. */
export interface LintRunAsk {
  ruleId: LintRuleId;
  /** The finding's node; a map-level finding sits on the map's root. */
  nodeId: string;
  nodeText: string;
  /** The rule's title, as plan_lint prints it. */
  title: string;
  detail: string;
  /** The fixes the finding offers — the ask's options. */
  actions: LintActionId[];
  /** When a run first reported this (rule, node) — kept across runs while it stays. */
  firstSeenAt: string;
}

/** One map's daily check (server lint_runs). */
export interface LintRun {
  mapId: string;
  mapName?: string;
  /** Local calendar day of the run (YYYY-MM-DD). */
  day: string;
  ranAt: string;
  fixed: LintRunFix[];
  asked: LintRunAsk[];
  /** Hygiene counts (digest rules) — one line in the daily mail. */
  digest: Partial<Record<LintRuleId, number>>;
  /** Set when the run failed; the rest is empty then. */
  error: string | null;
}

/**
 * A daily-check finding as a row on the Questions card: the rule's title
 * and the finding's detail as the question, the fixes it offers (and
 * "Leave it") as the options, to the map's owner. The id is per rule and
 * node, so the same finding the next day is the same row.
 */
export function buildLintAsk(a: LintRunAsk, mapId: string, answerer: string, now: Date = new Date()): Ask {
  return {
    id: lintAskId(a.ruleId, a.nodeId),
    map_id: mapId,
    ticket: null,
    requirement: null,
    title: a.nodeText,
    url: null,
    sources: ['mindblown-lint'],
    question: `${a.title}: ${a.detail}`,
    question_author: 'MindBlown daily check',
    options: [...a.actions.map((id) => LINT_ACTIONS[id].label), LINT_ASK_LEAVE],
    answerer,
    hint: 'decision',
    priority: null,
    milestone: null,
    needs_version: false,
    idle_hours: Math.floor((now.getTime() - Date.parse(a.firstSeenAt)) / 3_600_000),
    unblocks: {
      node_id: a.nodeId,
      node_title: a.nodeText,
      node_status: a.ruleId,
      claimed_by: null,
      worker: null,
      pr: null,
      pr_state: null,
    },
    moot: false,
  };
}

/** "24 without estimate, 3 oversized, 7 AI drafts to confirm" — empty when nothing to say. */
export function lintDigestLine(digest: Partial<Record<LintRuleId, number>>): string {
  return LINT_RULE_IDS.filter((r) => LINT_DAILY[r].handling === 'digest' && (digest[r] ?? 0) > 0)
    .map((r) => (r === 'stale-plan' ? LINT_DAILY[r].label! : `${digest[r]} ${LINT_DAILY[r].label}`))
    .join(', ');
}
