/**
 * `addAttachment` / `removeAttachment` — the rules themselves, not the wiring.
 *
 * The route test above these mocks the DB layer, which means it proves the
 * HTTP surface calls the right function and nothing about what that
 * function does. A mutation run made that concrete: deleting the URL
 * check, making "add" replace instead of append, and making a delete of an
 * unknown id report success all left the route suite fully green.
 *
 * Driven through a stub handle rather than Postgres, the way
 * `assertPhaseIdKnown` and `mergeTags` are tested in this package.
 */

import { describe, it, expect } from 'vitest';
import {
  addAttachment,
  removeAttachment,
  AttachmentValidationError,
  type DbHandle,
} from '../nodes.js';
import type { Attachment } from '@mindblown/core';

/**
 * The two chains these functions use: `select().from().where()` resolving
 * to rows, and `update().set().where().returning()` resolving to the
 * written row. Records what was written so assertions can look at it.
 */
function stubHandle(initial: Attachment[] | null): {
  handle: DbHandle;
  written: () => Attachment[] | undefined;
  updateCalls: () => number;
} {
  let written: Attachment[] | undefined;
  let updates = 0;
  const row = initial === null ? undefined : { attachments: initial };

  const handle = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(row ? [row] : []),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates += 1;
        written = values.attachments as Attachment[];
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([
                { id: 'n1', mapId: 'm1', attachments: written, externalLinks: [] },
              ]),
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

describe('addAttachment', () => {
  it('appends — it does not replace what is already there', async () => {
    // The failure this guards: a "set the array" implementation quietly
    // drops every attachment added before this one.
    const { handle, written } = stubHandle(existing(3));

    await addAttachment('n1', { kind: 'link', url: 'https://example.com/new' }, 'user-1', handle);

    expect(written()).toHaveLength(4);
    expect(written()!.slice(0, 3).map((a) => a.id)).toEqual(['att-0', 'att-1', 'att-2']);
  });

  it('refuses a URL that would become a live href in the UI', async () => {
    // Every attachment renders as an `<a href>` in two places. This is the
    // only thing between a stored `javascript:` and a click.
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
      'file:///etc/passwd',
      '/relative',
      'example.com',
      '',
      '   ',
    ]) {
      const { handle, updateCalls } = stubHandle([]);
      await expect(
        addAttachment('n1', { kind: 'link', url }, null, handle),
      ).rejects.toBeInstanceOf(AttachmentValidationError);
      // Nothing written — not even a row with a rejected value in it.
      expect(updateCalls()).toBe(0);
    }
  });

  it('accepts the two schemes a browser can actually follow', async () => {
    for (const url of ['https://example.com/a', 'http://intranet.local/b']) {
      const { handle, written } = stubHandle([]);
      await addAttachment('n1', { kind: 'link', url }, null, handle);
      expect(written()![0].url).toBe(url);
    }
  });

  it('refuses a kind outside the two we render', async () => {
    const { handle, updateCalls } = stubHandle([]);
    await expect(
      addAttachment(
        'n1',
        { kind: 'script' as unknown as 'link', url: 'https://example.com' },
        null,
        handle,
      ),
    ).rejects.toBeInstanceOf(AttachmentValidationError);
    expect(updateCalls()).toBe(0);
  });

  it('derives a title rather than showing a raw URL', async () => {
    const { handle, written } = stubHandle([]);
    await addAttachment(
      'n1',
      { kind: 'file', url: 'https://mind.project.li/api/media/abc/Bericht.xlsx.bin' },
      null,
      handle,
    );
    // Files fall back to the filename…
    expect(written()![0].title).toBe('Bericht.xlsx.bin');

    const second = stubHandle([]);
    await addAttachment(
      'n1',
      { kind: 'link', url: 'https://www.gesetze.li/konso/2009341000' },
      null,
      second.handle,
    );
    // …links to the host, which is the useful half of a long URL.
    expect(second.written()![0].title).toBe('www.gesetze.li');
  });

  it('keeps a title the caller gave, and trims it to something storable', async () => {
    const { handle, written } = stubHandle([]);
    await addAttachment(
      'n1',
      { kind: 'link', url: 'https://example.com', title: '  Spezifikation  ' },
      null,
      handle,
    );
    expect(written()![0].title).toBe('Spezifikation');

    const long = stubHandle([]);
    await addAttachment(
      'n1',
      { kind: 'link', url: 'https://example.com', title: 'x'.repeat(500) },
      null,
      long.handle,
    );
    expect(long.written()![0].title).toHaveLength(200);
  });

  it('drops file-only fields from a link, so the UI never shows it a size', async () => {
    const { handle, written } = stubHandle([]);
    await addAttachment(
      'n1',
      { kind: 'link', url: 'https://example.com', mimeType: 'video/mp4', sizeBytes: 999 },
      null,
      handle,
    );
    expect(written()![0].mimeType).toBeNull();
    expect(written()![0].sizeBytes).toBeNull();
  });

  it('records who added it and when', async () => {
    const { handle, written } = stubHandle([]);
    await addAttachment('n1', { kind: 'link', url: 'https://example.com' }, 'user-7', handle);

    expect(written()![0].addedBy).toBe('user-7');
    expect(Date.parse(written()![0].addedAt)).not.toBeNaN();
    expect(written()![0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stops at a ceiling instead of letting one node grow without bound', async () => {
    const { handle, updateCalls } = stubHandle(existing(50));
    await expect(
      addAttachment('n1', { kind: 'link', url: 'https://example.com/x' }, null, handle),
    ).rejects.toBeInstanceOf(AttachmentValidationError);
    expect(updateCalls()).toBe(0);
  });

  it('rejects a node that is not there rather than writing into nothing', async () => {
    const { handle } = stubHandle(null);
    await expect(
      addAttachment('gone', { kind: 'link', url: 'https://example.com' }, null, handle),
    ).rejects.toBeInstanceOf(AttachmentValidationError);
  });
});

describe('removeAttachment', () => {
  it('removes exactly one and leaves its neighbours in order', async () => {
    const { handle, written } = stubHandle(existing(3));

    await removeAttachment('n1', 'att-1', handle);

    expect(written()!.map((a) => a.id)).toEqual(['att-0', 'att-2']);
  });

  it('returns null for an id this node does not carry, and writes nothing', async () => {
    // Without this the route answers 200 for a delete that deleted
    // nothing, and the UI removes a row that is still in the database.
    const { handle, updateCalls } = stubHandle(existing(2));

    const result = await removeAttachment('n1', 'att-does-not-exist', handle);

    expect(result).toBeNull();
    expect(updateCalls()).toBe(0);
  });

  it('returns null for a node that is not there', async () => {
    const { handle } = stubHandle(null);
    expect(await removeAttachment('gone', 'att-0', handle)).toBeNull();
  });
});
