/**
 * Workspace Settings modal — GitHub App connection + per-map repo picker.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  getGitHubInstallStatus,
  getGitHubInstallUrl,
  getGitHubRepositories,
  disconnectGitHub,
  updateMap,
} from './api.js';
import type { GitHubInstallStatus, GitHubRepoInfo } from './api.js';
import { useMindmapStore } from './store.js';
import { RegistrationPolicyPanel } from './RegistrationPolicyPanel.js';
import { ChangePasswordPanel } from './ChangePasswordPanel.js';
import { AdminPasswordResetPanel } from './AdminPasswordResetPanel.js';
import { ClaudeConnectPanel } from './ClaudeConnectPanel.js';
import { SettingsApiKeys } from './SettingsApiKeys.js';
import { AiProviderPanel } from './AiProviderPanel.js';

export function WorkspaceSettings({
  onClose,
  mapId,
}: {
  onClose: () => void;
  mapId?: string | null;
}) {
  const [status, setStatus] = useState<GitHubInstallStatus | null>(null);
  const [repos, setRepos] = useState<GitHubRepoInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [saving, setSaving] = useState(false);

  // Current map's GitHub repo from the store
  const map = useMindmapStore((s) => s.currentMap);
  const currentRepo = map
    ? (map.githubRepoOwner && map.githubRepoName
        ? `${map.githubRepoOwner}/${map.githubRepoName}`
        : '')
    : '';
  const [selectedRepo, setSelectedRepo] = useState(currentRepo);

  useEffect(() => {
    setSelectedRepo(currentRepo);
  }, [currentRepo]);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await getGitHubInstallStatus();
      setStatus(s);

      if (s.connected && s.installations.length > 0) {
        try {
          const r = await getGitHubRepositories(s.installations[0].installationId);
          setRepos(r.repositories);
        } catch {
          // Repos may fail but connection status is still valid
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleConnect = useCallback(async () => {
    try {
      const { installUrl } = await getGitHubInstallUrl();
      window.location.href = installUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start GitHub connection');
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    if (!confirm('Disconnect GitHub? Existing issue links will stop syncing.')) return;
    setDisconnecting(true);
    try {
      await disconnectGitHub();
      setStatus(null);
      setRepos([]);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  }, [loadStatus]);

  const handleSaveRepo = useCallback(async () => {
    if (!mapId) return;
    setSaving(true);
    setError(null);
    try {
      const installationId = status?.installations[0]?.installationId ?? null;
      if (selectedRepo) {
        const [owner, name] = selectedRepo.split('/');
        await updateMap(mapId, {
          githubInstallationId: installationId,
          githubRepoOwner: owner,
          githubRepoName: name,
        });
      } else {
        await updateMap(mapId, {
          githubInstallationId: null,
          githubRepoOwner: null,
          githubRepoName: null,
        });
      }
      // Refresh map in the store
      useMindmapStore.getState().loadMap(mapId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save repo');
    } finally {
      setSaving(false);
    }
  }, [mapId, selectedRepo, status, onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 16,
          width: 520,
          maxWidth: '90vw',
          maxHeight: '80vh',
          overflow: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px 16px',
            borderBottom: '1px solid #f1f5f9',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1e293b' }}>
            {mapId ? 'GitHub Settings' : 'Workspace Settings'}
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 18,
              color: '#94a3b8',
              padding: '4px 8px',
            }}
          >
            x
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '20px 24px' }}>
          {/* GitHub connection section */}
          <div style={{ marginBottom: mapId && status?.connected ? 0 : 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <svg width="18" height="18" viewBox="0 0 16 16" fill="#1e293b">
                <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#1e293b' }}>
                GitHub
              </h3>
            </div>

            {loading && (
              <div style={{ fontSize: 13, color: '#94a3b8', padding: '12px 0' }}>
                Loading...
              </div>
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

            {!loading && status && !status.appConfigured && (
              <div
                style={{
                  fontSize: 13,
                  color: '#64748b',
                  background: '#f8fafc',
                  padding: '12px 16px',
                  borderRadius: 8,
                }}
              >
                GitHub App is not configured on this server. Ask your admin to set
                the <code>GITHUB_APP_*</code> environment variables.
              </div>
            )}

            {!loading && status && status.appConfigured && !status.connected && (
              <div>
                <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 12px' }}>
                  Connect your GitHub account to sync issues, get webhook updates,
                  and link repos to your maps.
                </p>
                <button
                  onClick={handleConnect}
                  style={{
                    background: '#1e293b',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    padding: '8px 16px',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="#fff">
                    <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                  Connect GitHub
                </button>
              </div>
            )}

            {!loading && status && status.connected && status.identity && (
              <div>
                {/* Connected user info */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 16px',
                    background: '#f0fdf4',
                    borderRadius: 8,
                    marginBottom: 16,
                  }}
                >
                  {status.identity.avatarUrl && (
                    <img
                      src={status.identity.avatarUrl}
                      alt=""
                      style={{ width: 32, height: 32, borderRadius: '50%' }}
                    />
                  )}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#166534' }}>
                      Connected as @{status.identity.githubLogin}
                    </div>
                    {status.installations.length > 0 && (
                      <div style={{ fontSize: 11, color: '#15803d', marginTop: 2 }}>
                        {status.installations.map((i) => i.accountLogin).join(', ')}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={handleDisconnect}
                    disabled={disconnecting}
                    style={{
                      background: 'none',
                      border: '1px solid #fca5a5',
                      borderRadius: 6,
                      padding: '4px 12px',
                      fontSize: 11,
                      fontWeight: 600,
                      color: '#dc2626',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      opacity: disconnecting ? 0.5 : 1,
                    }}
                  >
                    {disconnecting ? 'Disconnecting...' : 'Disconnect'}
                  </button>
                </div>

                {/* Per-map repo picker */}
                {mapId && repos.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <h4 style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Repository for this map
                    </h4>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <select
                        value={selectedRepo}
                        onChange={(e) => setSelectedRepo(e.target.value)}
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
                      >
                        <option value="">No repo linked</option>
                        {repos.map((repo) => (
                          <option key={repo.id} value={repo.fullName}>
                            {repo.fullName}{repo.private ? ' (private)' : ''}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={handleSaveRepo}
                        disabled={saving || selectedRepo === currentRepo}
                        style={{
                          background: selectedRepo === currentRepo ? '#e2e8f0' : '#4f46e5',
                          color: selectedRepo === currentRepo ? '#94a3b8' : '#fff',
                          border: 'none',
                          borderRadius: 8,
                          padding: '8px 16px',
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: selectedRepo === currentRepo ? 'default' : 'pointer',
                          fontFamily: 'inherit',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                    {currentRepo && (
                      <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>
                        Currently linked to <strong>{currentRepo}</strong>
                      </div>
                    )}
                  </div>
                )}

                {/* Accessible repos list (only in workspace view, not per-map) */}
                {!mapId && repos.length > 0 && (
                  <div>
                    <h4 style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Accessible Repositories ({repos.length})
                    </h4>
                    <div
                      style={{
                        maxHeight: 200,
                        overflow: 'auto',
                        border: '1px solid #e2e8f0',
                        borderRadius: 8,
                      }}
                    >
                      {repos.map((repo) => (
                        <div
                          key={repo.id}
                          style={{
                            padding: '8px 12px',
                            borderBottom: '1px solid #f1f5f9',
                            fontSize: 13,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                          }}
                        >
                          <span style={{ fontWeight: 500, color: '#1e293b' }}>
                            {repo.fullName}
                          </span>
                          {repo.private && (
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
                              Private
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* API keys (HTTP MCP, headless clients) — shown only in workspace-wide view */}
          {!mapId && <SettingsApiKeys />}

          {/* Connect to Claude (legacy stdio MCP shim) — shown only in workspace-wide view */}
          {!mapId && <ClaudeConnectPanel />}

          {/* Account password — shown only in workspace-wide view */}
          {!mapId && <ChangePasswordPanel />}

          {/* Registration policy — shown only in workspace-wide view */}
          {!mapId && <RegistrationPolicyPanel />}

          {/* Admin password reset — shown only in workspace-wide view */}
          {!mapId && <AdminPasswordResetPanel />}

          {/* AI chat provider — shown only in workspace-wide view */}
          {!mapId && <AiProviderPanel />}
        </div>
      </div>
    </div>
  );
}
