/**
 * What the change log actually records for a node update.
 *
 * The list of tracked fields is a plain Set, so a field can only be
 * "audited" or "invisible" — there is no partial state and no error when a
 * field is missing, which is why the omission of the Abnahme fields went
 * unnoticed. These cases assert on the emitted events rather than on the
 * Set's membership: the point is that an edit to the Prüfanleitung leaves a
 * row behind, not that a string appears in a list.
 *
 * Why it matters for the Abnahme surface specifically: the verdicts are
 * append-only, but the text a reviewer signed off against was not. Without
 * these events the register can say who accepted a requirement and cannot
 * say what the requirement told him to check at the time.
 *
 * DB layer is stubbed — this file is about the diff, not about Postgres
 * (see the note in vitest.config.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type LoggedRow = { fieldName: string; oldValue: unknown; newValue: unknown };

const valuesMock = vi.fn(async (_row: LoggedRow) => undefined);
const insertMock = vi.fn((_table: unknown) => ({ values: valuesMock }));

vi.mock('../connection.js', () => ({
  db: { insert: (table: unknown) => insertMock(table) },
  pool: {},
}));

import { recordFieldChanges, TRACKED_FIELDS } from '../events.js';

const MAP_ID = 'mmmm-mmmm';
const NODE_ID = 'nnnn-nnnn';
const USER_ID = 'uuuu-uuuu';

const ANLEITUNG = '1. Als Treuhänder einloggen\n2. Mandat öffnen';

/** The field/old/new triples the log would have written. */
function loggedFields(): LoggedRow[] {
  return valuesMock.mock.calls.map(([row]) => ({
    fieldName: row.fieldName,
    oldValue: row.oldValue,
    newValue: row.newValue,
  }));
}

beforeEach(() => {
  valuesMock.mockClear();
  insertMock.mockClear();
});

describe('recordFieldChanges — Abnahme fields', () => {
  it('records an event when the Prüfanleitung text is rewritten', async () => {
    await recordFieldChanges(
      MAP_ID,
      NODE_ID,
      USER_ID,
      { verificationText: ANLEITUNG },
      { verificationText: ANLEITUNG + '\n3. Badge prüfen' },
    );

    // Both values, not just the field name: reconstructing what was signed
    // off needs the text that was replaced, not the fact that it changed.
    expect(loggedFields()).toEqual([
      {
        fieldName: 'verificationText',
        oldValue: ANLEITUNG,
        newValue: ANLEITUNG + '\n3. Badge prüfen',
      },
    ]);
  });

  it('records an event when either verification URL is repointed', async () => {
    await recordFieldChanges(
      MAP_ID,
      NODE_ID,
      USER_ID,
      { verificationUrl: 'https://staging.example.com/a', verificationVideoUrl: null },
      {
        verificationUrl: 'https://staging.example.com/b',
        verificationVideoUrl: 'https://v.example.com/x.mp4',
      },
    );

    const byField = new Map(loggedFields().map((e) => [e.fieldName, e]));
    expect([...byField.keys()].sort()).toEqual(['verificationUrl', 'verificationVideoUrl']);
    expect(byField.get('verificationUrl')).toEqual({
      fieldName: 'verificationUrl',
      oldValue: 'https://staging.example.com/a',
      newValue: 'https://staging.example.com/b',
    });
    expect(byField.get('verificationVideoUrl')?.oldValue).toBeNull();
  });

  it('records the first write, when the field goes from unset to set', async () => {
    // Annotating a requirement that never had a Prüfanleitung is the common
    // case; null → text must not be mistaken for "nothing changed".
    await recordFieldChanges(
      MAP_ID,
      NODE_ID,
      USER_ID,
      { verificationText: null },
      { verificationText: ANLEITUNG },
    );
    expect(loggedFields()).toEqual([
      { fieldName: 'verificationText', oldValue: null, newValue: ANLEITUNG },
    ]);
  });

  it('stays silent when the Abnahme fields are untouched', async () => {
    await recordFieldChanges(
      MAP_ID,
      NODE_ID,
      USER_ID,
      { text: 'before', verificationText: ANLEITUNG },
      { text: 'after', verificationText: ANLEITUNG },
    );
    expect(loggedFields().map((e) => e.fieldName)).toEqual(['text']);
  });

  it('keeps all three fields on the tracked list', () => {
    // Belt to the braces above: a future edit to the Set can't quietly drop
    // one of the three while the other two keep the suite green.
    for (const f of ['verificationText', 'verificationUrl', 'verificationVideoUrl'] as const) {
      expect(TRACKED_FIELDS.has(f)).toBe(true);
    }
  });
});
