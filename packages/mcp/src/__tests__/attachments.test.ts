import { describe, it, expect } from 'vitest';
import { collectAttachments, formatAttachmentList } from '../attachments.js';
import type { MapDetail, NodeWithComputed } from '../api.js';

function node(
  id: string,
  text: string,
  parentId: string | null,
  childrenIds: string[],
  attachments: NodeWithComputed['attachments'] = [],
): NodeWithComputed {
  return { id, text, parentId, childrenIds, attachments } as unknown as NodeWithComputed;
}

const data: MapDetail = {
  map: { id: 'map-1', name: 'Demo', rootNodeId: 'root' },
  nodes: [
    node('root', 'Demo', null, ['epic'], [
      { id: 'a-map', kind: 'file', url: 'https://x/api/media/1/prospekt.pdf', title: 'prospekt.pdf', mimeType: 'application/pdf', sizeBytes: 2048, addedAt: '2026-09-20T10:00:00Z', addedBy: 'u1' },
    ]),
    node('epic', 'Epic A', 'root', ['leaf']),
    node('leaf', 'Leaf 1', 'epic', [], [
      { id: 'a-link', kind: 'link', url: 'https://example.com/spec', title: 'Spec', addedAt: '2026-09-25T09:00:00Z' },
      { id: 'a-old', kind: 'file', url: 'https://x/api/media/2/shot.png', title: 'shot.png', mimeType: 'image/png', sizeBytes: 500, addedAt: '2026-09-01T09:00:00Z' },
    ]),
  ],
} as unknown as MapDetail;

describe('collectAttachments', () => {
  it('flattens every attachment in the map, newest first, with the node path', () => {
    const res = collectAttachments(data);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.map((r) => r.id)).toEqual(['a-link', 'a-map', 'a-old']);
    const leafRow = res.rows.find((r) => r.id === 'a-link')!;
    expect(leafRow.nodePath).toEqual(['Epic A']);
    expect(leafRow.nodeText).toBe('Leaf 1');
    expect(leafRow.mapLevel).toBe(false);
  });

  it('marks what hangs on the root as map-level', () => {
    const res = collectAttachments(data);
    if (!res.ok) throw new Error(res.error);
    const mapRow = res.rows.find((r) => r.id === 'a-map')!;
    expect(mapRow.mapLevel).toBe(true);
    expect(mapRow.nodePath).toEqual([]);
  });

  it('scopes to a subtree and filters by kind', () => {
    const sub = collectAttachments(data, { nodeId: 'epic' });
    if (!sub.ok) throw new Error(sub.error);
    expect(sub.rows.map((r) => r.id)).toEqual(['a-link', 'a-old']);
    expect(sub.scopeLabel).toContain('Epic A');

    const files = collectAttachments(data, { kind: 'file' });
    if (!files.ok) throw new Error(files.error);
    expect(files.rows.map((r) => r.id)).toEqual(['a-map', 'a-old']);
  });

  it('names an unknown scope node instead of silently returning everything', () => {
    const res = collectAttachments(data, { nodeId: 'nope' });
    expect(res).toEqual({ ok: false, error: 'Node nope not found in map map-1.' });
  });
});

describe('formatAttachmentList', () => {
  it('prints one entry per attachment with where it hangs and the id remove_attachment needs', () => {
    const out = formatAttachmentList(data);
    expect(out).toContain('3 attachments in whole map (2 files, 1 link)');
    expect(out).toContain('- **Spec** (link) — https://example.com/spec');
    expect(out).toContain('on: Epic A › Leaf 1 (node leaf)');
    expect(out).toContain('attachment id a-link');
    expect(out).toContain('- **prospekt.pdf** (file, application/pdf, 2.0 KB)');
    expect(out).toContain('on: Map ·');
  });

  it('tells an empty scope how to add something, with the root id for a map-level file', () => {
    const out = formatAttachmentList(data, { nodeId: 'epic', kind: 'link' });
    expect(out).toContain('1 links');
    const none = formatAttachmentList({ ...data, nodes: data.nodes.map((n) => ({ ...n, attachments: [] })) });
    expect(none).toContain('No attachments in whole map');
    expect(none).toContain('root node id root');
  });
});
