/**
 * Tests for the pure / DB-free pieces of the parent-epic rollup (#57).
 *
 * Scope is intentionally narrow — we lock down the deterministic parts:
 *
 *   - title parsing: each documented pattern matches its example exactly
 *   - sibling counting: closed vs total math + edge cases
 *   - percent rounding
 *   - description tail-line idempotency
 *   - applyRollupToParent's ProseMirror-preservation decision
 *
 * The DB-touching paths (`findNodesByExternalId`, the full
 * `rollupParentsForChildTitle` / `applyRollupForFetchedIssues` pipelines)
 * are not exercised here and have no integration coverage yet — file a
 * separate ticket if you want end-to-end DB tests for those.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Node } from '@mindblown/core';

// Mock the DB layer + websocket broadcast so applyRollupToParent runs without
// a real Postgres or socket. The mock has to be declared before the module
// under test is imported (vitest hoists vi.mock calls automatically, but we
// keep imports below for clarity).
const updateNodeMock = vi.fn();
vi.mock('../../db/nodes.js', () => ({
  updateNode: (...args: unknown[]) => updateNodeMock(...args),
}));
vi.mock('../../db/connection.js', () => ({ db: {} }));
vi.mock('../../db/schema.js', () => ({ nodes: {} }));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

import {
  parseParentReferences,
  siblingsForParent,
  computeRollupPercent,
  updateChildPrsTailLine,
  applyRollupToParent,
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
    // Sanity: at least the five documented patterns survive refactors.
    expect(DEFAULT_PARENT_PATTERNS.length).toBeGreaterThanOrEqual(5);
  });

  // ── Trailing `(#NNNN follow-up)` (the dominant Stella pattern) ──
  describe('trailing-paren follow-up', () => {
    it('matches `(#NNNN follow-up)` at end-of-title', () => {
      expect(
        parseParentReferences(
          'Sweep denormalised ChatMessage.mandate on retention purge (#664 follow-up)',
        ),
      ).toEqual([664]);
    });

    it('matches `(#NNNN <words> follow-up)` with intervening qualifiers', () => {
      // Real-world: `(#811 V1.5 follow-up)`. We allow optional words between
      // the number and the literal `follow-up` trailer.
      expect(
        parseParentReferences(
          'Add User.person FK for structural COI detection (#811 V1.5 follow-up)',
        ),
      ).toEqual([811]);
    });

    it('matches `followup` variant without the hyphen', () => {
      expect(parseParentReferences('Some work (#123 followup)')).toEqual([123]);
    });

    it('does NOT match incidental trailing parens without the keyword', () => {
      // Load-bearing negative: title ends in `(#664 was helpful)` — no
      // "follow-up" trailer, so it must not be classified as a child.
      expect(parseParentReferences('add column (#664 was helpful)')).toEqual([]);
    });

    it('does NOT match mid-title `#NNNN` without the trailing-paren wrapper', () => {
      expect(
        parseParentReferences('bug fix in line 42 referencing #100 inline'),
      ).toEqual([]);
    });
  });

  // ── Reviewer-attributed `(Ray|Rita|Dana review of #NNNN ...)` ──
  describe('reviewer-attributed', () => {
    it('matches `(Ray review of #NNNN followup)`', () => {
      expect(
        parseParentReferences(
          "Fix stale role='advisor' literal in reporting test (Ray review of #614 followup)",
        ),
      ).toEqual([614]);
    });

    it('matches `(Rita follow-up to #NNNN ...)` and `(Dana review of #NNNN)`', () => {
      expect(
        parseParentReferences('CRS edge case (Rita follow-up to #200 audit gap)'),
      ).toEqual([200]);
      expect(
        parseParentReferences('Compliance fix (Dana review of #350)'),
      ).toEqual([350]);
    });

    it('does NOT match a reviewer name without the required keyword', () => {
      // Negative: `(Ray helped with #614)` mentions Ray and #614 but neither
      // "review of" nor "follow-up to" — must not be classified.
      expect(
        parseParentReferences('random text (Ray helped with #614)'),
      ).toEqual([]);
    });

    it('does NOT match `(Rita R1)` with no issue reference at all', () => {
      // Real Stella title style. Rita is mentioned but no `#NNNN` keyword
      // anywhere — must stay unmatched.
      expect(
        parseParentReferences(
          'Team should be SoftDeleteModel for FMA reconstruction (Rita R1)',
        ),
      ).toEqual([]);
    });
  });

  it('still matches the original leading-bracket pattern after additions', () => {
    // Regression guard: adding the trailing/reviewer patterns must not
    // displace the `[#890-followup]` leader.
    expect(
      parseParentReferences(
        '[#890-followup] FATCA generator corrections support (mirror of CRS)',
      ),
    ).toEqual([890]);
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

describe('applyRollupToParent (ProseMirror preservation)', () => {
  const baseNode = (overrides: Partial<Node> = {}): Node =>
    ({
      id: 'n1',
      mapId: 'm1',
      parentId: null,
      childrenIds: [],
      text: 'Parent epic',
      description: null,
      x: null,
      y: null,
      collapsed: false,
      effortEstimate: null,
      actualEffort: null,
      percentComplete: null,
      status: null,
      blockedReason: null,
      assigneeIds: [],
      priority: null,
      dueDate: null,
      startDate: null,
      tags: [],
      customFields: {},
      dependencies: [],
      versionId: null,
      cycleId: null,
      externalLinks: [],
      autoProgress: 'children',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'u1',
      revision: 1,
      ...overrides,
    }) as Node;

  beforeEach(() => {
    updateNodeMock.mockReset();
    updateNodeMock.mockResolvedValue(baseNode());
  });

  it('writes both percentComplete AND description when description is a string', async () => {
    const node = baseNode({ description: 'Existing string description.' });
    await applyRollupToParent(node, { closed: 3, total: 4 });

    expect(updateNodeMock).toHaveBeenCalledOnce();
    const [, updates] = updateNodeMock.mock.calls[0];
    expect(updates.percentComplete).toBe(75);
    expect(typeof updates.description).toBe('string');
    expect(updates.description).toContain('Child PRs: 3/4 merged (auto-tracked)');
  });

  it('writes both fields when description is null', async () => {
    const node = baseNode({ description: null });
    await applyRollupToParent(node, { closed: 1, total: 2 });

    expect(updateNodeMock).toHaveBeenCalledOnce();
    const [, updates] = updateNodeMock.mock.calls[0];
    expect(updates.percentComplete).toBe(50);
    expect(updates.description).toBe('Child PRs: 1/2 merged (auto-tracked)');
  });

  it('preserves a ProseMirror JSON description and only writes percentComplete', async () => {
    // Real ProseMirror docs are JSON objects with `type: 'doc'` and a
    // `content` array. Overwriting that with a plain string would silently
    // destroy the rich-text content (must-fix #2 in Ray's review).
    const proseMirrorDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Rich body that must survive rollup.' }],
        },
      ],
    };
    // We cast through unknown because the public Node type declares
    // description as `string | null`, but in practice the column is jsonb
    // and the runtime value can be a ProseMirror object.
    const node = baseNode({ description: proseMirrorDoc as unknown as string });

    await applyRollupToParent(node, { closed: 2, total: 5 });

    expect(updateNodeMock).toHaveBeenCalledOnce();
    const [, updates] = updateNodeMock.mock.calls[0];
    expect(updates.percentComplete).toBe(40);
    // CRITICAL: description must NOT be in the update payload at all when
    // the original is a non-string ProseMirror doc. Writing `undefined`
    // would be fine (nodeDb.updateNode skips undefined), but writing any
    // string here would clobber the doc.
    expect(updates).not.toHaveProperty('description');
  });

  it('is a no-op when autoProgress is off', async () => {
    const node = baseNode({ autoProgress: 'off' });
    const result = await applyRollupToParent(node, { closed: 1, total: 1 });
    expect(result).toBe(false);
    expect(updateNodeMock).not.toHaveBeenCalled();
  });

  it('is a no-op when total is 0', async () => {
    const node = baseNode();
    const result = await applyRollupToParent(node, { closed: 0, total: 0 });
    expect(result).toBe(false);
    expect(updateNodeMock).not.toHaveBeenCalled();
  });
});
