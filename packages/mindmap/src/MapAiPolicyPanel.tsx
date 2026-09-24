/**
 * Per-map AI policy (#375) — the three-way switch in the map's settings.
 *
 *   any    follow the server-wide provider (whatever the admin selected)
 *   local  only the local model; never a cloud provider
 *   none   no AI for this map at all
 *
 * Saved through the store's map-settings action (optimistic, reverts on
 * failure) and followed by an invalidation of the map's cached AI
 * capabilities so every open view hides or shows its affordances at once.
 */
import { useState } from 'react';
import type { AiPolicy } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import { invalidateAiCapabilities } from './aiCapabilities.js';

const OPTIONS: Array<{ value: AiPolicy; label: string; hint: string }> = [
  {
    value: 'any',
    label: 'Any provider',
    hint: 'Follows the server-wide AI provider setting. Content may reach a cloud model such as Claude.',
  },
  {
    value: 'local',
    label: 'Local model only',
    hint: 'Only the local, self-hosted model is ever used for this map. If none is configured, AI features stay off here rather than falling back to the cloud.',
  },
  {
    value: 'none',
    label: 'No AI',
    hint: 'No AI feature at all for this map: no chat, breakdown, estimates, triage, or embeddings.',
  },
];

export function MapAiPolicyPanel() {
  const map = useMindmapStore((s) => s.currentMap);
  const updateMapSettings = useMindmapStore((s) => s.updateMapSettings);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  if (!map) return null;
  const current: AiPolicy = map.aiPolicy ?? 'any';

  const onChange = async (value: AiPolicy) => {
    if (value === current || saving) return;
    setSaving(true);
    const ok = await updateMapSettings({ aiPolicy: value });
    setSaving(false);
    if (ok) {
      setSavedAt(Date.now());
      void invalidateAiCapabilities(map.id);
    }
  };

  return (
    <div style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid #f1f5f9' }} data-testid="map-ai-policy">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#1e293b' }}>AI policy for this map</h3>
        {savedAt && Date.now() - savedAt < 4000 && (
          <span style={{ fontSize: 11, color: '#16a34a' }}>Saved</span>
        )}
      </div>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
        Which model this map&apos;s content may reach. Enforced on the server for chat, breakdown, brain dump,
        estimates, refine, standup, semantic search, node embeddings and issue triage.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {OPTIONS.map((o) => (
          <label
            key={o.value}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '10px 14px',
              borderRadius: 8,
              border: `1px solid ${current === o.value ? '#3b82f6' : '#e2e8f0'}`,
              background: current === o.value ? '#eff6ff' : '#f8fafc',
              cursor: saving ? 'wait' : 'pointer',
              opacity: saving ? 0.7 : 1,
            }}
          >
            <input
              type="radio"
              name="map-ai-policy"
              data-testid={`map-ai-policy-${o.value}`}
              checked={current === o.value}
              disabled={saving}
              onChange={() => onChange(o.value)}
              style={{ marginTop: 3 }}
            />
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#1e293b' }}>{o.label}</span>
              <span style={{ display: 'block', fontSize: 11, color: '#64748b', marginTop: 2 }}>{o.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
