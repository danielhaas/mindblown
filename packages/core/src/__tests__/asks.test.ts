/**
 * Asks inbox — the pure parts: the collector contract survives parsing,
 * the write plan matches leidang-asks-apply's decision table, the
 * description prepend does not corrupt a ProseMirror doc, and the digest
 * counts what the terminal --digest counts.
 */
import { describe, it, expect } from 'vitest';
import {
  parseAskDocument,
  planAskWrites,
  prependDecision,
  decisionLine,
  decisionCommentBody,
  sortAsks,
  isNoQuestion,
  isVersionOnly,
  countAsks,
  digestAsks,
  formatAskDigest,
} from '../asks.js';
import type { Ask, AskRow } from '../asks.js';

const DATE = '2026-09-03';

function ask(over: Partial<Ask> = {}): Ask {
  return {
    id: '#6823',
    ticket: 6823,
    requirement: null,
    title: '#6823 Avione Migrationsskript',
    url: 'https://github.com/FulcrumCRM/crm/issues/6823',
    sources: ['tick:decision', 'github:human'],
    question: 'Skip or keep the legacy table? (skip / keep+cleanup)',
    question_author: 'worker',
    options: ['skip', 'keep+cleanup'],
    answerer: 'Dan',
    answerers: ['Dan'],
    hint: 'decision',
    priority: 'P1',
    milestone: null,
    needs_version: false,
    labels: [],
    idle_hours: 30,
    unblocks: { node_id: 'n1n1n1n1-0000', node_title: 'Avione', node_status: 'blocked', claimed_by: null, worker: null, pr: null, pr_state: null },
    moot: false,
    ...over,
  };
}

function row(a: Ask, over: Partial<AskRow> = {}): AskRow {
  return { ask: a, status: 'open', pushedAt: '2026-09-03T10:00:00Z', firstSeenAt: '2026-09-03T10:00:00Z', answer: null, answeredBy: null, answeredAt: null, writes: [], workerPending: false, ...over };
}

describe('parseAskDocument', () => {
  it('accepts a collector document and drops malformed / duplicate items', () => {
    const doc = parseAskDocument({
      meta: { generated_at: '2026-09-03T08:00:00', tick: '20260903T0800Z', map_id: 'm1' },
      items: [ask(), { id: 'dup' }, ask({ id: '#1' }), ask({ id: '#1' }), 'nope'],
    });
    expect(doc).not.toBeNull();
    expect(doc!.items.map((i) => i.id)).toEqual(['#6823', '#1']);
    expect(doc!.meta.tick).toBe('20260903T0800Z');
  });

  it('rejects anything without items[]', () => {
    expect(parseAskDocument({ meta: {} })).toBeNull();
    expect(parseAskDocument(null)).toBeNull();
  });

  it('defaults answerer/hint and tolerates missing unblocks', () => {
    const doc = parseAskDocument({ items: [{ id: 'q:x', question: 'y' }] });
    const a = doc!.items[0];
    expect(a.answerer).toBe('Dan');
    expect(a.hint).toBe('decision');
    expect(a.unblocks.node_id).toBeNull();
    expect(a.options).toEqual([]);
  });
});

describe('decision text', () => {
  it('is the apply script\'s line, on the issue and in the node', () => {
    expect(decisionLine('Dan', 'skip', DATE)).toBe('Entscheid (Dan, 2026-09-03): skip');
    expect(decisionCommentBody('Dan', 'skip', DATE)).toBe('**Entscheid (Dan, 2026-09-03): skip**\n\n_via /leidang-asks_');
  });

  it('prepends to a string description and to an empty one', () => {
    expect(prependDecision('old text', 'L')).toBe('**L**\n\nold text');
    expect(prependDecision(null, 'L')).toBe('**L**');
    expect(prependDecision('', 'L')).toBe('**L**');
  });

  it('inserts a bold paragraph into a ProseMirror doc instead of corrupting it', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'old' }] }] };
    const out = prependDecision(doc, 'L') as { type: string; content: unknown[] };
    expect(out.type).toBe('doc');
    expect(out.content).toHaveLength(2);
    expect(out.content[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'L', marks: [{ type: 'bold' }] }] });
    expect(doc.content).toHaveLength(1); // input untouched
  });
});

