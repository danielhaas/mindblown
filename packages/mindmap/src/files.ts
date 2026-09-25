/**
 * The Files tab's rows: every attachment in the map, flattened, with the
 * node it hangs on spelled out as a path.
 *
 * Pure so it can be tested without rendering. The view feeds it the store's
 * `nodes` record and filters the result; the MCP `list_attachments` tool
 * does the same walk server-side, so both surfaces agree on what is there.
 */

import type { Attachment, Node } from '@mindblown/core';

export interface FileRow {
  attachment: Attachment;
  node: Node;
  /** Ancestor titles from just below the root to the node's parent. */
  path: string[];
  /** Hangs on the root node — belongs to the map, not to one node. */
  mapLevel: boolean;
}

export type KindFilter = 'all' | 'file' | 'link';

export function collectFileRows(nodes: Record<string, Node>, rootNodeId: string | null): FileRow[] {
  if (!rootNodeId) return [];
  const pathOf = (n: Node): string[] => {
    const parts: string[] = [];
    let cur = n.parentId ? nodes[n.parentId] : undefined;
    while (cur && cur.id !== rootNodeId) {
      parts.unshift(cur.text);
      cur = cur.parentId ? nodes[cur.parentId] : undefined;
    }
    return parts;
  };
  const rows: FileRow[] = [];
  for (const node of Object.values(nodes)) {
    for (const attachment of node.attachments ?? []) {
      rows.push({ attachment, node, path: pathOf(node), mapLevel: node.id === rootNodeId });
    }
  }
  rows.sort((a, b) => b.attachment.addedAt.localeCompare(a.attachment.addedAt));
  return rows;
}

/** Kind chip + free text over title, URL host and the node path. */
export function filterFileRows(rows: FileRow[], kind: KindFilter, query: string): FileRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (kind !== 'all' && r.attachment.kind !== kind) return false;
    if (!q) return true;
    const hay = [r.attachment.title, r.attachment.url, r.node.text, ...r.path].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

/** A short, human type label from a MIME type: "PDF", "PNG", "Spreadsheet", … */
export function typeLabel(a: Attachment): string {
  if (a.kind === 'link') {
    try {
      return new URL(a.url).host.replace(/^www\./, '');
    } catch {
      return 'link';
    }
  }
  const mime = (a.mimeType ?? '').toLowerCase();
  if (!mime || mime === 'application/octet-stream') {
    const ext = /\.([a-z0-9]{1,8})$/i.exec(a.title)?.[1];
    return ext ? ext.toUpperCase() : 'File';
  }
  if (mime === 'application/pdf') return 'PDF';
  if (mime.startsWith('image/')) return mime.slice(6).toUpperCase();
  if (mime.startsWith('video/')) return 'Video';
  if (mime.startsWith('audio/')) return 'Audio';
  if (mime.startsWith('text/')) return 'Text';
  if (mime.includes('spreadsheet') || mime.includes('excel')) return 'Spreadsheet';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return 'Slides';
  if (mime.includes('wordprocessing') || mime.includes('msword')) return 'Document';
  if (mime.includes('zip') || mime.includes('compressed')) return 'Archive';
  if (mime === 'application/json') return 'JSON';
  return mime.split('/')[1]?.toUpperCase() ?? 'File';
}
