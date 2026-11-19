/**
 * "Who may run the fleet" (#491) — the map's trust policy in its settings.
 *
 * A ticket's reporter decides its trust level: trusted (on the two lists
 * below, or reporter unknown) runs fully automatic and is the only work
 * ever deployed automatically; known (map members) and external (everyone
 * else) follow the two level rows. Admin only, like the server: the panel
 * is not shown to anyone else.
 *
 * Edits are a draft; Save writes the whole policy, "Use defaults" clears
 * the saved one so the map follows the computed defaults again.
 */
import { useEffect, useState } from 'react';
import type { TrustDispatch, TrustLevelPolicy, TrustMerge, TrustPolicy } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';

const LEVELS: Array<{ key: 'known' | 'external'; label: string; hint: string }> = [
  { key: 'known', label: 'Known', hint: 'Map members not on the lists above' },
  { key: 'external', label: 'External', hint: 'Everyone else, incl. forge authors not linked to a member' },
];

const chip: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  borderRadius: 999,
  background: '#eff6ff',
  border: '1px solid #bfdbfe',
  fontSize: 11,
  color: '#1e293b',
};
const removeBtn: React.CSSProperties = {
  border: 'none',
  background: 'none',
  cursor: 'pointer',
  color: '#64748b',
  padding: 0,
  fontSize: 12,
};
const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#1e293b', marginBottom: 4 };

