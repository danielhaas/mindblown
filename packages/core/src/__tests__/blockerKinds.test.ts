import { describe, it, expect } from 'vitest';
import {
  answererName,
  blockerRefs,
  buildExternalAsk,
  buildQuestionAsk,
  classifyUnkinded,
  externalAnswerAction,
  externalRecheckAt,
  externalRecheckDue,
  isUnkindedBlocker,
  unkindedDue,
} from '../blockerKinds.js';
import { derivedAskNodeId, derivedAnswerPreview, isPersonStepAsk } from '../humanSteps.js';
import type { BlockerInfo, ExternalLink } from '../types.js';

const link = (externalId: string, isPullRequest = false): ExternalLink =>
  ({ provider: 'github', externalId, url: 'u', syncEnabled: false, lastSyncedAt: null, isPullRequest }) as ExternalLink;
const isDone = (s: string | null) => s === 'done';

describe('blockerRefs', () => {
  it('reads "#12", "PR #12", "owner/repo#12" and "owner/repo PR #12"', () => {
    expect(blockerRefs('Waiting on Dan: merge dan/placet PR #62 and #7, then o/r#3')).toEqual([
      { repo: 'dan/placet', number: 62 },
      { repo: null, number: 7 },
      { repo: 'o/r', number: 3 },
    ]);
    expect(blockerRefs('needs a design choice from Dan')).toEqual([]);
  });
});

describe('classifyUnkinded', () => {
  const nodes = [
    { id: 'me', status: 'todo', externalLinks: [link('o/r#1')] },
    { id: 'pr', status: 'in_progress', externalLinks: [link('dan/placet#62', true)] },
    { id: 'old', status: 'done', externalLinks: [link('o/r#7')] },
  ];

  it('a dependency when the text names an open ticket/PR of the map', () => {
    expect(classifyUnkinded({ id: 'me', blockedReason: 'merge dan/placet PR #62 first' }, nodes, isDone)).toEqual({ kind: 'waits-on', targetNodeId: 'pr' });
  });

  it('a question when it names none, only a finished one, another repo, or itself', () => {
    expect(classifyUnkinded({ id: 'me', blockedReason: 'Release dirs writable — needs a design choice' }, nodes, isDone)).toEqual({ kind: 'question' });
    expect(classifyUnkinded({ id: 'me', blockedReason: 'after #7' }, nodes, isDone)).toEqual({ kind: 'question' });
    expect(classifyUnkinded({ id: 'me', blockedReason: 'other/repo#62' }, nodes, isDone)).toEqual({ kind: 'question' });
    expect(classifyUnkinded({ id: 'me', blockedReason: 'see #1' }, nodes, isDone)).toEqual({ kind: 'question' });
  });
});

describe('unkindedDue', () => {
  const now = new Date('2026-11-19T12:00:00Z');
  it('an hour after the blocker was set, not before', () => {
    expect(unkindedDue({ id: 'a', text: 'a', blockedReason: 'x', blockedAt: '2026-11-19T11:30:00Z' }, now)).toBe(false);
    expect(unkindedDue({ id: 'a', text: 'a', blockedReason: 'x', blockedAt: '2026-11-19T11:00:00Z' }, now)).toBe(true);
  });

  it('never a kinded blocker or a fleet worker note', () => {
    const info: BlockerInfo = { kind: 'question' };
    expect(unkindedDue({ id: 'a', text: 'a', blockedReason: 'x', blockedAt: '2026-11-01T00:00:00Z', blockerInfo: info }, now)).toBe(false);
    expect(isUnkindedBlocker({ blockedReason: 'Fleet worker claudia: CI failed on PR #3' })).toBe(false);
    expect(isUnkindedBlocker({ blockedReason: '  ' })).toBe(false);
  });

  it('a blocker without a clock only for the one-time run', () => {
    expect(unkindedDue({ id: 'a', text: 'a', blockedReason: 'x', blockedAt: null }, now)).toBe(false);
    expect(unkindedDue({ id: 'a', text: 'a', blockedReason: 'x', blockedAt: null }, now, { legacy: true })).toBe(true);
  });
});

describe('the derived rows', () => {
  const node = { id: 'n1', text: 'Payment page', blockedReason: 'Stripe or Adyen?', priority: 'P1', externalLinks: [link('o/r#5')] };

  it('question row: the text, the answerer (default the owner), its options — a question, not a step', () => {
    const a = buildQuestionAsk({ ...node, blockerInfo: { kind: 'question', options: ['Stripe', 'Adyen'] } }, 'm1', 'Dan');
    expect(a).toMatchObject({ id: 'question-n1', question: 'Stripe or Adyen?', answerer: 'Dan', options: ['Stripe', 'Adyen'], hint: 'decision', unblocks: { node_id: 'n1' } });
    expect(buildQuestionAsk({ ...node, blockerInfo: { kind: 'question', answerer: 'Rita' } }, 'm1', 'Dan').answerer).toBe('Rita');
    expect(derivedAskNodeId('question-n1')).toBe('n1');
    expect(isPersonStepAsk(a)).toBe(false);
  });

  it('external row: due on its date, asks "Still waiting?"', () => {
    const now = new Date('2026-11-19T12:00:00Z');
    const recheckAt = externalRecheckAt(now);
    expect(recheckAt).toBe('2026-11-26T12:00:00.000Z');
    expect(externalRecheckDue({ kind: 'external', recheckAt }, now)).toBe(false);
    expect(externalRecheckDue({ kind: 'external', recheckAt }, new Date('2026-11-26T12:00:00Z'))).toBe(true);
    expect(externalRecheckDue({ kind: 'question' }, now)).toBe(false);
    const a = buildExternalAsk({ ...node, blockedReason: 'LOKE sends keys', blockerInfo: { kind: 'external', recheckAt } }, 'm1', 'Dan');
    expect(a).toMatchObject({ id: 'external-n1', question: 'Still waiting? LOKE sends keys', options: ['Still waiting', 'Unblocked'], hint: 'waiting-external' });
    expect(derivedAskNodeId('external-n1')).toBe('n1');
  });

  it('answers: Still waiting / Unblocked / a decision, with previews', () => {
    expect(externalAnswerAction('Still waiting')).toBe('still-waiting');
    expect(externalAnswerAction('Unblocked')).toBe('clear-blocker');
    expect(externalAnswerAction('LOKE sent them')).toBe('decision');
    expect(derivedAnswerPreview({ id: 'external-n1' }, 'Still waiting')?.[0]).toContain('asked again in 7 days');
    expect(derivedAnswerPreview({ id: 'question-n1' }, 'Stripe')?.[0]).toContain('Decision (…): Stripe');
  });

  it('answerer names go by first name', () => {
    expect(answererName('Dan Haas')).toBe('Dan');
    expect(answererName(null)).toBe('Dan');
  });
});
