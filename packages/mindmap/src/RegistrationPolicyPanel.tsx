/**
 * Admin-only panel for editing the server-side registration policy. Rendered
 * inside WorkspaceSettings; hides itself for non-admins so regular users don't
 * see an ignore-me form.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getRegistrationPolicy,
  setRegistrationPolicy as saveRegistrationPolicy,
} from './api.js';
import type { RegistrationMode, RegistrationPolicy } from './api.js';
import { useMindmapStore } from './store.js';

const MODE_DESCRIPTIONS: Record<RegistrationMode, string> = {
  open: 'Anyone who can reach the site can create an account.',
  invite_only: 'Only people with a pending map invite can register.',
  allowlist: 'Only allowlisted emails (or an existing invite) can register.',
};

export function RegistrationPolicyPanel() {
  const user = useMindmapStore((s) => s.user);
  const [policy, setPolicy] = useState<RegistrationPolicy | null>(null);
  const [allowlistText, setAllowlistText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const isAdmin = Boolean(user?.isAdmin);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = await getRegistrationPolicy();
      setPolicy(p);
      setAllowlistText(p.allowlist.join('\n'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load policy');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  const onSave = useCallback(async () => {
    if (!policy) return;
    setSaving(true);
    setError(null);
    try {
      const allowlist = allowlistText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const saved = await saveRegistrationPolicy({ mode: policy.mode, allowlist });
      setPolicy(saved);
      setAllowlistText(saved.allowlist.join('\n'));
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save policy');
    } finally {
      setSaving(false);
    }
  }, [policy, allowlistText]);

  const dirty = useMemo(() => {
    if (!policy) return false;
    const currentAllowlist = allowlistText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (currentAllowlist.length !== policy.allowlist.length) return true;
    return currentAllowlist.some((e, i) => e !== policy.allowlist[i]);
  }, [allowlistText, policy]);

  if (!isAdmin) return null;

  return (
    <div style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid #f1f5f9' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1e293b" strokeWidth="2">
          <path d="M12 1l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" />
        </svg>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#1e293b' }}>
          Registration Policy
        </h3>
      </div>

      {loading && (
        <div style={{ fontSize: 13, color: '#94a3b8', padding: '12px 0' }}>Loading...</div>
      )}

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

      {!loading && policy && (
        <>
          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 12px' }}>
            Who can create a new account on this instance.
          </p>

          <div style={{ marginBottom: 12 }}>
            <label
              style={{
                display: 'block',
                fontSize: 11,
                fontWeight: 600,
                color: '#64748b',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginBottom: 6,
              }}
            >
              Mode
            </label>
            <select
              value={policy.mode}
              onChange={(e) => setPolicy({ ...policy, mode: e.target.value as RegistrationMode })}
              style={{
                width: '100%',
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid #e2e8f0',
                fontSize: 13,
                fontFamily: 'inherit',
                color: '#1e293b',
                background: '#fff',
              }}
            >
              <option value="open">Open — anyone can register</option>
              <option value="invite_only">Invite-only — requires a pending map invite</option>
              <option value="allowlist">Allowlist — specific emails or domains</option>
            </select>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
              {MODE_DESCRIPTIONS[policy.mode]}
            </div>
          </div>

          {policy.mode === 'allowlist' && (
            <div style={{ marginBottom: 12 }}>
              <label
                style={{
                  display: 'block',
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#64748b',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: 6,
                }}
              >
                Allowlist
              </label>
              <textarea
                value={allowlistText}
                onChange={(e) => setAllowlistText(e.target.value)}
                placeholder={'daniel@haas.li\n@haas.li'}
                rows={5}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: '1px solid #e2e8f0',
                  fontSize: 12,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  color: '#1e293b',
                  background: '#fff',
                  resize: 'vertical',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
                One entry per line. Use <code>user@domain.com</code> for specific addresses or
                <code style={{ marginLeft: 4 }}>@domain.com</code> for a whole domain. Pending map
                invites always bypass this list.
              </div>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={onSave}
              disabled={saving || (!dirty && policy.mode === (policy?.mode ?? 'invite_only'))}
              style={{
                background: saving ? '#94a3b8' : '#4f46e5',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: 600,
                cursor: saving ? 'default' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {saving ? 'Saving...' : 'Save policy'}
            </button>
            {savedAt && Date.now() - savedAt < 3000 && (
              <span style={{ fontSize: 12, color: '#16a34a' }}>Saved</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
