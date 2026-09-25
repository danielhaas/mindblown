/**
 * `list_attachments` — every file and link in a map, in one flat list.
 *
 * The read-side sibling of the Files tab. `get_map` shows attachments under
 * each node, which answers "what hangs on this node?"; this answers "where
 * is the spec?" without paging through the tree. Same rows the tab shows,
 * same order (newest first), so a person and an agent looking at the same
 * map agree on what is there.
 *
 * Pure: takes the map payload, returns text. Kept out of index.ts so it
 * can be tested without the MCP server.
 */

import type { MapDetail, NodeWithComputed } from './api.js';

export interface AttachmentRow {
  id: string;
  kind: 'file' | 'link';
  url: string;
  title: string;
  mimeType: string | null;
  sizeBytes: number | null;
  addedAt: string;
  addedBy: string | null;
  nodeId: string;
  nodeText: string;
  /** Ancestor titles from just below the root down to the node's parent. Empty for a root-level node. */
  nodePath: string[];
  /** True when the attachment hangs on the root node — a map-level file. */
  mapLevel: boolean;
}

export interface CollectOptions {
  /** Restrict to this node and its descendants. */
  nodeId?: string;
  kind?: 'file' | 'link';
}

export type CollectResult =
  | { ok: true; rows: AttachmentRow[]; scopeLabel: string }
  | { ok: false; error: string };

export function collectAttachments(data: MapDetail, opts: CollectOptions = {}): CollectResult {
  const byId = new Map<string, NodeWithComputed>(data.nodes.map((n) => [n.id, n]));
  const rootId = data.map.rootNodeId;

  let inScope: (n: NodeWithComputed) => boolean = () => true;
  let scopeLabel = 'whole map';
  if (opts.nodeId) {
    const root = byId.get(opts.nodeId);
    if (!root) return { ok: false, error: `Node ${opts.nodeId} not found in map ${data.map.id}.` };
    const subtree = new Set<string>();
    const stack = [root.id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (subtree.has(id)) continue;
      subtree.add(id);
      for (const c of byId.get(id)?.childrenIds ?? []) stack.push(c);
    }
    inScope = (n) => subtree.has(n.id);
    scopeLabel = `subtree of "${root.text}" (${root.id})`;
  }

  const pathOf = (n: NodeWithComputed): string[] => {
    const parts: string[] = [];
    let cur = n.parentId ? byId.get(n.parentId) : undefined;
    // Stop below the root: the root is the map, and the tab prints "Map".
    while (cur && cur.id !== rootId) {
      parts.unshift(cur.text);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return parts;
  };

  const rows: AttachmentRow[] = [];
  for (const n of data.nodes) {
    if (!inScope(n)) continue;
    for (const a of n.attachments ?? []) {
      if (opts.kind && a.kind !== opts.kind) continue;
      rows.push({
        id: a.id,
        kind: a.kind,
        url: a.url,
        title: a.title,
        mimeType: a.mimeType ?? null,
        sizeBytes: a.sizeBytes ?? null,
        addedAt: a.addedAt,
        addedBy: a.addedBy ?? null,
        nodeId: n.id,
        nodeText: n.text,
        nodePath: pathOf(n),
        mapLevel: n.id === rootId,
      });
    }
  }
  rows.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  return { ok: true, rows, scopeLabel };
}

function formatSize(bytes: number | null): string {
  if (bytes == null || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

export function formatAttachmentList(data: MapDetail, opts: CollectOptions = {}): string {
  const res = collectAttachments(data, opts);
  if (!res.ok) return `Error: ${res.error}`;
  const { rows, scopeLabel } = res;
  const kindLabel = opts.kind ? `${opts.kind}s` : 'attachments';
  if (rows.length === 0) {
    return `No ${kindLabel} in ${scopeLabel}. Hang one with attach_link or attach_file (root node id ${data.map.rootNodeId} for a map-level file).`;
  }
  const files = rows.filter((r) => r.kind === 'file').length;
  const lines = [
    `# Attachments — ${data.map.name}`,
    `${rows.length} ${kindLabel} in ${scopeLabel} (${files} file${files === 1 ? '' : 's'}, ${rows.length - files} link${rows.length - files === 1 ? '' : 's'}), newest first.`,
    '',
  ];
  for (const r of rows) {
    const where = r.mapLevel ? 'Map' : [...r.nodePath, r.nodeText].join(' › ');
    const meta = [r.kind, r.mimeType ?? undefined, formatSize(r.sizeBytes) || undefined]
      .filter(Boolean)
      .join(', ');
    lines.push(`- **${r.title}** (${meta}) — ${r.url}`);
    lines.push(`  on: ${where}${r.mapLevel ? '' : ` (node ${r.nodeId})`} · added ${r.addedAt.slice(0, 10)} · attachment id ${r.id}`);
  }
  return lines.join('\n');
}
