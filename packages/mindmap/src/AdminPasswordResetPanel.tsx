/**
 * Admin-only panel for resetting another user's password. There is no reset
 * email on this instance — the server generates a temporary password, shows
 * it here exactly once, and the admin hands it to the user out-of-band. The
 * user then changes it via the Change Password form. Hides itself for
 * non-admins, same as RegistrationPolicyPanel.
 */

import { useCallback, useState } from 'react';
import { adminResetPassword } from './api.js';
import { useMindmapStore } from './store.js';

export function AdminPasswordResetPanel() {
  const user = useMindmapStore((s) => s.user);
  const [email, setEmail] = useState('');
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ email: string; tempPassword: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const isAdmin = Boolean(user?.isAdmin);

  const onReset = useCallback(async () => {
    const target = email.trim();
    if (!target) return;
    if (!confirm(`Reset the password for ${target}? Their current password stops working immediately.`)) {
      return;
    }
    setResetting(true);
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      setResult(await adminResetPassword(target));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setResetting(false);
    }
  }, [email]);

  const onCopy = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.tempPassword);
      setCopied(true);
    } catch {
      // Clipboard unavailable (http, permissions) — the password is visible
      // in the box; nothing to do.
    }
  }, [result]);

  if (!isAdmin) return null;

  const canReset = !resetting && email.trim().length > 0;

  return (
    <div style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid #f1f5f9' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1e293b" strokeWidth="2">
          <path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 11-7.78 7.78 5.5 5.5 0 017.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
        </svg>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#1e293b' }}>
          Reset a User&apos;s Password
        </h3>
      </div>

      <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 12px' }}>
        Generates a temporary password for the account and shows it once. Pass it
        to the user directly — they should change it after logging in.
      </p>

      {error && (
        <div
          style={{
            fontSize: 12,
            color: '#dc2626',
            background: '#fef2f2',
            padding: '8px 12px',
            borderRadius: 6,
            marginBottom: 12,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          type="email"
          placeholder="user@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && canReset && onReset()}
          style={{
            flex: 1,
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid #e2e8f0',
            fontSize: 13,
            fontFamily: 'inherit',
            color: '#1e293b',
            background: '#fff',
          }}
        />
        <button
          onClick={onReset}
          disabled={!canReset}
          style={{
            background: canReset ? '#dc2626' : '#e2e8f0',
            color: canReset ? '#fff' : '#94a3b8',
            border: 'none',
            borderRadius: 8,
            padding: '8px 16px',
            fontSize: 13,
            fontWeight: 600,
            cursor: canReset ? 'pointer' : 'default',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
          }}
        >
          {resetting ? 'Resetting...' : 'Reset password'}
        </button>
      </div>

      {result && (
        <div
          style={{
            background: '#f0fdf4',
            border: '1px solid #bbf7d0',
            borderRadius: 8,
            padding: '12px 16px',
          }}
        >
          <div style={{ fontSize: 12, color: '#166534', marginBottom: 8 }}>
            Temporary password for <strong>{result.email}</strong> — shown only once:
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code
              style={{
                fontSize: 14,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                background: '#fff',
                border: '1px solid #bbf7d0',
                borderRadius: 6,
                padding: '6px 10px',
                color: '#1e293b',
              }}
            >
              {result.tempPassword}
            </code>
            <button
              onClick={onCopy}
              style={{
                background: 'none',
                border: '1px solid #86efac',
                borderRadius: 6,
                padding: '5px 12px',
                fontSize: 12,
                fontWeight: 600,
                color: '#166534',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
