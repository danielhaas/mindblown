/**
 * The attachment rules themselves, not the wiring.
 *
 * The route test above these mocks the DB layer, which means it proves the
 * HTTP surface calls the right function and nothing about what that
 * function does. A mutation run made that concrete: deleting the URL check,
 * making "add" replace instead of append, and making a delete of an unknown
 * id report success all left the route suite fully green.
 *
 * `buildAttachment` is pure and carries every rule worth arguing about, so
 * it is tested directly. `addAttachment` is that plus one SQL statement —
 * the append is `attachments || …::jsonb` in Postgres, which a stub handle
 * cannot evaluate. What is checkable here is that a statement was issued
 * and how the function behaves when it matches nothing; the concurrency
 * property itself was checked against a live Postgres.
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  addAttachment,
  buildAttachment,
  removeAttachment,
  AttachmentValidationError,
  type DbHandle,
} from '../nodes.js';
import type { Attachment } from '@mindblown/core';

// ── The rules ─────────────────────────────────────────────────────

describe('buildAttachment', () => {
  it('refuses a URL that would become a live href in the UI', () => {
    // Every attachment renders as an `<a href>` in two places. This is the
    // only thing between a stored `javascript:` and a click — React does
    // not sanitise href, it warns in dev and renders.
    for (const url of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\nscript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
      'file:///etc/passwd',
      'blob:http://example.com/x',
      '//evil.com',
      '/relative',
      'example.com',
      '',
      '   ',
    ]) {
      expect(() => buildAttachment({ kind: 'link', url })).toThrow(AttachmentValidationError);
    }
  });

  it('accepts the two schemes a browser can actually follow', () => {
    expect(buildAttachment({ kind: 'link', url: 'https://example.com/a' }).url).toBe(
      'https://example.com/a',
    );
    expect(buildAttachment({ kind: 'link', url: 'http://intranet.local/b' }).url).toBe(
      'http://intranet.local/b',
    );
  });

  it('stores the parsed URL, not the raw string', () => {
    // A leading control character is stripped by the WHATWG parser, so the
    // raw and resolved forms differ. Storing the resolved one means no
    // consumer has to decide which it got.
    expect(buildAttachment({ kind: 'link', url: 'https://example.com/x' }).url).toBe(
      'https://example.com/x',
    );
  });

  it('refuses a non-string url or title instead of throwing a TypeError', () => {
    // The route only checks the field is present, so `{"url": 5}` gets
    // here. `.trim()` on a number would be an unhandled 500 for what is
    // plainly a bad request.
    expect(() => buildAttachment({ kind: 'link', url: 5 as unknown as string })).toThrow(
      AttachmentValidationError,
    );
    expect(() =>
      buildAttachment({ kind: 'link', url: 'https://example.com', title: {} as unknown as string }),
    ).toThrow(AttachmentValidationError);
    expect(() => buildAttachment({ kind: 'link', url: null as unknown as string })).toThrow(
      AttachmentValidationError,
    );
  });

  it('refuses a kind outside the two we render', () => {
    expect(() =>
      buildAttachment({ kind: 'script' as unknown as 'link', url: 'https://example.com' }),
    ).toThrow(AttachmentValidationError);
  });

  it('caps the URL so one node cannot swallow a megabyte of jsonb', () => {
    const long = 'https://example.com/' + 'a'.repeat(3000);
    expect(() => buildAttachment({ kind: 'link', url: long })).toThrow(AttachmentValidationError);
  });

  it('derives a title rather than showing a raw URL', () => {
    // Files fall back to the filename…
    expect(
      buildAttachment({
        kind: 'file',
        url: 'https://mind.project.li/api/media/abc/Bericht.xlsx.bin',
      }).title,
    ).toBe('Bericht.xlsx.bin');
    // …links to the host, which is the useful half of a long URL.
    expect(
      buildAttachment({ kind: 'link', url: 'https://www.gesetze.li/konso/2009341000' }).title,
    ).toBe('www.gesetze.li');
  });

  it('keeps a title the caller gave, trimmed and capped', () => {
    expect(
      buildAttachment({ kind: 'link', url: 'https://example.com', title: '  Spezifikation  ' })
        .title,
    ).toBe('Spezifikation');
    expect(
      buildAttachment({ kind: 'link', url: 'https://example.com', title: 'x'.repeat(500) }).title,
    ).toHaveLength(200);
  });

  it('drops file-only fields from a link, so the UI never shows it a size', () => {
    const a = buildAttachment({
      kind: 'link',
      url: 'https://example.com',
      mimeType: 'video/mp4',
      sizeBytes: 999,
    });
    expect(a.mimeType).toBeNull();
    expect(a.sizeBytes).toBeNull();
  });

  it('records who added it and when', () => {
    const a = buildAttachment({ kind: 'link', url: 'https://example.com' }, 'user-7');
    expect(a.addedBy).toBe('user-7');
    expect(Date.parse(a.addedAt)).not.toBeNaN();
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ── The statement ─────────────────────────────────────────────────

/**
 * Models `update().set().where().returning()` and `select().from().where()`.
 * `matched` decides whether the UPDATE's WHERE hit a row — standing in for
 * "node exists and is below the ceiling", which is a predicate Postgres
 * evaluates and this stub cannot.
 */