describe('planAskWrites — apply\'s decision table', () => {
  const answered = { action: 'answered' as const, decision: 'skip', by: 'Dan' };

  it('ticket + node: comment and requeue', () => {
    const p = planAskWrites(ask(), answered, { status: 'blocked', claimedBySession: null, isDone: false }, DATE);
    expect(p.github).toEqual({ ticket: 6823, body: decisionCommentBody('Dan', 'skip', DATE), milestone: null });
    expect(p.node).toEqual({ nodeId: 'n1n1n1n1-0000', requeue: true, why: expect.stringContaining('todo') });
    expect(p.worker).toBeNull();
    expect(p.skip).toBeNull();
  });

  it('never re-opens a done node, keeps a claimed node\'s status, honours noRequeue', () => {
    expect(planAskWrites(ask(), answered, { status: 'done', claimedBySession: null, isDone: true }, DATE).node!.requeue).toBe(false);
    const claimed = planAskWrites(ask(), answered, { status: 'in_progress', claimedBySession: 'sat3:worker-2', isDone: false }, DATE);
    expect(claimed.node!.requeue).toBe(false);
    expect(claimed.node!.why).toContain('sat3:worker-2');
    expect(planAskWrites(ask(), { ...answered, noRequeue: true }, { status: 'blocked', claimedBySession: null, isDone: false }, DATE).node!.requeue).toBe(false);
  });

  it('falls back to the collector\'s node_status/claimed_by when the node was not looked up', () => {
    const p = planAskWrites(ask({ unblocks: { ...ask().unblocks, node_status: 'done' } }), answered, null, DATE);
    expect(p.node!.requeue).toBe(false);
  });

  it('moot: nothing is written', () => {
    const p = planAskWrites(ask({ moot: true, unblocks: { ...ask().unblocks, worker: 'sat3:worker-1', pr: 6869, pr_state: 'MERGED' } }), answered, null, DATE);
    expect(p.skip).toContain('MERGED');
    expect(p.github).toBeNull();
    expect(p.node).toBeNull();
    expect(p.worker).toBeNull();
  });

  it('milestone only travels when the ticket carried NEEDS-VERSION', () => {
    expect(planAskWrites(ask(), { ...answered, milestone: 'V1.5' }, null, DATE).github!.milestone).toBeNull();
    expect(planAskWrites(ask({ needs_version: true }), { ...answered, milestone: 'V1.5' }, null, DATE).github!.milestone).toBe('V1.5');
  });

  it('a worker question is flagged, not written, and later/delegate write nothing', () => {
    const p = planAskWrites(ask({ unblocks: { ...ask().unblocks, worker: 'sat3:worker-2' } }), answered, null, DATE);
    expect(p.worker).toEqual({ worker: 'sat3:worker-2' });
    expect(planAskWrites(ask(), { action: 'later' }, null, DATE)).toMatchObject({ github: null, node: null, worker: null, skip: expect.stringContaining('vertagt') });
    expect(planAskWrites(ask(), { action: 'delegate', delegateTo: 'Rita' }, null, DATE).skip).toContain('Rita');
  });
});

describe('reading', () => {
  it('orders answerer → priority → idle', () => {
    const rows = [
      row(ask({ id: 'r', answerer: 'Rita', priority: 'P0' })),
      row(ask({ id: 'd2', answerer: 'Dan', priority: 'P2', idle_hours: 5 })),
      row(ask({ id: 'd1', answerer: 'Dan', priority: 'P2', idle_hours: 50 })),
      row(ask({ id: 'd0', answerer: 'Dan', priority: null, idle_hours: 999 })),
    ];
    expect(sortAsks(rows).map((r) => r.ask.id)).toEqual(['d1', 'd2', 'd0', 'r']);
  });

  it('folds already-decided / parked-plan and the NEEDS-VERSION-only tickets', () => {
    expect(isNoQuestion(ask({ hint: 'parked-plan' }))).toBe(true);
    expect(isNoQuestion(ask({ hint: 'decision' }))).toBe(false);
    expect(isVersionOnly(ask({ sources: ['github:needs-version'] }))).toBe(true);
    expect(isVersionOnly(ask({ sources: ['github:needs-version', 'tick:map'] }))).toBe(false);
  });

  it('counts by answerer, hint and status', () => {
    const c = countAsks([row(ask()), row(ask({ id: 'x', answerer: 'Rita', hint: 'ops-task' }), { status: 'later' })]);
    expect(c).toEqual({ total: 2, byAnswerer: { Dan: 1, Rita: 1 }, byHint: { decision: 1, 'ops-task': 1 }, byStatus: { open: 1, later: 1 } });
  });

  it('digest sums a run like --digest', () => {
    const rows: AskRow[] = [
      row(ask(), {
        status: 'answered',
        answeredAt: '2026-09-03T11:00:00Z',
        answer: { action: 'answered', decision: 'skip' },
        writes: [
          { kind: 'gh-comment', target: '#6823', detail: '', done: true },
          { kind: 'mb-put', target: 'n1n1n1n1', detail: 'status → todo', done: true },
        ],
      }),
      row(ask({ id: '#2', ticket: 2 }), { status: 'later', answeredAt: '2026-09-03T11:00:00Z' }),
      row(ask({ id: '#3', ticket: 3 }), { status: 'delegated', answeredAt: '2026-09-03T11:00:00Z', answer: { action: 'delegate', delegateTo: 'Rita' } }),
      row(ask({ id: '#4', ticket: 4 }), { status: 'answered', answeredAt: '2026-09-01T11:00:00Z' }), // before since
      row(ask({ id: '#5', ticket: 5 })),
    ];
    const d = digestAsks(rows, '2026-09-03T00:00:00Z');
    expect(d).toEqual({ answered: 1, later: 1, delegated: 1, tickets: ['#6823'], requeued: ['n1n1n1n1'], delegated_to: ['#3→Rita'], workerPending: [] });
    expect(formatAskDigest(d, '2026-09-03')).toBe('/leidang-asks 2026-09-03: 1 beantwortet, 1 vertagt, 1 delegiert · Tickets #6823 · wieder pullbar: n1n1n1n1 · delegiert: #3→Rita');
  });
});
