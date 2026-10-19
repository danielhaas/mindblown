/**
 * Fleet connection for the open map (#480) — in the map's settings and at
 * the top of the Fleet tab.
 *
 * A map has at most one fleet; a fleet serves many maps and splits its
 * capacity between them by each map's share. The picker offers the fleets
 * the user owns plus "Create fleet…"; Apply writes `fleetId` through the
 * store's map-settings action (optimistic, reverts on failure). Leaving a
 * fleet while workers hold claims on this map asks first.
 *
 * The server decides (services/fleets.ts): connecting needs admin on the
 * map and ownership of the fleet; the share on a connected map is the fleet
 * owner's call. The controls show only to a map admin (members list), the
 * share only to the fleet's owner; any refusal the server still sends is
 * shown as is. `readOnly` (a lens that observes, #355) shows the connection
 * without the controls.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FleetWithMaps } from '@mindblown/core';
import { FLEET_SHARE_MAX, FLEET_SHARE_MIN } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import { claimRows } from './dispatch.js';
import { fleetOptions, leaveFleetWarning, shareApplies } from './fleetConnect.js';

const NONE = '';
const CREATE = '__create__';

export function MapFleetPanel({ variant = 'settings', readOnly = false }: { variant?: 'settings' | 'tab'; readOnly?: boolean }) {
  const map = useMindmapStore((s) => s.currentMap);
  const nodes = useMindmapStore((s) => s.nodes);
  const updateMapSettings = useMindmapStore((s) => s.updateMapSettings);
  const user = useMindmapStore((s) => s.user);
  const members = useMindmapStore((s) => s.members);
  const membersMapId = useMindmapStore((s) => s.membersMapId);
  const loadMembers = useMindmapStore((s) => s.loadMembers);
  const [fleets, setFleets] = useState<FleetWithMaps[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>(NONE);
  const [newName, setNewName] = useState('');
  const [shareDraft, setShareDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fleetId = map?.fleetId ?? null;
  const share = map?.fleetShare ?? 1;

  const reload = useCallback(() => {
    api
      .listFleets()
      .then((f) => {
        setFleets(f);
        setLoadError(null);
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'unavailable'));
  }, []);

  // Re-read when the connection changes — ours, or another tab's / an agent's.
  useEffect(reload, [reload, fleetId]);
  useEffect(() => setDraft(fleetId ?? NONE), [fleetId]);
  useEffect(() => setShareDraft(String(share)), [share]);
  useEffect(() => {
    if (map && membersMapId !== map.id) void loadMembers();
  }, [map, membersMapId, loadMembers]);

  const current = fleets?.find((f) => f.id === fleetId);
  const options = useMemo(() => fleetOptions(fleets ?? [], fleetId), [fleets, fleetId]);
  if (!map) return null;

  // Same rule as the server's getPermission: the creator is admin without a
  // permission row (and so is missing from the members list).
  const isMapAdmin =
    (user !== null && map.createdBy === user.id) ||
    (membersMapId === map.id && members.some((m) => m.userId === user?.id && m.permission === 'admin'));
  const currentName = current?.name ?? map.fleetName ?? 'its fleet';
  const liveClaims = claimRows(nodes, new Date()).length;

  // The store parks a failed save's server message in the global banner;
  // show it here, next to the control that caused it, instead.
  const failed = (fallback: string) => {
    setError(useMindmapStore.getState().error ?? fallback);
    useMindmapStore.setState({ error: null });
  };

  const connect = async (target: string | null, targetName: string | null) => {
    if (fleetId && target !== fleetId) {
      const warning = leaveFleetWarning(currentName, liveClaims, targetName);
      if (warning && !window.confirm(warning)) return false;
    }
    const ok = await updateMapSettings({ fleetId: target });
    if (!ok) failed('Saving the fleet failed.');
    return ok;
  };

  const apply = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (draft === CREATE) {
        const name = newName.trim();
        let created: FleetWithMaps;
        try {
          created = await api.createFleet(name);
        } catch (e: unknown) {
          setError(e instanceof Error ? e.message : 'Creating the fleet failed.');
          return;
        }
        if (await connect(created.id, created.name)) setNewName('');
        else setError((err) => `Fleet "${created.name}" was created but not connected: ${err}`);
      } else {
        const target = draft === NONE ? null : draft;
        await connect(target, target ? (fleets?.find((f) => f.id === target)?.name ?? null) : null);
      }
    } finally {
      setBusy(false);
      reload();
    }
  };

  const shareNumber = Number(shareDraft);
  const shareValid = shareDraft.trim() !== '' && Number.isFinite(shareNumber) && shareNumber >= FLEET_SHARE_MIN && shareNumber <= FLEET_SHARE_MAX;
  const shareDirty = shareValid && shareNumber !== share;
  const applyShare = async () => {
    if (busy || !shareDirty) return;
    setBusy(true);
    setError(null);
    const ok = await updateMapSettings({ fleetShare: shareNumber });
    setBusy(false);
    if (ok) reload();
    else failed('Saving the share failed.');
  };

  const dirty = draft === CREATE ? newName.trim() !== '' : draft !== (fleetId ?? NONE);
  const showShare = fleetId !== null && current?.isOwner === true && shareApplies(current, map.id);
  const otherMaps = current ? current.maps.filter((m) => m.id !== map.id) : [];

  const status = fleetId ? (
    <>
      Connected to <strong>{currentName}</strong>
      {current && (
        <span style={{ color: '#64748b' }}>
          {' '}· fleet cap {current.maxActiveClaims === 0 ? 'none (each map’s own cap limits it)' : current.maxActiveClaims}
          {otherMaps.length > 0 && <> · also serves {otherMaps.map((m) => m.name).join(', ')}</>}
          {current.hiddenMapCount > 0 && <> {otherMaps.length > 0 ? 'and' : '· also serves'} {current.hiddenMapCount} map{current.hiddenMapCount === 1 ? '' : 's'} you can&apos;t see</>}
        </span>
      )}
    </>
  ) : (
    <>No fleet. No worker pulls tickets from this map until it is connected to one.</>
  );

  return (
    <div style={variant === 'settings' ? settingsBox : tabBox} data-testid="map-fleet">
      <h3 style={{ margin: '0 0 6px', fontSize: variant === 'settings' ? 14 : 12, fontWeight: variant === 'settings' ? 600 : 700, color: variant === 'settings' ? '#1e293b' : '#475569', ...(variant === 'tab' ? { textTransform: 'uppercase', letterSpacing: 0.5 } : {}) }}>
        Fleet
      </h3>
      {variant === 'settings' && (
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>
          A fleet is a group of worker hosts several projects share. Connect this map to let its workers pull tickets
          from here; the map&apos;s own cap, gate and policy on the Fleet tab still decide what is handed out.
        </div>
      )}
      <div style={{ fontSize: 13, color: '#334155', marginBottom: readOnly ? 0 : 10 }} data-testid="map-fleet-status">{status}</div>

      {readOnly || !isMapAdmin ? (
        (variant === 'tab' ? !fleetId : true) && (
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 6 }} data-testid="map-fleet-readonly">
            {readOnly ? 'A map admin connects one in the PM or All lens, or in the map\u2019s settings.' : 'Only a map admin connects this map to a fleet or disconnects it.'}
          </div>
        )
      ) : (
        <>
          <div style={row}>
            <select
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={busy || fleets === null}
              style={input}
              aria-label="Fleet"
              data-testid="map-fleet-select"
            >
              <option value={NONE}>No fleet</option>
              {options.map((o) => (
                <option key={o.id} value={o.id} disabled={o.disabled}>{o.label}</option>
              ))}
              <option value={CREATE}>Create fleet…</option>
            </select>
            {draft === CREATE && (
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void apply()}
                placeholder="Fleet name"
                maxLength={200}
                autoFocus
                style={{ ...input, flex: 1, minWidth: 120 }}
                data-testid="map-fleet-new-name"
              />
            )}
            <button style={{ ...btn, ...(dirty ? btnPrimary : {}) }} disabled={!dirty || busy} onClick={() => void apply()} data-testid="map-fleet-apply">
              {busy ? 'Saving…' : draft === CREATE ? 'Create and connect' : draft === NONE && fleetId ? 'Disconnect' : 'Connect'}
            </button>
          </div>

          {showShare && (
            <div style={{ ...row, marginTop: 10 }}>
              <label style={{ fontSize: 12, color: '#334155' }} title="How often the fleet picks this map relative to its other maps (weighted round-robin). 1 = equal; 2 = twice as often.">
                Share
              </label>
              <input
                type="number"
                min={FLEET_SHARE_MIN}
                max={FLEET_SHARE_MAX}
                step={0.1}
                value={shareDraft}
                onChange={(e) => setShareDraft(e.target.value)}
                style={{ ...input, width: 70 }}
                data-testid="map-fleet-share"
              />
              <button style={{ ...btn, ...(shareDirty ? btnPrimary : {}) }} disabled={!shareDirty || busy} onClick={() => void applyShare()} data-testid="map-fleet-share-apply">
                Apply
              </button>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>
                vs {otherMaps.map((m) => `${m.name} ${m.fleetShare}`).join(', ') || 'the other maps'}
              </span>
            </div>
          )}
        </>
      )}

      {error && <div style={warnBox}>{error}</div>}
      {loadError && <div style={{ fontSize: 11, color: '#b45309', marginTop: 8 }}>Fleet list unavailable ({loadError}).</div>}
    </div>
  );
}

const settingsBox: React.CSSProperties = { marginTop: 24, paddingTop: 24, borderTop: '1px solid #f1f5f9' };
const tabBox: React.CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, marginBottom: 16 };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' };
const input: React.CSSProperties = { fontSize: 12, padding: '3px 6px', border: '1px solid #cbd5e1', borderRadius: 6, fontFamily: 'inherit', background: '#fff' };
const btn: React.CSSProperties = { fontSize: 12, padding: '3px 10px', border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', color: '#334155', cursor: 'pointer', fontFamily: 'inherit' };
const btnPrimary: React.CSSProperties = { background: '#4f46e5', border: '1px solid #4f46e5', color: '#fff' };
const warnBox: React.CSSProperties = { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', borderRadius: 8, padding: '6px 10px', fontSize: 12, marginTop: 8 };
