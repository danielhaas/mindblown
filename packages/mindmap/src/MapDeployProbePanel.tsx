/**
 * Deploy probe — how the map's project shows what runs in production.
 *
 * A URL that returns the deployed commit (JSON `{"commit": "<sha>"}` or the
 * plain sha), or "none" when nothing is deployed. The server compares it
 * with the bound repo's default branch; the Fleet tab then shows what is
 * merged and not live (DeployDriftBanner).
 */
import { useEffect, useState } from 'react';
import { DEPLOY_PROBE_NONE, normalizeDeployProbe } from '@mindblown/core';
import { useMindmapStore } from './store.js';

export function MapDeployProbePanel() {
  const map = useMindmapStore((s) => s.currentMap);
  const updateMapSettings = useMindmapStore((s) => s.updateMapSettings);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const saved = map?.deployProbe ?? null;
  useEffect(() => setDraft(saved && saved !== DEPLOY_PROBE_NONE ? saved : ''), [saved]);
  if (!map) return null;
  const none = saved === DEPLOY_PROBE_NONE;

  const save = async (value: string | null) => {
    const n = normalizeDeployProbe(value);
    if ('error' in n) {
      setError(n.error);
      return;
    }
    setError(null);
    setSaving(true);
    const ok = await updateMapSettings({ deployProbe: n.value });
    setSaving(false);
    if (ok) setSavedAt(Date.now());
  };

  return (
    <div style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid #f1f5f9' }} data-testid="map-deploy-probe">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#1e293b' }}>Deploy probe</h3>
        {savedAt && Date.now() - savedAt < 4000 && <span style={{ fontSize: 11, color: '#16a34a' }}>Saved</span>}
      </div>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
        A URL that returns the commit running in production — JSON <code>{'{"commit": "<sha>"}'}</code> or the plain sha
        (e.g. <code>/api/version</code>, <code>/version.txt</code>). The Fleet tab then shows merged work that is not live
        yet, compared with the repo&apos;s default branch.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="url"
          data-testid="map-deploy-probe-url"
          placeholder={none ? 'Not deployed' : 'https://example.com/api/version'}
          value={draft}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          style={{ flex: 1, padding: '6px 10px', fontSize: 12, border: '1px solid #e2e8f0', borderRadius: 6 }}
        />
        <button
          type="button"
          data-testid="map-deploy-probe-save"
          disabled={saving || draft.trim() === (saved ?? '')}
          onClick={() => save(draft)}
          style={{ padding: '6px 12px', fontSize: 12, borderRadius: 6, border: '1px solid #3b82f6', background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer' }}
        >
          Save probe
        </button>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12, color: '#1e293b' }}>
        <input
          type="checkbox"
          data-testid="map-deploy-probe-none"
          checked={none}
          disabled={saving}
          onChange={(e) => save(e.target.checked ? DEPLOY_PROBE_NONE : null)}
        />
        Not deployed — nothing to probe
      </label>
      {error && <div style={{ marginTop: 8, fontSize: 11, color: '#dc2626' }}>{error}</div>}
    </div>
  );
}
