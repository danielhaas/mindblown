/**
 * Which collector's changed question text under an answered id is a new
 * question (db/asks replaceAsks). The upsert SQL itself was checked against
 * Postgres 16 (PR #594); this pins whose pushes may reopen.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../connection.js', () => ({ db: {} }));

import { reopensOnNewText } from '../asks.js';

describe('reopensOnNewText', () => {
  it('the fleet worker: one id per ticket, new text = its next question', () => {
    expect(reopensOnNewText({ sources: ['fleet-worker'] })).toBe(true);
  });

  it('not the leidang collector, whose text changes every tick under the same id', () => {
    expect(reopensOnNewText({ sources: ['decision.json', 'pending-notes'] })).toBe(false);
    expect(reopensOnNewText({ sources: [] })).toBe(false);
    expect(reopensOnNewText({} as never)).toBe(false);
  });
});