function stubHandle(opts: { matched: boolean; nodeExists?: boolean }): {
  handle: DbHandle;
  setValues: () => Record<string, unknown> | undefined;
  whereConditions: () => unknown[];
} {
  let setValues: Record<string, unknown> | undefined;
  const wheres: unknown[] = [];

  const handle = {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          wheres.push(cond);
          return Promise.resolve(opts.nodeExists === false ? [] : [{ id: 'n1' }]);
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        setValues = values;
        return {
          where: (cond: unknown) => {
            wheres.push(cond);
            return {
              returning: () =>
                Promise.resolve(
                  opts.matched
                    ? [{ id: 'n1', mapId: 'm1', attachments: [], externalLinks: [] }]
                    : [],
                ),
            };
          },
        };
      },
    }),
  } as unknown as DbHandle;

  return { handle, setValues: () => setValues, whereConditions: () => wheres };
}

/**
 * Flatten a drizzle SQL fragment to text.
 *
 * `JSON.stringify` on one yields `{}` — the pieces live in `queryChunks`,
 * a mix of string chunks, column references and bound params. Walking it
 * is the only way to assert what statement was actually built.
 */
function sqlText(fragment: unknown): string {
  const seen = new Set<unknown>();
  const walk = (v: unknown): string => {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    if (Array.isArray(v)) return v.map(walk).join(' ');
    if (typeof v === 'object') {
      if (seen.has(v)) return '';
      seen.add(v);
      const o = v as Record<string, unknown>;
      const parts = [o.constructor?.name ?? '', ...Object.values(o).map(walk)];
      return parts.join(' ');
    }
    return '';
  };
  return walk(fragment);
}

describe('addAttachment', () => {
  it('appends in SQL rather than writing an array it computed', async () => {
    // The property this pins is intent, not outcome: a `set({attachments:
    // [...]})` would be a plain array here, and that shape is exactly the
    // lost update two concurrent adds produce.
    const { handle, setValues } = stubHandle({ matched: true });

    await addAttachment('n1', { kind: 'link', url: 'https://example.com' }, 'user-1', handle);

    const written = setValues()!.attachments;
    // A read-modify-write implementation puts a plain array here — and that
    // shape is exactly the lost update two concurrent adds produce.
    expect(Array.isArray(written)).toBe(false);
    expect(sqlText(written)).toContain('jsonb');
  });

  it('carries the ceiling as a predicate, not a prior read', async () => {
    const { handle, whereConditions } = stubHandle({ matched: true });

    await addAttachment('n1', { kind: 'link', url: 'https://example.com' }, null, handle);

    expect(sqlText(whereConditions())).toContain('jsonb_array_length');
  });

  it('never touches the database when the input is bad', async () => {
    const { handle, setValues } = stubHandle({ matched: true });

    await expect(
      addAttachment('n1', { kind: 'link', url: 'javascript:alert(1)' }, null, handle),
    ).rejects.toBeInstanceOf(AttachmentValidationError);

    expect(setValues()).toBeUndefined();
  });

  it('says "full" when the node is there but the write matched nothing', async () => {
    const { handle } = stubHandle({ matched: false, nodeExists: true });

    await expect(
      addAttachment('n1', { kind: 'link', url: 'https://example.com' }, null, handle),
    ).rejects.toThrow(/Höchstens 50/);
  });

  it('says "not found" when the node is gone', async () => {
    const { handle } = stubHandle({ matched: false, nodeExists: false });

    await expect(
      addAttachment('gone', { kind: 'link', url: 'https://example.com' }, null, handle),
    ).rejects.toThrow(/not found/);
  });
});

