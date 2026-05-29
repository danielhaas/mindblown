/**
 * Tests for the pure / DB-free pieces of the parent-epic rollup (#57).
 *
 * The DB-touching parts (`applyRollupToParent`, `findNodesByExternalId`,
 * `rollupParentsForChildTitle`, `applyRollupForFetchedIssues`) are exercised
 * end-to-end in the catch-up integration scenarios; here we lock down:
 *
 *   - title parsing: each documented pattern matches its example exactly
 *   - sibling counting: closed vs total math + edge cases
 *   - percent rounding
 *   - description tail-line idempotency
 */

import { describe, it, expect } from 'vitest';
import {
  parseParentReferences,
  siblingsForParent,
  computeRollupPercent,
  updateChildPrsTailLine,
  DEFAULT_PARENT_PATTERNS,
} from '../parentEpicRollup.js';

describe('parseParentReferences', () => {
  it('matches `[#NNNN-followup]` prefix', () => {
    expect(parseParentReferences('[#843-followup] AcctHolderType (CRS101/102/103)'))
      .toEqual([843]);
  });

  it('matches plain `[#NNNN]` prefix', () => {
    expect(parseParentReferences('[#1346] Frontend: German translations'))
      .toEqual([1346]);
  });

  it('matches `Follow-up to #NNNN` prefix', () => {
    expect(parseParentReferences('Follow-up to #1487: set mandate.updated_by on offboarding'))
      .toEqual([1487]);
  });

  it('matches `[V1 UAT #NNNN]` prefix (and other V-numbers)', () => {
    expect(parseParentReferences('[V1 UAT #1685] BUG: Dashboard overdue invoices not clickable'))
      .toEqual([1685]);
    expect(parseParentReferences('[V2 UAT #99] another bug'))
      .toEqual([99]);
  });

  it('returns empty for non-matching titles', () => {
    expect(parseParentReferences('Fix the thing')).toEqual([]);
    expect(parseParentReferences('Closes #123 along the way')).toEqual([]);
    // Anchored — mid-title `#NNNN` doesn't count
    expect(parseParentReferences('Bug: foo [#42] tail')).toEqual([]);
    expect(parseParentReferences('')).toEqual([]);
  });

  it('does not match patterns we deliberately exclude', () => {
    // `Closes #N` is GitHub's own PR→issue close keyword and not part of our
    // decomposition convention; the existing webhook handler covers it.
    expect(parseParentReferences('Closes #41: tweak')).toEqual([]);
  });

  it('case-insensitive on Follow-up to / V_UAT', () => {
    expect(parseParentReferences('follow-up to #5: lowercase')).toEqual([5]);
    expect(parseParentReferences('[v1 uat #7] lowercase')).toEqual([7]);
  });

  it('exposes a non-empty default pattern set', () => {
    // Sanity: at least the three documented prefixes survive refactors.
    expect(DEFAULT_PARENT_PATTERNS.length).toBeGreaterThanOrEqual(3);
  });
});

describe('siblingsForParent', () => {
  const issues = [
    { number: 100, title: '[#42] feature work A', state: 'closed' as const },
    { number: 101, title: '[#42-followup] feature work B', state: 'closed' as const },
    { number: 102, title: '[#42] feature work C', state: 'open' as const },
    { number: 103, title: 'Follow-up to #42: extra', state: 'closed' as const },
    { number: 104, title: 'unrelated bug', state: 'closed' as const },
    { number: 42, title: '[#42] the parent itself', state: 'open' as const }, // self-ref excluded
    { number: 200, title: '[#99] another epic child', state: 'closed' as const }, // different parent
  ];

  it('counts closed vs total for the requested parent', () => {
    // For parent 42: issues 100 (closed), 101 (closed), 102 (open), 103 (closed) = 3 closed / 4 total
    expect(siblingsForParent(issues, 42)).toEqual({ closed: 3, total: 4 });
  });

  it('excludes the parent issue itself even if its title self-matches', () => {
    // Issue 42 has title `[#42]` but it's number 42 — must not double-count.
    const onlyParent = [
      { number: 42, title: '[#42] parent', state: 'open' as const },
    ];
    expect(siblingsForParent(onlyParent, 42)).toEqual({ closed: 0, total: 0 });
  });

  it('returns zero when no siblings match', () => {
    expect(siblingsForParent(issues, 999)).toEqual({ closed: 0, total: 0 });
  });

  it('counts closed regardless of state_reason (not_planned still closes)', () => {
    // The GitHub API surfaces state_reason: 'not_planned' issues as
    // state: 'closed'. We rely on the state field alone, so this is implicit.
    const withNotPlanned = [
      { number: 1, title: '[#5] child', state: 'closed' as const },
      { number: 2, title: '[#5] child', state: 'closed' as const },
    ];
    expect(siblingsForParent(withNotPlanned, 5)).toEqual({ closed: 2, total: 2 });
  });

  it('handles a reopened sibling (closed count drops)', () => {
    // Same dataset but one previously-closed child has been reopened.
    const reopened = issues.map((i) =>
      i.number === 101 ? { ...i, state: 'open' as const } : i,
    );
    expect(siblingsForParent(reopened, 42)).toEqual({ closed: 2, total: 4 });
  });
});

describe('computeRollupPercent', () => {
  it('rounds to nearest integer percent', () => {
    expect(computeRollupPercent({ closed: 1, total: 3 })).toBe(33); // 33.333
    expect(computeRollupPercent({ closed: 2, total: 3 })).toBe(67); // 66.666
    expect(computeRollupPercent({ closed: 3, total: 6 })).toBe(50);
    expect(computeRollupPercent({ closed: 6, total: 6 })).toBe(100);
    expect(computeRollupPercent({ closed: 0, total: 6 })).toBe(0);
  });

  it('returns 0 when total is 0 (caller should skip write)', () => {
    expect(computeRollupPercent({ closed: 0, total: 0 })).toBe(0);
  });
});

describe('updateChildPrsTailLine', () => {
  const counts = { closed: 4, total: 6 };

  it('appends a tail line to a description without one', () => {
    const out = updateChildPrsTailLine('Original description body.', counts);
    expect(out).toBe('Original description body.\n\nChild PRs: 4/6 merged (auto-tracked)');
  });

  it('replaces an existing tail line in place (idempotent)', () => {
    const first = updateChildPrsTailLine('Description.', counts);
    const second = updateChildPrsTailLine(first, counts);
    expect(second).toBe(first);
  });

  it('updates the counts on the existing tail line', () => {
    const first = updateChildPrsTailLine('Description.', { closed: 1, total: 6 });
    const second = updateChildPrsTailLine(first, { closed: 4, total: 6 });
    expect(second).toBe('Description.\n\nChild PRs: 4/6 merged (auto-tracked)');
  });

  it('produces the bare line when description is null/empty', () => {
    expect(updateChildPrsTailLine(null, counts))
      .toBe('Child PRs: 4/6 merged (auto-tracked)');
    expect(updateChildPrsTailLine('', counts))
      .toBe('Child PRs: 4/6 merged (auto-tracked)');
  });

  it("doesn't get confused by mid-body 'Child PRs' prose", () => {
    const description = 'Child PRs were discussed in the kickoff.\n\nMore text.';
    const out = updateChildPrsTailLine(description, counts);
    expect(out).toBe(
      'Child PRs were discussed in the kickoff.\n\nMore text.\n\nChild PRs: 4/6 merged (auto-tracked)',
    );
  });
});
