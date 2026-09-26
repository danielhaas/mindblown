/**
 * Archive switch for the open map — the bottom of the map's settings.
 *
 * Archived = on hold. The server refuses every automated or agent write
 * on the map (forge webhooks and catch-up sync, issue triage, the pull
 * queue, MCP tools, housekeeping, nightly snapshots) until it is
 * unarchived. People can still open and edit it by hand; the map view
 * shows a banner meanwhile.
 *
 * Saved through the store's map-settings action, then the home list is
 * reloaded so the map moves between the active and archived groups.
 */
import { useState } from 'react';
import { useMindmapStore } from './store.js';

export function MapArchivePanel() {
  const map = useMindmapStore((s) => s.currentMap);
  const updateMapSettings = useMindmapStore((s) => s.updateMapSettings);
  const loadMaps = useMindmapStore((s) => s.loadMaps);
  const [saving, setSaving] = useState(false);
  if (!map) return null;
  const archived = map.archivedAt != null;

  const toggle = async () => {
    if (saving) return;
    if (
      !archived &&
      !window.confirm(
        `Archive "${map.name}"?\n\nThe map goes on hold: no issue sync, triage, dispatch, agent tool call or other automated action runs on it until you unarchive it. You can still open and edit it by hand.`,
      )
    ) {
      return;
    }
    setSaving(true);
    const ok = await updateMapSettings({ archived: !archived });
    setSaving(false);
    if (ok) void loadMaps();
  };

  return (
    <div style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid #f1f5f9' }} data-testid="map-archive">
      <h3 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600, color: '#1e293b' }}>
        {archived ? 'This map is archived' : 'Archive this map'}
      </h3>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
        {archived
          ? `On hold since ${map.archivedAt!.slice(0, 10)}. Nothing automated touches it: no issue sync, triage, dispatch, housekeeping or agent tool calls. You can still read and edit it by hand.`
          : 'Put the project on hold. Every automated action on it stops — issue sync, triage, dispatch, housekeeping, agent tool calls — until you unarchive it. Nothing is deleted; you can still edit by hand.'}
      </div>
      <button
        onClick={toggle}
        disabled={saving}
        style={{
          background: archived ? '#4f46e5' : '#fff',
          color: archived ? '#fff' : '#b45309',
          border: `1px solid ${archived ? '#4f46e5' : '#fcd34d'}`,
          borderRadius: 6,
          padding: '6px 14px',
          fontSize: 12,
          fontWeight: 600,
          cursor: saving ? 'wait' : 'pointer',
          fontFamily: 'inherit',
          opacity: saving ? 0.7 : 1,
        }}
      >
        {archived ? 'Unarchive map' : 'Archive map…'}
      </button>
    </div>
  );
}
