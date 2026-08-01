/**
 * The attachments list on a node: what's hung there, plus the two ways to
 * hang something new.
 *
 * Files and links share one list on purpose. To the person reading a node,
 * "the spec" is one thing whether it lives on our disk or on somebody
 * else's server — splitting them into two sections would make the reader
 * check two places for the same question.
 */

import { useState } from 'react';
import type { Attachment } from '@mindblown/core';
import { MediaUploadButton } from './MediaUploadButton.js';
import { isHttpUrl } from './verification.js';

interface Props {
  attachments: Attachment[];
  onAdd: (attachment: {
    kind: 'file' | 'link';
    url: string;
    title?: string;
    mimeType?: string | null;
    sizeBytes?: number | null;
  }) => Promise<void>;
  onRemove: (attachmentId: string) => Promise<void>;
}

/** Bytes → something a person reads without counting zeroes. */
export function formatSize(bytes: number | null | undefined): string | null {
  if (bytes == null || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  padding: '5px 8px',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  background: '#fff',
  fontSize: 12,
};

export function AttachmentsSection({ attachments, onAdd, onRemove }: Props) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function submitLink(): Promise<void> {
    const url = linkUrl.trim();
    // Checked here as well as on the server so the common typo — pasting
    // `example.com` without a scheme — is answered instantly rather than
    // as a round-trip 400.
    if (!isHttpUrl(url)) {
      setError('Bitte eine vollständige Adresse mit http:// oder https://');
      return;
    }
    setError(null);
    try {
      await onAdd({ kind: 'link', url, title: linkTitle.trim() || undefined });
      setLinkUrl('');
      setLinkTitle('');
      setLinkOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Konnte den Link nicht speichern');
    }
  }

  async function remove(id: string): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await onRemove(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Konnte den Anhang nicht entfernen');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {attachments.length === 0 && (
        <div style={{ fontSize: 11, color: '#94a3b8' }}>
          Noch nichts angehängt.
        </div>
      )}

      {attachments.map((a) => {
        const size = formatSize(a.sizeBytes);
        return (
          <div key={a.id} style={rowStyle}>
            <span aria-hidden style={{ flexShrink: 0 }}>
              {a.kind === 'file' ? '📎' : '🔗'}
            </span>
            <a
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: '#1d4ed8',
                textDecoration: 'none',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}
              title={a.url}
            >
              {a.title}
            </a>
            {size && (
              <span style={{ color: '#94a3b8', fontSize: 11, flexShrink: 0 }}>{size}</span>
            )}
            <button
              type="button"
              onClick={() => void remove(a.id)}
              onKeyDown={(e) => e.stopPropagation()}
              disabled={busyId === a.id}
              aria-label={`${a.title} entfernen`}
              style={{
                border: 'none',
                background: 'transparent',
                color: '#94a3b8',
                cursor: busyId === a.id ? 'default' : 'pointer',
                fontSize: 14,
                lineHeight: 1,
                padding: 0,
                flexShrink: 0,
              }}
            >
              ×
            </button>
          </div>
        );
      })}

      <MediaUploadButton
        // No filter — the default is already everything. Anything the
        // server won't render inline comes back as a download.
        label="Datei hochladen…"
        onUploaded={(media) =>
          void onAdd({
            kind: 'file',
            url: media.url,
            title: media.displayName || media.filename,
            mimeType: media.contentType,
            sizeBytes: media.size,
          }).catch((err) =>
            setError(err instanceof Error ? err.message : 'Konnte die Datei nicht anhängen'),
          )
        }
      />

      {!linkOpen ? (
        <button
          type="button"
          onClick={() => setLinkOpen(true)}
          onKeyDown={(e) => e.stopPropagation()}
          style={{
            padding: '6px 10px',
            background: '#f8fafc',
            color: '#475569',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          Link hinzufügen…
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <input
            autoFocus
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') void submitLink();
              if (e.key === 'Escape') setLinkOpen(false);
            }}
            placeholder="https://…"
            style={{
              width: '100%',
              padding: '6px 8px',
              border: '1px solid #e2e8f0',
              borderRadius: 6,
              fontSize: 12,
              boxSizing: 'border-box',
            }}
          />
          <input
            value={linkTitle}
            onChange={(e) => setLinkTitle(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') void submitLink();
              if (e.key === 'Escape') setLinkOpen(false);
            }}
            placeholder="Beschriftung (optional)"
            style={{
              width: '100%',
              padding: '6px 8px',
              border: '1px solid #e2e8f0',
              borderRadius: 6,
              fontSize: 12,
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={() => void submitLink()}
              onKeyDown={(e) => e.stopPropagation()}
              style={{
                padding: '4px 10px',
                background: '#3b82f6',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Hinzufügen
            </button>
            <button
              type="button"
              onClick={() => {
                setLinkOpen(false);
                setError(null);
              }}
              onKeyDown={(e) => e.stopPropagation()}
              style={{
                padding: '4px 10px',
                background: 'transparent',
                color: '#64748b',
                border: '1px solid #cbd5e1',
                borderRadius: 4,
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {error && (
        <div style={{ fontSize: 11, color: '#b91c1c' }} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