export function MapTrustPolicyPanel() {
  const map = useMindmapStore((s) => s.currentMap);
  const user = useMindmapStore((s) => s.user);
  const members = useMindmapStore((s) => s.members);
  const membersMapId = useMindmapStore((s) => s.membersMapId);
  const loadMembers = useMindmapStore((s) => s.loadMembers);
  const [draft, setDraft] = useState<TrustPolicy | null>(null);
  const [isDefault, setIsDefault] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [addUser, setAddUser] = useState('');
  const [addLogin, setAddLogin] = useState('');

  const mapId = map?.id;
  useEffect(() => {
    if (mapId && membersMapId !== mapId) void loadMembers();
  }, [mapId, membersMapId, loadMembers]);

  // Same rule as the server's getPermission: the creator is admin without a row.
  const isMapAdmin =
    !!map &&
    ((user !== null && map.createdBy === user.id) ||
      (membersMapId === map.id && members.some((m) => m.userId === user?.id && m.permission === 'admin')));

  useEffect(() => {
    if (!mapId || !isMapAdmin) return;
    let live = true;
    api
      .getTrustPolicy(mapId)
      .then((r) => {
        if (!live) return;
        setDraft(r.policy);
        setIsDefault(r.isDefault);
        setDirty(false);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : 'unavailable'));
    return () => {
      live = false;
    };
  }, [mapId, isMapAdmin]);

  if (!map || !isMapAdmin) return null;

  const nameOf = (id: string) =>
    members.find((m) => m.userId === id)?.name ??
    (id === user?.id ? user.name :id === map.createdBy ? 'Map creator' : id);

  const edit = (next: TrustPolicy) => {
    setDraft(next);
    setDirty(true);
  };
  const setLevel = (key: 'known' | 'external', patch: Partial<TrustLevelPolicy>) =>
    draft && edit({ ...draft, levels: { ...draft.levels, [key]: { ...draft.levels[key], ...patch } } });

  const save = async (policy: TrustPolicy | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveTrustPolicy(map.id, policy);
      setDraft(saved);
      setIsDefault(policy === null);
      setDirty(false);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const candidates = [
    ...(map.createdBy && !draft?.trustedUserIds.includes(map.createdBy) ? [{ userId: map.createdBy, name: nameOf(map.createdBy) }] : []),
    ...(membersMapId === map.id ? members : []).filter((m) => !draft?.trustedUserIds.includes(m.userId) && m.userId !== map.createdBy),
  ];

  return (
    <div style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid #f1f5f9' }} data-testid="map-trust-policy">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#1e293b' }}>Who may run the fleet</h3>
        {isDefault && !dirty && <span style={{ fontSize: 11, color: '#64748b' }}>Defaults</span>}
        {savedAt && Date.now() - savedAt < 4000 && <span style={{ fontSize: 11, color: '#16a34a' }}>Saved</span>}
      </div>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
        Tickets reported by the people below run fully automatic. Everyone else&apos;s follow the rows underneath. Only
        trusted work is ever deployed automatically.
      </div>
      {error && <div style={{ fontSize: 12, color: '#dc2626', marginBottom: 8 }}>{error}</div>}
      {!draft ? (
        !error && <div style={{ fontSize: 12, color: '#64748b' }}>Loading…</div>
      ) : (
        <>
          <div style={label}>Trusted people</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 12 }}>
            {draft.trustedUserIds.map((id) => (
              <span key={id} style={chip} data-testid="trust-user">
                {nameOf(id)}
                <button
                  type="button"
                  style={removeBtn}
                  aria-label={`Remove ${nameOf(id)}`}
                  onClick={() => edit({ ...draft, trustedUserIds: draft.trustedUserIds.filter((x) => x !== id) })}
                >
                  ×
                </button>
              </span>
            ))}
            {candidates.length > 0 && (
              <select
                value={addUser}
                data-testid="trust-add-user"
                onChange={(e) => {
                  const id = e.target.value;
                  setAddUser('');
                  if (id) edit({ ...draft, trustedUserIds: [...draft.trustedUserIds, id] });
                }}
                style={{ fontSize: 11, padding: '2px 4px' }}
              >
                <option value="">Add a member…</option>
                {candidates.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div style={label}>Trusted forge logins</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 12 }}>
            {draft.trustedForgeLogins.map((login) => (
              <span key={login} style={chip} data-testid="trust-login">
                @{login}
                <button
                  type="button"
                  style={removeBtn}
                  aria-label={`Remove ${login}`}
                  onClick={() =>
                    edit({ ...draft, trustedForgeLogins: draft.trustedForgeLogins.filter((x) => x !== login) })
                  }
                >
                  ×
                </button>
              </span>
            ))}
            <form
              style={{ display: 'inline-flex', gap: 4 }}
              onSubmit={(e) => {
                e.preventDefault();
                const login = addLogin.trim().replace(/^@/, '');
                setAddLogin('');
                if (login && !draft.trustedForgeLogins.some((l) => l.toLowerCase() === login.toLowerCase())) {
                  edit({ ...draft, trustedForgeLogins: [...draft.trustedForgeLogins, login] });
                }
              }}
            >
              <input
                value={addLogin}
                onChange={(e) => setAddLogin(e.target.value)}
                placeholder="login"
                data-testid="trust-add-login"
                style={{ fontSize: 11, padding: '2px 6px', width: 110 }}
              />
              <button type="submit" style={{ fontSize: 11 }} disabled={!addLogin.trim()}>
                Add
              </button>
            </form>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {LEVELS.map((l) => (
              <div
                key={l.key}
                data-testid={`trust-level-${l.key}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: '1px solid #e2e8f0',
                  background: '#f8fafc',
                }}
              >
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#1e293b' }}>{l.label}</span>
                  <span style={{ display: 'block', fontSize: 11, color: '#64748b' }}>{l.hint}</span>
                </span>
                <select
                  value={draft.levels[l.key].dispatch}
                  aria-label={`${l.label}: dispatch`}
                  onChange={(e) => setLevel(l.key, { dispatch: e.target.value as TrustDispatch })}
                  style={{ fontSize: 11 }}
                >
                  <option value="approval">Needs approval</option>
                  <option value="auto">Starts automatically</option>
                </select>
                <select
                  value={draft.levels[l.key].merge}
                  aria-label={`${l.label}: merge`}
                  onChange={(e) => setLevel(l.key, { merge: e.target.value as TrustMerge })}
                  style={{ fontSize: 11 }}
                >
                  <option value="pr-only">Stops at PR</option>
                  <option value="auto">Merges automatically</option>
                </select>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="button" disabled={!dirty || busy} onClick={() => save(draft)} data-testid="trust-save">
              Save
            </button>
            <button
              type="button"
              disabled={busy || (isDefault && !dirty)}
              onClick={() => save(null)}
              data-testid="trust-reset"
            >
              Use defaults
            </button>
          </div>
        </>
      )}
    </div>
  );
}
