import { useState } from 'react';
import * as api from '../api.js';
import type { MapSummary } from '../api.js';

interface Props {
  onClose: () => void;
  onCreated: (m: MapSummary) => void;
}

export function MobileCreateMapSheet({ onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const m = await api.createMap(trimmed);
      // Fabricate a MapSummary so the caller can navigate without re-fetching.
      // The fresh map has no nodes besides the root → 0% progress, unknown health.
      const summary: MapSummary = {
        ...m,
        computedProgress: 0,
        healthSignal: 'unknown',
      };
      onCreated(summary);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to create map';
      setError(msg);
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="mb-sheet-backdrop" onClick={onClose} />
      <div className="mb-sheet" role="dialog" aria-modal="true">
        <div className="mb-sheet-header">
          <span>New map</span>
          <button className="mb-link" onClick={onClose}>
            Cancel
          </button>
        </div>
        <div className="mb-sheet-body" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Map name (e.g. Q3 roadmap)"
            autoFocus
            style={{
              width: '100%',
              padding: '12px',
              border: '1px solid #cbd5e1',
              borderRadius: 8,
              fontSize: 16,
              fontFamily: 'inherit',
              background: '#fff',
              outline: 'none',
              boxSizing: 'border-box',
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {error && <div className="mb-error">{error}</div>}
          <button
            className="mb-btn-primary"
            disabled={submitting || !name.trim()}
            onClick={() => void submit()}
          >
            {submitting ? 'Creating…' : 'Create map'}
          </button>
        </div>
      </div>
    </>
  );
}
