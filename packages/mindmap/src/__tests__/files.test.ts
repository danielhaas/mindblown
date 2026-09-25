/**
 * The Files tab's logic: which rows, in what order, with which path — and
 * the filters over them. The component itself is not rendered (no jsdom in
 * this package); everything worth pinning is in these pure helpers.
 */

import { describe, it, expect } from 'vitest';
import type { Attachment, Node } from '@mindblown/core';
import { collectFileRows, filterFileRows, typeLabel } from '../files.js';

function node(id: string, text: string, parentId: string | null, attachments: Attachment[] = []): Node {
  return { id, text, parentId, childrenIds: [], attachments } as unknown as Node;
}
function att(id: string, kind: 'file' | 'link', addedAt: string, extra: Partial<Attachment> = {}): Attachment {
  return { id, kind, url: `https://x/${id}`, title: id, addedAt, ...extra } as Attachment;
}

const nodes: Record<string, Node> = {
  root: node('root', 'Demo', null, [att('map-file', 'file', '2026-09-20T00:00:00Z', { mimeType: 'application/pdf' })]),
  epic: node('epic', 'Epic A', 'root'),
  leaf: node('leaf', 'Leaf 1', 'epic', [
    att('spec', 'link', '2026-09-25T00:00:00Z', { url: 'https://www.example.com/spec', title: 'Spec' }),
    att('shot', 'file', '2026-09-01T00:00:00Z', { mimeType: 'image/png', title: 'shot.png' }),
  ]),
};

describe('collectFileRows', () => {
  it('flattens every attachment, newest first, with the path below the root', () => {
    const rows = collectFileRows(nodes, 'root');
    expect(rows.map((r) => r.attachment.id)).toEqual(['spec', 'map-file', 'shot']);
    const spec = rows[0];
    expect(spec.node.id).toBe('leaf');
    expect(spec.path).toEqual(['Epic A']);
    expect(spec.mapLevel).toBe(false);
  });

  it('marks what hangs on the root as map-level with an empty path', () => {
    const row = collectFileRows(nodes, 'root').find((r) => r.attachment.id === 'map-file')!;
    expect(row.mapLevel).toBe(true);
    expect(row.path).toEqual([]);
  });

  it('returns nothing before a map is loaded', () => {
    expect(collectFileRows(nodes, null)).toEqual([]);
  });
});

describe('filterFileRows', () => {
  const rows = collectFileRows(nodes, 'root');

  it('narrows by kind', () => {
    expect(filterFileRows(rows, 'file', '').map((r) => r.attachment.id)).toEqual(['map-file', 'shot']);
    expect(filterFileRows(rows, 'link', '').map((r) => r.attachment.id)).toEqual(['spec']);
  });

  it('searches title, URL and the node path, case-insensitively', () => {
    expect(filterFileRows(rows, 'all', 'SPEC').map((r) => r.attachment.id)).toEqual(['spec']);
    expect(filterFileRows(rows, 'all', 'epic a').map((r) => r.attachment.id)).toEqual(['spec', 'shot']);
    expect(filterFileRows(rows, 'all', 'example.com').map((r) => r.attachment.id)).toEqual(['spec']);
    expect(filterFileRows(rows, 'all', '  ')).toHaveLength(3);
  });
});

describe('typeLabel', () => {
  it('shows the host for a link and a short type for a file', () => {
    expect(typeLabel(att('l', 'link', '', { url: 'https://www.example.com/x' }))).toBe('example.com');
    expect(typeLabel(att('p', 'file', '', { mimeType: 'application/pdf' }))).toBe('PDF');
    expect(typeLabel(att('i', 'file', '', { mimeType: 'image/png' }))).toBe('PNG');
    expect(typeLabel(att('x', 'file', '', { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))).toBe('Spreadsheet');
  });

  it('falls back to the extension when the type is unknown', () => {
    expect(typeLabel(att('b', 'file', '', { mimeType: 'application/octet-stream', title: 'dump.sql' }))).toBe('SQL');
    expect(typeLabel(att('n', 'file', '', { mimeType: null, title: 'noext' }))).toBe('File');
  });
});
