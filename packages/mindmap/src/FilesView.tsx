/**
 * The Files tab — every file and link hung anywhere in the map, in one
 * list, plus the place to put what belongs to the map rather than to one
 * node.
 *
 * Attachments existed before this view, per node, in the property panel.
 * That answers "what hangs on this node?" and nothing else: a spec hung
 * three levels down is invisible unless you open that node, and a document
 * that belongs to the whole plan (a prospectus, an export) had no home at
 * all. Both are the same gap — no place where the files are *findable* —
 * and this view is that place.
 *
 * Two decisions, stated so they are not re-argued in the code:
 *
 * - **Map-level files hang on the root node.** No new column, no
 *   migration, and the existing add/remove routes carry it; the list just
 *   prints "Map" where it would print a node path. The MCP tools use the
 *   same convention (root node id).
 * - **The list is derived, not fetched.** The store already holds every
 *   node with its attachments, and the websocket keeps them current, so
 *   the rows come from a walk over `nodes` (files.ts) — the same walk the
 *   MCP `list_attachments` tool does, so both surfaces agree.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, Node } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import { collectFileRows, filterFileRows, typeLabel, type FileRow, type KindFilter } from './files.js';
import { formatSize } from './AttachmentsSection.js';
import { MediaUploadButton } from './MediaUploadButton.js';
import { isHttpUrl } from './verification.js';

// ── Palette (same slate + indigo every view carries) ────────────────

const PAPER = '#f8fafc';
const RAISED = '#ffffff';
const INK = '#1e293b';
const MUTED = '#64748b';
const FAINT = '#94a3b8';
const HAIRLINE = '#e2e8f0';
const ACCENT = '#4f46e5';
const ACCENT_SOFT = '#eef2ff';
const ACCENT_LINE = '#c7d2fe';
const DANGER = '#b91c1c';

const containerStyle: React.CSSProperties = {
  height: '100%',
  overflow: 'auto',
  padding: '20px 24px',
  background: PAPER,
  boxSizing: 'border-box',
};

const chipStyle = (active: boolean): React.CSSProperties => ({
  padding: '3px 10px',
  borderRadius: 999,
  border: `1px solid ${active ? ACCENT_LINE : HAIRLINE}`,
  background: active ? ACCENT_SOFT : RAISED,
  color: active ? ACCENT : MUTED,
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
});

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 600,
  color: MUTED,
  padding: '6px 10px',
  borderBottom: `1px solid ${HAIRLINE}`,
  whiteSpace: 'nowrap',
};

const tdStyle: React.CSSProperties = {
  fontSize: 12,
  color: INK,
  padding: '7px 10px',
  borderBottom: `1px solid ${HAIRLINE}`,
  verticalAlign: 'top',
};

type UploadState = { name: string; fraction: number } | null;

export function FilesView() {
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);
  const nodes = useMindmapStore((s) => s.nodes);
  const members = useMindmapStore((s) => s.members);
  const loadMembers = useMindmapStore((s) => s.loadMembers);
  const applyServerNode = useMindmapStore((s) => s.applyServerNode);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const setActiveView = useMindmapStore((s) => s.setActiveView);
  const setFocusNode = useMindmapStore((s) => s.setFocusNode);

  const [kind, setKind] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadState>(null);
  const [dragOver, setDragOver] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);

  // "Added by" needs names; the store loads them once per map.
  useEffect(() => {
    void loadMembers();
  }, [currentMapId, loadMembers]);

  const nameOf = useMemo(() => {
    const m = new Map(members.map((u) => [u.userId, u.name]));
    return (userId: string | null | undefined) => (userId ? m.get(userId) ?? null : null);
  }, [members]);

  const rows = useMemo(() => collectFileRows(nodes, rootNodeId), [nodes, rootNodeId]);
  const visible = useMemo(() => filterFileRows(rows, kind, query), [rows, kind, query]);
  const fileCount = rows.filter((r) => r.attachment.kind === 'file').length;

  /** Hang something on the root — the map's own shelf. */
  async function attachToMap(input: api.NewAttachment): Promise<void> {
    if (!currentMapId || !rootNodeId) return;
    applyServerNode(await api.addAttachment(currentMapId, rootNodeId, input));
  }

  /** Upload dropped/picked files one after another, each landing on the root. */
  async function uploadFiles(files: FileList | File[]): Promise<void> {
    setError(null);
    for (const file of Array.from(files)) {
      try {
        setUpload({ name: file.name, fraction: 0 });
        const media = await api.uploadMedia(file, (fraction) => setUpload({ name: file.name, fraction }));
        await attachToMap({
          kind: 'file',
          url: media.url,
          title: media.displayName || media.filename,
          mimeType: media.contentType,
          sizeBytes: media.size,
        });
      } catch (err) {
        setError(`${file.name}: ${err instanceof Error ? err.message : 'upload failed'}`);
      }
    }
    setUpload(null);
  }

  async function submitLink(): Promise<void> {
    const url = linkUrl.trim();
    if (!isHttpUrl(url)) {
      setError('Enter a full address starting with http:// or https://');
      return;
    }
    setError(null);
    try {
      await attachToMap({ kind: 'link', url, title: linkTitle.trim() || undefined });
      setLinkUrl('');
      setLinkTitle('');
      setLinkOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the link');
    }
  }

  async function remove(row: FileRow): Promise<void> {
    if (!currentMapId) return;
    if (!window.confirm(`Remove "${row.attachment.title}" from ${row.mapLevel ? 'the map' : `"${row.node.text}"`}?`)) return;
    setBusyId(row.attachment.id);
    setError(null);
    try {
      applyServerNode(await api.removeAttachment(currentMapId, row.node.id, row.attachment.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the attachment');
    } finally {
      setBusyId(null);
    }
  }

  /** Same three moves the register and the guide make. */
  const jumpToNode = (node: Node) => {
    setActiveView('mindmap');
    selectNode(node.id);
    setFocusNode(node.parentId && node.parentId !== rootNodeId ? node.parentId : null);
    (window as unknown as { __mindmapPanToNode?: (id: string) => void }).__mindmapPanToNode?.(node.id);
  };

  if (!rootNodeId || !currentMapId) {
    return (
      <div style={containerStyle}>
        <div style={{ color: MUTED, fontSize: 13 }}>Open a map to see its files.</div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, color: INK }}>Files</h2>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 3 }}>
            {rows.length} attachment{rows.length === 1 ? '' : 's'} · {fileCount} file{fileCount === 1 ? '' : 's'} ·{' '}
            {rows.length - fileCount} link{rows.length - fileCount === 1 ? '' : 's'} — everything hung anywhere in this map
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Search title, URL, node…"
            aria-label="Search files"
            style={{
              padding: '5px 9px',
              border: `1px solid ${HAIRLINE}`,
              borderRadius: 6,
              fontSize: 12,
              width: 220,
              background: RAISED,
            }}
          />
          {(['all', 'file', 'link'] as KindFilter[]).map((k) => (
            <button key={k} type="button" style={chipStyle(kind === k)} onClick={() => setKind(k)}>
              {k === 'all' ? 'All' : k === 'file' ? 'Files' : 'Links'}
            </button>
          ))}
        </div>
      </div>

      {/* The map's shelf: drop here, or pick / paste. Lands on the root node. */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length > 0) void uploadFiles(e.dataTransfer.files);
        }}
        data-testid="files-dropzone"
        style={{
          marginTop: 14,
          padding: '14px 16px',
          border: `1.5px dashed ${dragOver ? ACCENT : ACCENT_LINE}`,
          borderRadius: 8,
          background: dragOver ? ACCENT_SOFT : RAISED,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
          transition: 'background 0.1s, border-color 0.1s',
        }}
      >
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>
            {upload ? `Uploading ${upload.name}… ${Math.round(upload.fraction * 100)} %` : 'Drop files here to share them with the map'}
          </div>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
            Anything that belongs to the plan rather than to one task. To hang a file on a specific node, use the node's
            Attachments in the property panel. Anyone with a file's link can open it.
          </div>
          {upload && (
            <div style={{ height: 3, background: HAIRLINE, borderRadius: 2, overflow: 'hidden', marginTop: 8 }} role="progressbar" aria-valuenow={Math.round(upload.fraction * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ height: '100%', width: `${upload.fraction * 100}%`, background: ACCENT, transition: 'width 0.15s' }} />
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 160 }}>
          <MediaUploadButton
            label="Upload file…"
            disabled={upload != null}
            onUploaded={(media) =>
              void attachToMap({
                kind: 'file',
                url: media.url,
                title: media.displayName || media.filename,
                mimeType: media.contentType,
                sizeBytes: media.size,
              }).catch((err) => setError(err instanceof Error ? err.message : 'Could not attach the file'))
            }
          />
          {!linkOpen ? (
            <button
              type="button"
              onClick={() => {
                setLinkOpen(true);
                setTimeout(() => linkInputRef.current?.focus(), 0);
              }}
              style={{
                padding: '6px 10px',
                background: PAPER,
                color: '#475569',
                border: `1px solid ${HAIRLINE}`,
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              Add link…
            </button>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <input
                ref={linkInputRef}
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') void submitLink();
                  if (e.key === 'Escape') setLinkOpen(false);
                }}
                placeholder="https://…"
                style={{ padding: '6px 8px', border: `1px solid ${HAIRLINE}`, borderRadius: 6, fontSize: 12 }}
              />
              <input
                value={linkTitle}
                onChange={(e) => setLinkTitle(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') void submitLink();
                  if (e.key === 'Escape') setLinkOpen(false);
                }}
                placeholder="Label (optional)"
                style={{ padding: '6px 8px', border: `1px solid ${HAIRLINE}`, borderRadius: 6, fontSize: 12 }}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" onClick={() => void submitLink()} style={{ padding: '4px 10px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 4, fontSize: 11, fontWeight: 500, cursor: 'pointer' }}>
                  Add
                </button>
                <button type="button" onClick={() => { setLinkOpen(false); setError(null); }} style={{ padding: '4px 10px', background: 'transparent', color: MUTED, border: `1px solid #cbd5e1`, borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div style={{ fontSize: 12, color: DANGER, marginTop: 10 }} role="alert">
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <div style={{ marginTop: 24, color: FAINT, fontSize: 13 }}>
          Nothing shared yet. Drop a file above, or attach one to a node in the property panel — it will show up here.
        </div>
      ) : visible.length === 0 ? (
        <div style={{ marginTop: 24, color: FAINT, fontSize: 13 }}>No attachment matches that filter.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16, background: RAISED, borderRadius: 8, overflow: 'hidden' }}>
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Type</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Size</th>
              <th style={thStyle}>On</th>
              <th style={thStyle}>Added</th>
              <th style={thStyle} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <FileRowView
                key={row.attachment.id}
                row={row}
                addedBy={nameOf(row.attachment.addedBy)}
                busy={busyId === row.attachment.id}
                onJump={() => jumpToNode(row.node)}
                onRemove={() => void remove(row)}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FileRowView({
  row,
  addedBy,
  busy,
  onJump,
  onRemove,
}: {
  row: FileRow;
  addedBy: string | null;
  busy: boolean;
  onJump: () => void;
  onRemove: () => void;
}) {
  const a: Attachment = row.attachment;
  const size = a.kind === 'file' ? formatSize(a.sizeBytes) : null;
  const date = a.addedAt ? a.addedAt.slice(0, 10) : '';
  return (
    <tr>
      <td style={{ ...tdStyle, maxWidth: 360 }}>
        <span aria-hidden style={{ marginRight: 6 }}>{a.kind === 'file' ? '📎' : '🔗'}</span>
        <a
          href={a.url}
          target="_blank"
          rel="noopener noreferrer"
          title={a.url}
          style={{ color: '#1d4ed8', textDecoration: 'none', fontWeight: 500 }}
        >
          {a.title}
        </a>
      </td>
      <td style={{ ...tdStyle, color: MUTED, whiteSpace: 'nowrap' }}>{typeLabel(a)}</td>
      <td style={{ ...tdStyle, color: MUTED, textAlign: 'right', whiteSpace: 'nowrap' }}>{size ?? ''}</td>
      <td style={tdStyle}>
        {row.mapLevel ? (
          <span style={{ color: MUTED, fontStyle: 'italic' }}>Map</span>
        ) : (
          <button
            type="button"
            onClick={onJump}
            title="Show this node in the mindmap"
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: INK, fontSize: 12, textAlign: 'left' }}
          >
            {row.path.length > 0 && <span style={{ color: FAINT }}>{row.path.join(' › ')} › </span>}
            {row.node.text}
          </button>
        )}
      </td>
      <td style={{ ...tdStyle, color: MUTED, whiteSpace: 'nowrap' }}>
        {date}
        {addedBy && <span style={{ color: FAINT }}> · {addedBy}</span>}
      </td>
      <td style={{ ...tdStyle, textAlign: 'right' }}>
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          aria-label={`Remove ${a.title}`}
          title="Remove from the map"
          style={{ border: 'none', background: 'transparent', color: FAINT, cursor: busy ? 'default' : 'pointer', fontSize: 15, lineHeight: 1, padding: 0 }}
        >
          ×
        </button>
      </td>
    </tr>
  );
}
