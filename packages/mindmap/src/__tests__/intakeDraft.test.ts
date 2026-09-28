/**
 * The card's write rules (#387): what a server draft becomes on the card
 * and what Accept sends. The one that matters: a low-confidence estimate
 * is a suggestion and is NOT written unless the user ticks it.
 */

import { describe, it, expect } from 'vitest';
import type { IntakeDraft } from '../api.js';
import {
  editsFromDraft,
  toAcceptPayload,
  answersToMessage,
  parseTags,
  verdictHeadline,
  existingStateLine,
} from '../intakeDraft.js';

function draft(overrides: Partial<IntakeDraft> = {}): IntakeDraft {
  return {
    title: 'T',
    description: 'D',
    parentId: 'p1',
    parentText: 'Parent',
    parentReason: 'fits',
    priority: 'P2',
    versionId: 'v1',
    versionName: 'V1',
    phaseId: null,
    phaseName: null,
    tags: ['a'],
    dependencies: [
      { nodeId: 'd1', text: 'one', reason: 'r1' },
      { nodeId: 'd2', text: 'two', reason: 'r2' },
    ],
    verdict: 'new',
    existing: [],
    estimate: { estimate: 2.5, confidence: 'medium', samplesUsed: 3, effortUnit: 'days' },
    ...overrides,
  };
}

describe('editsFromDraft', () => {
  it('keeps a medium/high estimate and every dependency by default', () => {
    const e = editsFromDraft(draft());
    expect(e.keepEstimate).toBe(true);
    expect(e.keptDependencies).toEqual(['d1', 'd2']);
  });

  it('treats a low-confidence estimate as a suggestion (not kept)', () => {
    const e = editsFromDraft(
      draft({ estimate: { estimate: 9, confidence: 'low', samplesUsed: 0, effortUnit: 'days' } }),
    );
    expect(e.keepEstimate).toBe(false);
  });

  it('has nothing to keep without an estimate', () => {
    expect(editsFromDraft(draft({ estimate: null })).keepEstimate).toBe(false);
  });
});

describe('toAcceptPayload', () => {
  it('sends the edited card, the kept dependencies and the estimate only when kept', () => {
    const d = draft();
    const e = { ...editsFromDraft(d), title: ' New title ', keptDependencies: ['d2'], tags: ['x', ' ', 'y'] };
    expect(toAcceptPayload(d, e)).toEqual({
      title: 'New title',
      description: 'D',
      parentId: 'p1',
      priority: 'P2',
      versionId: 'v1',
      phaseId: null,
      tags: ['x', 'y'],
      dependencies: [{ nodeId: 'd2' }],
      effortEstimate: 2.5,
    });

    const off = toAcceptPayload(d, { ...e, keepEstimate: false });
    expect('effortEstimate' in off).toBe(false);
  });
});

describe('answersToMessage', () => {
  it('numbers answered questions and skips blanks', () => {
    const msg = answersToMessage(
      [
        { id: 'a', question: 'A?', options: [], why: null },
        { id: 'b', question: 'B?', options: [], why: null },
      ],
      { a: 'yes', b: '  ' },
    );
    expect(msg).toBe('1. A?\n   → yes');
  });
});

describe('verdict + existing lines', () => {
  it('headline per verdict, empty for new', () => {
    expect(verdictHeadline('new')).toBe('');
    expect(verdictHeadline('covered')).toContain('Already covered');
    expect(verdictHeadline('regression')).toContain('back');
    expect(verdictHeadline('extends')).toContain('extends');
  });

  it('state line names status, done date, shipped fix and issue', () => {
    expect(
      existingStateLine({
        nodeId: 'n1', issueNumber: 42, url: null, text: 't', status: 'done', closedAt: '2026-09-01T10:00:00Z',
        fixedByPr: true, reason: '', recommendation: 'create',
      }),
    ).toBe('done · done 2026-09-01 · fixed by a merged PR · #42');
    expect(
      existingStateLine({
        nodeId: null, issueNumber: 7, url: null, text: 't', status: 'open', closedAt: null,
        fixedByPr: false, reason: '', recommendation: 'comment',
      }),
    ).toBe('open · #7 (not in this map)');
  });
});

describe('parseTags', () => {
  it('splits, trims, dedupes', () => {
    expect(parseTags(' sync, ui ,sync,, ')).toEqual(['sync', 'ui']);
  });
});
