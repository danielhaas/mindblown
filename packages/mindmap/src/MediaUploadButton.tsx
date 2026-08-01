/**
 * "Datei wählen → hochladen → URL zurückbekommen", as one button.
 *
 * Kept apart from PropertyPanel so the upload affordance can be dropped
 * next to any URL field (and into the reviewer-facing view, which a
 * parallel branch is building) without either side owning the other. The
 * only contract is `onUploaded`, which receives the absolute URL the
 * server minted; what the caller writes it into is the caller's business.
 */

import { useRef, useState } from 'react';
import { uploadMedia, type UploadedMedia } from './api.js';

interface Props {
  onUploaded: (media: UploadedMedia) => void;
  /** `accept` attribute for the file dialog. Narrows what the OS offers as
   *  a convenience only — the server takes any type and decides how to
   *  serve it back (see lib/media.ts). Default: everything. */
  accept?: string;
  label?: string;
  disabled?: boolean;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'uploading'; fraction: number; name: string }
  | { kind: 'error'; message: string };

export function MediaUploadButton({
  onUploaded,
  accept = '*/*',
  label = 'Datei hochladen…',
  disabled = false,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const busy = status.kind === 'uploading';

  async function handleFile(file: File): Promise<void> {
    setStatus({ kind: 'uploading', fraction: 0, name: file.name });
    try {
      const media = await uploadMedia(file, (fraction) =>
        setStatus({ kind: 'uploading', fraction, name: file.name }),
      );
      setStatus({ kind: 'idle' });
      onUploaded(media);
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Upload fehlgeschlagen',
      });
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset first: picking the same file twice in a row fires no
          // change event otherwise, so a retry after a failed upload would
          // do nothing.
          e.target.value = '';
          if (file) void handleFile(file);
        }}
      />

      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => e.stopPropagation()}
        style={{
          padding: '6px 10px',
          background: busy ? '#f1f5f9' : '#eff6ff',
          color: busy ? '#64748b' : '#1d4ed8',
          border: `1px solid ${busy ? '#e2e8f0' : '#bfdbfe'}`,
          borderRadius: 6,
          fontSize: 11,
          fontWeight: 600,
          cursor: disabled || busy ? 'default' : 'pointer',
          textAlign: 'left',
        }}
      >
        {busy ? `Lädt… ${Math.round(status.fraction * 100)} %` : label}
      </button>

      {busy && (
        <div
          style={{ height: 3, background: '#e2e8f0', borderRadius: 2, overflow: 'hidden' }}
          role="progressbar"
          aria-valuenow={Math.round(status.fraction * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Upload ${status.name}`}
        >
          <div
            style={{
              height: '100%',
              width: `${status.fraction * 100}%`,
              background: '#3b82f6',
              transition: 'width 0.15s',
            }}
          />
        </div>
      )}

      {status.kind === 'error' && (
        <div style={{ fontSize: 11, color: '#b91c1c' }} role="alert">
          {status.message}
        </div>
      )}
    </div>
  );
}