// ── Removal ───────────────────────────────────────────────────────

function removalHandle(initial: Attachment[] | null): {
  handle: DbHandle;
  written: () => Attachment[] | undefined;
  updateCalls: () => number;
} {
  let written: Attachment[] | undefined;
  let updates = 0;
  const row = initial === null ? undefined : { attachments: initial };

  const handle = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(row ? [row] : []) }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates += 1;
        written = values.attachments as Attachment[];
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([{ id: 'n1', mapId: 'm1', attachments: written, externalLinks: [] }]),
          }),
        };
      },
    }),
  } as unknown as DbHandle;

  return { handle, written: () => written, updateCalls: () => updates };
}

const existing = (n: number): Attachment[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `att-${i}`,
    kind: 'link' as const,
    url: `https://example.com/${i}`,
    title: `Link ${i}`,
    addedAt: '2026-08-01T00:00:00.000Z',
  }));

describe('removeAttachment', () => {
  // Removal stays read-modify-write on purpose: it is idempotent, so a
  // concurrent remove of a *different* id is the only losable case, and
  // that costs a re-click rather than silent data loss.
  it('removes exactly one and leaves its neighbours in order', async () => {
    const { handle, written } = removalHandle(existing(3));

    await removeAttachment('n1', 'att-1', handle);

    expect(written()!.map((a) => a.id)).toEqual(['att-0', 'att-2']);
  });

  it('returns null for an id this node does not carry, and writes nothing', async () => {
    // Without this the route answers 200 for a delete that deleted
    // nothing, and the UI removes a row that is still in the database.
    const { handle, updateCalls } = removalHandle(existing(2));

    expect(await removeAttachment('n1', 'att-does-not-exist', handle)).toBeNull();
    expect(updateCalls()).toBe(0);
  });

  it('returns null for a node that is not there', async () => {
    const { handle } = removalHandle(null);
    expect(await removeAttachment('gone', 'att-0', handle)).toBeNull();
  });
});

// ── The boundary this all rests on ────────────────────────────────

describe('the generic update path cannot write attachments', () => {
  /**
   * `buildAttachment` is only a boundary if it is the *only* way into the
   * column. Today it is — `UpdateNodeInput` has no `attachments` field and
   * `updateNode`'s field-mapping block has no line for it — so every URL
   * stored has been through the scheme check.
   *
   * That property is held entirely by the absence of a line. Someone adds
   * `attachments?: Attachment[]` next quarter for a bulk import, the
   * `javascript:` door opens at both render sites, and nothing else in the
   * suite notices. This is the test that notices.
   */
  it('has no attachments line in updateNode', async () => {
    const source = await readFile(new URL('../nodes.ts', import.meta.url), 'utf8');

    const start = source.indexOf('export async function updateNode');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\nexport ', start + 1);
    const body = source.slice(start, end === -1 ? undefined : end);

    // If you are here because this failed: adding attachments to the
    // generic update path means the URL scheme check is no longer a
    // boundary. Route the write through `addAttachment`, or validate in
    // `updateNode` too — do not just delete this test.
    expect(body).not.toMatch(/updates\.attachments\s*=/);
    expect(body).not.toMatch(/input\.attachments/);
  });

  it('has no attachments field on UpdateNodeInput', async () => {
    const source = await readFile(new URL('../nodes.ts', import.meta.url), 'utf8');

    const start = source.indexOf('export interface UpdateNodeInput');
    expect(start).toBeGreaterThan(-1);
    const shape = source.slice(start, source.indexOf('}', start));

    expect(shape).not.toMatch(/\battachments\b/);
  });
});
