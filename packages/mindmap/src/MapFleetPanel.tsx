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
  // Name of a fleet we just connected: neither the PUT response nor the
  // map:updated broadcast carries fleetName, and a fleet created a moment
  // ago is not in `fleets` until the reload lands.
  const [connected, setConnected] = useState<{ id: string; name: string } | null>(null);

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
  const mapId = map?.id;
  useEffect(() => {
    if (mapId && membersMapId !== mapId) void loadMembers();
  }, [mapId, membersMapId, loadMembers]);

  const current = fleets?.find((f) => f.id === fleetId);
  const options = useMemo(() => fleetOptions(fleets ?? [], fleetId), [fleets, fleetId]);
  if (!map) return null;

  // Same rule as the server's getPermission: the creator is admin without a
  // permission row (and so is missing from the members list).
  const isMapAdmin =
    (user !== null && map.createdBy === user.id) ||
    (membersMapId === map.id && members.some((m) => m.userId === user?.id && m.permission === 'admin'));
  // The share PUT needs edit on the map (routes/maps.ts) on top of fleet ownership.
  const canEditMap =
    isMapAdmin || (membersMapId === map.id && members.some((m) => m.userId === user?.id && m.permission === 'edit'));
  const currentName = current?.name ?? (connected?.id === fleetId ? connected.name : null) ?? map.fleetName ?? 'its fleet';
  const liveClaims = claimRows(nodes, new Date()).length;

  // The store parks a failed save's server message in the global banner;
  // show it here, next to the control that caused it, instead.
  const failed = (message: string) => {
    const cause = useMindmapStore.getState().error;
    setError(cause ? `${message}: ${cause}` : message);
    useMindmapStore.setState({ error: null });
  };

  const apply = async () => {
    if (busy) return;
    const creating = draft === CREATE;
    const target = creating || draft === NONE ? null : draft;
    const targetName = creating ? newName.trim() : target ? (fleets?.find((f) => f.id === target)?.name ?? null) : null;
    // Ask before anything is written — a cancelled move must not leave a new fleet behind.
    if (fleetId) {
      const warning = leaveFleetWarning(currentName, liveClaims, targetName);
      if (warning && !window.confirm(warning)) return;
    }
    setBusy(true);
    setError(null);
    try {
      let connectTo = target;
      if (creating) {
        try {
          const created = await api.createFleet(targetName!);
          connectTo = created.id;
          // From here on a retry is a plain connect, not a second fleet.
          setDraft(created.id);
          setNewName('');
        } catch (e: unknown) {
          setError(e instanceof Error ? e.message : 'Creating the fleet failed.');
          return;
        }
      }
      if (await updateMapSettings({ fleetId: connectTo })) {
        setConnected(connectTo && targetName ? { id: connectTo, name: targetName } : null);
      } else {
        failed(creating ? `Fleet "${targetName}" was created but not connected` : 'Saving the fleet failed');
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
    else failed('Saving the share failed');
  };

  const dirty = draft === CREATE ? newName.trim() !== '' : draft !== (fleetId ?? NONE);
  const showShare = fleetId !== null && canEditMap && current?.isOwner === true && shareApplies(current, map.id);
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
      {map.archivedAt && <span style={{ color: '#b45309' }}> · archived: the fleet skips this map until it is unarchived</span>}
    </>
  ) : (
    <>No fleet. A fleet&apos;s workers take tickets from this map only once it is connected; a worker pulling this map directly still can, within its own cap.</>
  );

  return (
    <div style={variant === 'settings' ? settingsBox : tabBox} data-testid="map-fleet">
      <h3 style={{ margin: '0 0 6px', fontSize: variant === 'settings' ? 14 : 12, fontWeight: variant === 'settings' ? 600 : 700, color: variant === 'settings' ? '#1e293b' : '#475569', ...(variant === 'tab' ? { textTransform: 'uppercase', letterSpacing: 0.5 } : {}) }}>
        Fleet
      </h3>
      {variant === 'settings' && (
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>
          A fleet is a group of worker hosts several projects share. Connect this map to let its workers pull tickets
          from here; they also need edit access to the map. The map&apos;s own cap, gate and policy on the Fleet tab
          still decide what is handed out.
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
        <div style={row}>
          <select
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
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
              onKeyDown={(e) => e.key === 'Enter' && dirty && void apply()}
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
      )}

      {/* The share is the fleet owner's call, even with only edit on the map. */}
      {!readOnly && showShare && (
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

      {/* The fleet's own keys (#481) — its owner manages them, in the settings only. */}
      {/* key: a fresh plaintext key must not survive a switch to another fleet. */}
      {variant === 'settings' && !readOnly && fleetId && current?.isOwner && <FleetKeysSection key={fleetId} fleetId={fleetId} fleetName={currentName} />}

      {error && <div style={warnBox}>{error}</div>}
      {loadError && <div style={{ fontSize: 11, color: '#b45309', marginTop: 8 }}>Fleet list unavailable ({loadError}).</div>}
    </div>
  );
}

/**
 * API keys of the fleet's service user (#481). The fleet acts as its own
 * identity: edit on exactly the maps connected to it, nothing else. A key
 * is shown once, right after it is issued; afterwards only its prefix.
 * Rotate = issue a new one, switch the workers to it, revoke the old one.
 */
function FleetKeysSection({ fleetId, fleetName }: { fleetId: string; fleetName: string }) {
  const [keys, setKeys] = useState<api.FleetCredential[] | null>(null);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<{ prefix: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .listFleetCredentials(fleetId)
      .then((r) => setKeys(r.credentials))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Keys unavailable'));
  }, [fleetId]);
  useEffect(reload, [reload]);

  const issue = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.issueFleetCredential(fleetId, name.trim() || `${fleetName} key`);
      setFresh({ prefix: created.prefix, key: created.key });
      setName('');
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Issuing the key failed');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (k: api.FleetCredential) => {
    if (busy || !window.confirm(`Revoke "${k.name}" (${k.prefix}…)?\n\nEvery worker still using it is refused from the next request on.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.revokeFleetCredential(fleetId, k.id);
      if (fresh?.prefix === k.prefix) setFresh(null);
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Revoking the key failed');
    } finally {
      setBusy(false);
    }
  };

  const active = (keys ?? []).filter((k) => !k.revokedAt);
  return (
    <div style={{ marginTop: 14 }} data-testid="fleet-keys">
      <div style={{ fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 4 }}>Fleet keys</div>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
        The workers of this fleet sign in with a fleet key. It reaches exactly the maps connected to the fleet — with edit, never
        admin — and loses a map the moment it is disconnected.
      </div>
      {fresh && (
        <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '6px 10px', fontSize: 12, marginBottom: 8 }} data-testid="fleet-key-fresh">
          New key — copy it now, it is not shown again:
          <code style={{ display: 'block', marginTop: 4, wordBreak: 'break-all', userSelect: 'all' }}>{fresh.key}</code>
        </div>
      )}
      {active.length > 0 && (
        <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 12, lineHeight: 1.8 }}>
          {active.map((k) => (
            <li key={k.id}>
              {k.name} <code>{k.prefix}…</code>
              <span style={{ color: '#94a3b8' }}> · {k.lastUsedAt ? `last used ${k.lastUsedAt.slice(0, 10)}` : 'never used'}</span>{' '}
              <button style={{ ...btn, padding: '0 8px' }} disabled={busy} onClick={() => void revoke(k)} data-testid="fleet-key-revoke">
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {keys !== null && active.length === 0 && <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>No key yet.</div>}
      <div style={row}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name (e.g. big-blower)" maxLength={100} style={{ ...input, flex: 1, minWidth: 140 }} data-testid="fleet-key-name" />
        <button style={{ ...btn, ...btnPrimary }} disabled={busy} onClick={() => void issue()} data-testid="fleet-key-issue">
          Issue key
        </button>
      </div>
      {error && <div style={warnBox}>{error}</div>}
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
