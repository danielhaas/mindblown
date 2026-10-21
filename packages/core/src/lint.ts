/**
 * Plan-lint vocabulary shared by the engine (server), the MCP tool
 * (packages/mcp) and the panel: rule ids, fix-action ids, and which
 * fixes a rule may offer. One list, so an id printed by plan_lint is by
 * construction one that plan_fix and the route accept.
 * Rule semantics live in docs/plan-linter.md; the engine is
 * packages/server/src/lint/engine.ts.
 */

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
  'needs-human': { label: 'For a person (needs-human; blocker text into the description)', bulk: false },
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
};
