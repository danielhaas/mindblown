import { useCallback, useEffect, useState } from 'react';
import * as api from './api.js';
import type { Permission, PendingInvite } from './api.js';
import { useMindmapStore } from './store.js';

/**
 * Basis für die geteilten Links. Funktion statt Modul-Konstante aus demselben
 * Grund wie `wsBase()` in ws.ts: `window` beim Import zu lesen macht das Modul
 * ausserhalb des Browsers unimportierbar. Hier ist noch nichts daran
 * gescheitert — dieses Modul hängt bloss an keinem Test — aber der erste
 * Test, der es importiert, würde ohne DOM sofort fallen.
 */
function baseUrl(): string {
  return (import.meta as any).env?.VITE_APP_URL ?? window.location.origin;
}

export function ShareDialog({
  mapId,
  onClose,
}: {
  mapId: string;
  onClose: () => void;
}) {
  const user = useMindmapStore((s) => s.user);
  const currentMap = useMindmapStore((s) => s.currentMap);

  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Invite form
  const [inviteEmail, setInviteEmail] = useState('');
  const [invitePermission, setInvitePermission] = useState<string>('edit');
  const [inviting, setInviting] = useState(false);

  // Public link
  const [publicToken, setPublicToken] = useState<string | null>(null);
  const [generatingLink, setGeneratingLink] = useState(false);
  const [copied, setCopied] = useState(false);

  // Per-invite "Copy link" feedback
  const [copiedInviteEmail, setCopiedInviteEmail] = useState<string | null>(null);

  const loadPermissions = useCallback(async () => {
    try {
      const data = await api.fetchPermissions(mapId);
      setPermissions(data.permissions);
      setPendingInvites(data.pendingInvites);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load permissions');
    } finally {
      setLoading(false);
    }
  }, [mapId]);

  useEffect(() => {
    loadPermissions();
  }, [loadPermissions]);

  const handleInvite = async () => {
    const email = inviteEmail.trim();
    if (!email || inviting) return;
    setInviting(true);
    setError(null);
    try {
      const result = await api.shareMap(mapId, email, invitePermission);
      if ('pending' in result && result.pending) {
        setPendingInvites((prev) => {
          const filtered = prev.filter((i) => i.email !== result.email);
          return [...filtered, result];
        });
      } else {
        const perm = result as Permission;
        setPermissions((prev) => {
          const filtered = prev.filter((p) => p.userId !== perm.userId);
          return [...filtered, perm];
        });
      }
      setInviteEmail('');
    } catch (e: any) {
      setError(e.message ?? 'Failed to invite user');
    } finally {
      setInviting(false);
    }
  };

  const handleRevoke = async (userId: string) => {
    if (!confirm('Revoke access for this user?')) return;
    try {
      await api.revokePermission(mapId, userId);
      setPermissions((prev) => prev.filter((p) => p.userId !== userId));
    } catch (e: any) {
      setError(e.message ?? 'Failed to revoke permission');
    }
  };

  const handleRevokeInvite = async (email: string) => {
    if (!confirm('Cancel this pending invite?')) return;
    try {
      await api.revokePendingInvite(mapId, email);
      setPendingInvites((prev) => prev.filter((i) => i.email !== email));
    } catch (e: any) {
      setError(e.message ?? 'Failed to cancel invite');
    }
  };

  const handleGenerateLink = async () => {
    setGeneratingLink(true);
    try {
      const result = await api.generatePublicLink(mapId);
      setPublicToken(result.publicToken);
    } catch (e: any) {
      setError(e.message ?? 'Failed to generate link');
    } finally {
      setGeneratingLink(false);
    }
  };

  const handleCopyLink = () => {
    if (!publicToken) return;
    const url = `${baseUrl()}/public/${mapId}?token=${publicToken}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleCopyInviteLink = (email: string) => {
    // Prefills the register form with this email. The existing pending_invites
    // row is resolved automatically when the user signs up with that email.
    const url = `${baseUrl()}/?email=${encodeURIComponent(email)}&mode=register`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedInviteEmail(email);
      setTimeout(() => setCopiedInviteEmail(null), 2000);
    });
  };

  const isOwner = (p: Permission) => {
    return p.isOwner || (currentMap?.createdBy === p.userId);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: 520,
          maxWidth: '90vw',
          maxHeight: '80vh',
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px 14px',
            borderBottom: '1px solid #f1f5f9',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1e293b' }}>
            Share Map
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 18,
              color: '#94a3b8',
              fontFamily: 'inherit',
              padding: '0 4px',
            }}
          >
            x
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
          {error && (
            <div
              style={{
                marginBottom: 12,
                padding: '8px 12px',
                borderRadius: 6,
                background: '#fef2f2',
                border: '1px solid #fecaca',
                color: '#991b1b',
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}

          {/* Invite form */}
          <div style={{ marginBottom: 20 }}>
            <label
              style={{
                display: 'block',
                fontSize: 11,
                fontWeight: 600,
                color: '#64748b',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                marginBottom: 6,
              }}
            >
              Invite People
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') handleInvite();
                }}
                placeholder="Enter email address"
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  border: '1px solid #e2e8f0',
                  borderRadius: 6,
                  fontSize: 13,
                  fontFamily: 'inherit',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              <select
                value={invitePermission}
                onChange={(e) => setInvitePermission(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                style={{
                  padding: '8px 28px 8px 10px',
                  border: '1px solid #e2e8f0',
                  borderRadius: 6,
                  fontSize: 12,
                  fontFamily: 'inherit',
                  outline: 'none',
                  background: '#fff',
                  appearance: 'none' as const,
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath fill='%2394a3b8' d='M2 3.5L5 7l3-3.5H2z'/%3E%3C/svg%3E")`,
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 8px center',
                  cursor: 'pointer',
                }}
              >
                <option value="view">View</option>
                <option value="edit">Edit</option>
                <option value="admin">Admin</option>
              </select>
              <button
                onClick={handleInvite}
                disabled={inviting || !inviteEmail.trim()}
                style={{
                  background: inviteEmail.trim() ? '#4f46e5' : '#e2e8f0',
                  color: inviteEmail.trim() ? '#fff' : '#94a3b8',
                  border: 'none',
                  borderRadius: 6,
                  padding: '8px 16px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: inviteEmail.trim() ? 'pointer' : 'default',
                  fontFamily: 'inherit',
                  whiteSpace: 'nowrap',
                }}
              >
                {inviting ? '...' : 'Invite'}
              </button>
            </div>
          </div>

          {/* Users with access */}
          <div style={{ marginBottom: 20 }}>
            <label
              style={{
                display: 'block',
                fontSize: 11,
                fontWeight: 600,
                color: '#64748b',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                marginBottom: 8,
              }}
            >
              People with Access
            </label>

            {loading ? (
              <div style={{ fontSize: 12, color: '#94a3b8', padding: 8, textAlign: 'center' }}>
                Loading...
              </div>
            ) : permissions.length === 0 ? (
              <div style={{ fontSize: 12, color: '#94a3b8', padding: 8, textAlign: 'center' }}>
                No shared users yet
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {permissions.map((perm) => {
                  const owner = isOwner(perm);
                  return (
                    <div
                      key={perm.userId}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 10px',
                        background: '#f8fafc',
                        borderRadius: 6,
                      }}
                    >
                      {/* Avatar placeholder */}
                      <div
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: '50%',
                          background: '#e2e8f0',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 12,
                          fontWeight: 600,
                          color: '#64748b',
                          flexShrink: 0,
                        }}
                      >
                        {(perm.userName ?? perm.userEmail ?? '?')[0].toUpperCase()}
                      </div>

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 6 }}>
                          {perm.userName ?? 'User'}
                          {owner && (
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 600,
                                padding: '1px 6px',
                                borderRadius: 4,
                                background: '#fef3c7',
                                color: '#92400e',
                              }}
                            >
                              Owner
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: '#94a3b8' }}>{perm.userEmail ?? ''}</div>
                      </div>

                      {!owner && (
                        <>
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 500,
                              color: '#64748b',
                              textTransform: 'capitalize',
                            }}
                          >
                            {perm.permission}
                          </span>
                          <button
                            onClick={() => handleRevoke(perm.userId)}
                            title="Revoke access"
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              padding: '2px 6px',
                              fontSize: 14,
                              color: '#dc2626',
                              fontFamily: 'inherit',
                            }}
                          >
                            x
                          </button>
                        </>
                      )}

                      {owner && (
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 500,
                            color: '#64748b',
                          }}
                        >
                          Full access
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Pending invites */}
          {pendingInvites.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <label
                style={{
                  display: 'block',
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#64748b',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  marginBottom: 8,
                }}
              >
                Pending Invites
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {pendingInvites.map((invite) => (
                  <div
                    key={invite.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 10px',
                      background: '#fffbeb',
                      borderRadius: 6,
                    }}
                  >
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: '50%',
                        background: '#fde68a',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                        fontWeight: 600,
                        color: '#92400e',
                        flexShrink: 0,
                      }}
                    >
                      {invite.email[0].toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 6 }}>
                        {invite.email}
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: '#fef3c7',
                            color: '#92400e',
                          }}
                        >
                          Pending
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>
                        Send them the invite link to sign up
                      </div>
                    </div>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 500,
                        color: '#64748b',
                        textTransform: 'capitalize',
                      }}
                    >
                      {invite.permission}
                    </span>
                    <button
                      onClick={() => handleCopyInviteLink(invite.email)}
                      title="Copy invite link to clipboard"
                      style={{
                        background: copiedInviteEmail === invite.email ? '#059669' : '#4f46e5',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 6,
                        padding: '4px 10px',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        whiteSpace: 'nowrap',
                        transition: 'background 0.15s',
                      }}
                    >
                      {copiedInviteEmail === invite.email ? 'Copied!' : 'Copy link'}
                    </button>
                    <button
                      onClick={() => handleRevokeInvite(invite.email)}
                      title="Cancel invite"
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '2px 6px',
                        fontSize: 14,
                        color: '#dc2626',
                        fontFamily: 'inherit',
                      }}
                    >
                      x
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Public link */}
          <div>
            <label
              style={{
                display: 'block',
                fontSize: 11,
                fontWeight: 600,
                color: '#64748b',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                marginBottom: 8,
              }}
            >
              Public Link
            </label>

            {publicToken ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  readOnly
                  value={`${baseUrl()}/public/${mapId}?token=${publicToken}`}
                  style={{
                    flex: 1,
                    padding: '8px 10px',
                    border: '1px solid #e2e8f0',
                    borderRadius: 6,
                    fontSize: 11,
                    fontFamily: 'monospace',
                    color: '#475569',
                    background: '#f8fafc',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <button
                  onClick={handleCopyLink}
                  style={{
                    background: copied ? '#059669' : '#4f46e5',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    padding: '8px 12px',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    whiteSpace: 'nowrap',
                    transition: 'background 0.15s',
                  }}
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            ) : (
              <button
                onClick={handleGenerateLink}
                disabled={generatingLink}
                style={{
                  background: '#f1f5f9',
                  border: '1px solid #e2e8f0',
                  borderRadius: 6,
                  padding: '8px 16px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#475569',
                  cursor: generatingLink ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {generatingLink ? 'Generating...' : 'Generate Public View-Only Link'}
              </button>
            )}
            <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
              Anyone with the link can view this map (read-only).
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
