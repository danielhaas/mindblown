import { describe, it, expect } from 'vitest';
import {
  buildLintAsk,
  LINT_AUTO_RULES,
  LINT_DAILY,
  LINT_RULE_IDS,
  lintAnswerAction,
  lintAskId,
  lintAutoFixOn,
  lintDigestLine,
  parseLintAskId,
  sanitizeLintAutoFix,
} from '../lint.js';
import { derivedAskNodeId } from '../humanSteps.js';

const NODE = '0192f0a1-1234-7abc-8def-0123456789ab';

describe('daily-check handling', () => {
  it('every rule declares one', () => {
    for (const r of LINT_RULE_IDS) expect(['auto', 'ask', 'digest', 'off']).toContain(LINT_DAILY[r].handling);
    for (const r of LINT_RULE_IDS.filter((x) => LINT_DAILY[x].handling === 'digest')) expect(LINT_DAILY[r].label).toBeTruthy();
    expect([...LINT_AUTO_RULES].sort()).toEqual(['stale-blocked-reason', 'stalled-unclaimed', 'status-progress-mismatch']);
  });

  it('autoFix: missing = on, false = off, never on for a rule that is not auto', () => {
    expect(lintAutoFixOn({}, 'stalled-unclaimed')).toBe(true);
    expect(lintAutoFixOn({ 'stalled-unclaimed': false }, 'stalled-unclaimed')).toBe(false);
    expect(lintAutoFixOn(undefined, 'issue-state-mismatch')).toBe(false);
    expect(sanitizeLintAutoFix({ 'stalled-unclaimed': false, 'unestimated-leaf': false, x: true, 'stale-blocked-reason': 'no' })).toEqual({ 'stalled-unclaimed': false });
    expect(sanitizeLintAutoFix(null)).toEqual({});
  });
});

describe('lint asks', () => {
  it('id round-trips rule and node, and is a derived row', () => {
    const id = lintAskId('done-parent-open-child', NODE);
    expect(parseLintAskId(id)).toEqual({ ruleId: 'done-parent-open-child', nodeId: NODE });
    expect(derivedAskNodeId(id)).toBe(NODE);
    expect(parseLintAskId(`lint-no-such-rule-${NODE}`)).toBeNull();
    expect(parseLintAskId('stalled-' + NODE)).toBeNull();
  });

  it('options are the fixes plus Leave it; an option runs its fix, Leave it nothing, free text needs-human where offered', () => {
    const ask = buildLintAsk(
      { ruleId: 'stalled-unclaimed', nodeId: NODE, nodeText: 'T', title: 'Stalled', detail: '40 %, idle 2 days', actions: ['mark-done', 'requeue'], firstSeenAt: '2026-11-19T00:00:00Z' },
      'map-1',
      'Dan',
      new Date('2026-11-20T00:00:00Z'),
    );
    expect(ask.question).toBe('Stalled: 40 %, idle 2 days');
    expect(ask.options).toEqual(['Mark done (status + 100 %)', 'Back to the queue (todo, progress kept)', 'Leave it']);
    expect(ask.idle_hours).toBe(24);
    const offered = ['mark-done', 'requeue', 'needs-human'] as const;
    expect(lintAnswerAction([...offered], 'Back to the queue (todo, progress kept)')).toEqual({ action: 'requeue' });
    expect(lintAnswerAction([...offered], 'mark-done')).toEqual({ action: 'mark-done' });
    expect(lintAnswerAction([...offered], 'Leave it')).toBeNull();
    expect(lintAnswerAction([...offered], 'Rita deploys it')).toEqual({ action: 'needs-human', note: 'Rita deploys it' });
    expect(lintAnswerAction(['reopen'], 'whatever')).toBeNull();
  });

  it('digest line: counts in rule order, the stale plan as a phrase, nothing when clean', () => {
    expect(lintDigestLine({ 'ai-draft-estimate': 7, 'unestimated-leaf': 24, 'oversized-leaf': 3 })).toBe('24 without estimate, 7 AI drafts to confirm, 3 oversized');
    expect(lintDigestLine({ 'stale-plan': 1 })).toBe('plan untouched for 14 days');
    expect(lintDigestLine({})).toBe('');
  });
});
