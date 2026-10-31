/**
 * The daily mail with open questions (#597) — the signed-in person's
 * on/off switch. Rendered inside WorkspaceSettings (workspace-wide view);
 * the mail's footer links here (?settings=account).
 */

import { useEffect, useState } from 'react';
import { getDigestMail, setDigestMail } from './api.js';

export function DigestMailPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getDigestMail()
      .then((r) => live && setEnabled(r.enabled))
      .catch((err) => live && setError(err instanceof Error ? err.message : 'Failed to load'));
    return () => {
      live = false;
    };
  }, []);

  const onToggle = async (next: boolean) => {
    setSaving(true);
    setError(null);
    try {
      setEnabled((await setDigestMail(next)).enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid #f1f5f9' }} data-testid="digest-mail-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1e293b" strokeWidth="2">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M22 6l-10 7L2 6" />
        </svg>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#1e293b' }}>Daily mail</h3>
      </div>

      {error && (
        <div style={{ fontSize: 12, color: '#dc2626', background: '#fef2f2', padding: '8px 12px', borderRadius: 6, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: '#1e293b', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={enabled ?? false}
          disabled={enabled === null || saving}
          onChange={(e) => onToggle(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          Mail me once a day when questions wait for me
          <span style={{ display: 'block', fontSize: 12, color: '#64748b', marginTop: 2 }}>
            Open questions and tickets waiting for approval on your maps, every morning. No mail on a day nothing is open.
          </span>
        </span>
      </label>
    </div>
  );
}
