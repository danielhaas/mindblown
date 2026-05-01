/**
 * Admin-only panel for choosing the AI chat provider. Mirrors the
 * RegistrationPolicyPanel layout. Hidden for non-admins.
 *
 * The selector exposes three preferences:
 *   - Auto: pick whichever backend is configured (Anthropic preferred)
 *   - Local: force the Ollama / OpenAI-compatible backend (qwen2.5:14b)
 *   - Claude: force the Anthropic API
 *
 * If the selected backend isn't configured (no API key, no AI_BASE_URL),
 * the resolver falls back and we surface that as a warning here.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  aiConfig,
  setAiProvider,
  type AiConfigResponse,
  type AiProviderPreference,
} from './api.js';
import { useMindmapStore } from './store.js';

const PREFERENCE_LABELS: Record<AiProviderPreference, string> = {
  auto: 'Auto — pick whichever is configured',
  ollama: 'Local (Ollama / OpenAI-compatible)',
  anthropic: 'Claude API (Anthropic)',
};

export function AiProviderPanel() {
  const user = useMindmapStore((s) => s.user);
  const [config, setConfig] = useState<AiConfigResponse | null>(null);
  const [preference, setPreference] = useState<AiProviderPreference>('auto');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const isAdmin = Boolean(user?.isAdmin);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const c = await aiConfig();
      setConfig(c);
      setPreference(c.preference);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load AI config');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  const onSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await setAiProvider({ preference });
      // Reload to see the resulting `active` provider after the change.
      const c = await aiConfig();
      setConfig(c);
      setPreference(c.preference);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save preference');
    } finally {
      setSaving(false);
    }
  }, [preference]);

  if (!isAdmin) return null;

  const dirty = config !== null && preference !== config.preference;

  return (
    <div style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid #f1f5f9' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1e293b" strokeWidth="2">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
        </svg>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#1e293b' }}>
          AI Chat Provider
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

      {!loading && config && (
        <>
          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 12px' }}>
            Which model the in-app chat routes to. The choice falls back automatically when the
            preferred backend isn’t configured.
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
              Preference
            </label>
            <select
              value={preference}
              onChange={(e) => setPreference(e.target.value as AiProviderPreference)}
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
              <option value="auto">{PREFERENCE_LABELS.auto}</option>
              <option value="ollama">{PREFERENCE_LABELS.ollama}</option>
              <option value="anthropic">{PREFERENCE_LABELS.anthropic}</option>
            </select>
          </div>

          {/* Status block — what's actually live + per-backend availability */}
          <div
            style={{
              fontSize: 12,
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: 8,
              padding: 12,
              marginBottom: 12,
            }}
          >
            <div style={{ marginBottom: 8 }}>
              <span style={{ color: '#64748b' }}>Active: </span>
              {config.active ? (
                <code style={{ color: '#1e293b', fontWeight: 600 }}>{config.active.model}</code>
              ) : (
                <span style={{ color: '#dc2626' }}>none configured</span>
              )}
            </div>
            <BackendStatus
              label="Local"
              available={config.available.ollama}
              model={config.models.ollama}
              hint="Set AI_BASE_URL on the server"
            />
            <BackendStatus
              label="Claude API"
              available={config.available.anthropic}
              model={config.models.anthropic}
              hint="Set ANTHROPIC_API_KEY on the server"
            />
            {!config.preferenceHonored && (
              <div style={{ marginTop: 8, color: '#b45309' }}>
                Selected backend isn’t configured — falling back to{' '}
                <code>{config.active?.name ?? 'none'}</code>.
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={onSave}
              disabled={saving || !dirty}
              style={{
                background: saving || !dirty ? '#94a3b8' : '#4f46e5',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: 600,
                cursor: saving || !dirty ? 'default' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {saving ? 'Saving...' : 'Save preference'}
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

function BackendStatus({
  label,
  available,
  model,
  hint,
}: {
  label: string;
  available: boolean;
  model: string | null;
  hint: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
      <span
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: available ? '#16a34a' : '#cbd5e1',
        }}
      />
      <span style={{ color: '#64748b', minWidth: 80 }}>{label}:</span>
      {available ? (
        <code style={{ color: '#1e293b' }}>{model}</code>
      ) : (
        <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>{hint}</span>
      )}
    </div>
  );
}
