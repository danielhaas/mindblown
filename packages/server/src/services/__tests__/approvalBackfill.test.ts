/**
 * The #492 backfill rule (Decision Dan, 28.10.2026): open nodes are stamped
 * by their reporter's trust today, an unknown reporter (pre-#490) counts as
 * trusted, done nodes are approved.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', () => ({ db: {} }));

import { backfillStamp } from '../approvalBackfill.js';

const at = '2026-10-28T12:00:00.000Z';
const isDone = (s: string | null) => s === 'done';
const approve = vi.fn((r: { kind: string }) =>
  r.kind === 'forge'
    ? ({ state: 'proposed', merge: 'pr-only', by: null, at: 'creation' } as const)
    : ({ state: 'approved', merge: 'auto', by: null, at: 'creation' } as const),
);
const forge = { kind: 'forge', provider: 'github', login: 'stranger' } as const;

describe('backfillStamp (#492)', () => {
  it('approves an open node with an unknown reporter, as the queue ran before', () => {
    expect(backfillStamp({ id: 'a', status: null, reportedBy: null }, isDone, approve, at)).toEqual({
      state: 'approved', merge: 'auto', by: null, at,
    });
  });
  it('stamps an open node by its reporter against the trust policy, at the backfill time', () => {
    expect(backfillStamp({ id: 'b', status: 'todo', reportedBy: forge }, isDone, approve, at)).toEqual({
      state: 'proposed', merge: 'pr-only', by: null, at,
    });
  });
  it('approves a done node whoever reported it', () => {
    expect(backfillStamp({ id: 'c', status: 'done', reportedBy: forge }, isDone, approve, at).state).toBe('approved');
  });
});
