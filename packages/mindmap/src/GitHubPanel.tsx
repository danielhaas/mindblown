import { useCallback, useEffect, useState } from 'react';
import type { Node } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { GitHubIssueStatus } from './api.js';

// ── Node-level GitHub section ────────────────────────────────────

export function GitHubNodeSection({
  mapId,
  node,
}: {
  mapId: string;
  node: Node;
}) {
  const updateNode = useMindmapStore((s) => s.updateNode);
  const [statuses, setStatuses] = useState<GitHubIssueStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const githubLinks = node.externalLinks?.filter((l) => l.provider === 'github') ?? [];
  const hasGitHubLink = githubLinks.length > 0;

  const fetchStatus = useCallback(async () => {
    if (!hasGitHubLink) return;
    setLoading(true);
    try {
      const data = await api.getGitHubStatus(mapId, node.id);
      if (data.issues) setStatuses(data.issues);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [mapId, node.id, hasGitHubLink]);

  useEffect(() => {
    if (hasGitHubLink) fetchStatus();
  }, [hasGitHubLink, fetchStatus]);

  const handleCreateIssue = async () => {
    setCreating(true);
    setError(null);
    try {
      const result = await api.createGitHubIssue(mapId, node.id);
      updateNode(node.id, { externalLinks: result.node.externalLinks });
      fetchStatus();
    } catch (e: any) {
      setError(e.message ?? 'Failed to create issue');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: '#64748b',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          marginBottom: 8,
        }}
      >
        GitHub
      </div>

      {error && (
        <div
          style={{
            marginBottom: 8,
            padding: '6px 10px',
            borderRadius: 4,
            background: '#fef2f2',
            color: '#991b1b',
            fontSize: 11,
          }}
        >
          {error}
        </div>
      )}

      {/* Linked issues */}
      {hasGitHubLink && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
          {statuses.length > 0 ? statuses.map((s) => (
            <div
              key={s.externalId}
              style={{
                padding: '6px 10px',
                background: '#f8fafc',
                borderRadius: 6,
                border: '1px solid #f1f5f9',
                fontSize: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="#1e293b">
                  <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                </svg>
                <span style={{ fontWeight: 600, color: '#1e293b' }}>{s.externalId}</span>
                {s.state && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      padding: '1px 6px',
                      borderRadius: 4,
                      background: s.state === 'open' ? '#dcfce7' : '#f1f5f9',
                      color: s.state === 'open' ? '#166534' : '#64748b',
                    }}
                  >
                    {s.state}
                  </span>
                )}
              </div>
              {s.title && (
                <div style={{ color: '#475569', fontSize: 11 }}>{s.title}</div>
              )}
              {s.url && (
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 10, color: '#4f46e5', textDecoration: 'none' }}
                >
                  Open on GitHub
                </a>
              )}
              {s.error && (
                <div style={{ color: '#dc2626', fontSize: 10 }}>Error: {s.error}</div>
              )}
            </div>
          )) : loading ? (
            <div style={{ fontSize: 12, color: '#94a3b8', textAlign: 'center', padding: 8 }}>Loading...</div>
          ) : (
            githubLinks.map((link) => (
              <div key={link.externalId} style={{ fontSize: 12, color: '#475569', padding: '4px 0' }}>
                {link.externalId} -
                <a href={link.url} target="_blank" rel="noopener noreferrer" style={{ color: '#4f46e5', marginLeft: 4 }}>
                  Open
                </a>
              </div>
            ))
          )}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          onClick={() => setLinkDialogOpen(true)}
          style={{
            background: '#f1f5f9',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            padding: '5px 10px',
            fontSize: 11,
            fontWeight: 500,
            color: '#475569',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Link Issue
        </button>
        <button
          onClick={handleCreateIssue}
          disabled={creating}
          style={{
            background: '#f1f5f9',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            padding: '5px 10px',
            fontSize: 11,
            fontWeight: 500,
            color: '#475569',
            cursor: creating ? 'default' : 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {creating ? 'Creating...' : 'Create Issue'}
        </button>
        {hasGitHubLink && (
          <button
            onClick={fetchStatus}
            disabled={loading}
            style={{
              background: '#f1f5f9',
              border: '1px solid #e2e8f0',
              borderRadius: 6,
              padding: '5px 10px',
              fontSize: 11,
              fontWeight: 500,
              color: '#475569',
              cursor: loading ? 'default' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {loading ? 'Syncing...' : 'Sync Status'}
          </button>
        )}
      </div>

      {/* Link Issue Dialog */}
      {linkDialogOpen && (
        <LinkIssueDialog
          mapId={mapId}
          nodeId={node.id}
          onClose={() => setLinkDialogOpen(false)}
          onLinked={() => {
            setLinkDialogOpen(false);
            fetchStatus();
          }}
        />
      )}
    </div>
  );
}

// ── Link Issue Dialog ────────────────────────────────────────────

function LinkIssueDialog({
  mapId,
  nodeId,
  onClose,
  onLinked,
}: {
  mapId: string;
  nodeId: string;
  onClose: () => void;
  onLinked: () => void;
}) {
  const updateNode = useMindmapStore((s) => s.updateNode);
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [issueNumber, setIssueNumber] = useState('');
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLink = async () => {
    if (!owner || !repo || !issueNumber) return;
    setLinking(true);
    setError(null);
    try {
      const result = await api.linkGitHubIssue(mapId, nodeId, owner, repo, parseInt(issueNumber, 10));
      updateNode(nodeId, { externalLinks: result.node.externalLinks });
      onLinked();
    } catch (e: any) {
      setError(e.message ?? 'Failed to link issue');
    } finally {
      setLinking(false);
    }
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
        zIndex: 110,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: 360,
          maxWidth: '90vw',
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
          padding: 24,
        }}
      >
        <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700, color: '#1e293b' }}>
          Link to GitHub Issue
        </h3>

        {error && (
          <div
            style={{
              marginBottom: 12,
              padding: '6px 10px',
              borderRadius: 4,
              background: '#fef2f2',
              color: '#991b1b',
              fontSize: 11,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>
              Owner
            </label>
            <input
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="e.g. facebook"
              style={{
                width: '100%',
                padding: '7px 10px',
                border: '1px solid #e2e8f0',
                borderRadius: 6,
                fontSize: 13,
                fontFamily: 'inherit',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>
              Repo
            </label>
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="e.g. react"
              style={{
                width: '100%',
                padding: '7px 10px',
                border: '1px solid #e2e8f0',
                borderRadius: 6,
                fontSize: 13,
                fontFamily: 'inherit',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>
              Issue Number
            </label>
            <input
              type="number"
              value={issueNumber}
              onChange={(e) => setIssueNumber(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="e.g. 42"
              style={{
                width: '100%',
                padding: '7px 10px',
                border: '1px solid #e2e8f0',
                borderRadius: 6,
                fontSize: 13,
                fontFamily: 'inherit',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
          <button
            onClick={onClose}
            style={{
              background: '#f1f5f9',
              border: 'none',
              borderRadius: 6,
              padding: '8px 16px',
              fontSize: 12,
              fontWeight: 600,
              color: '#475569',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleLink}
            disabled={linking || !owner || !repo || !issueNumber}
            style={{
              background: '#4f46e5',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              padding: '8px 16px',
              fontSize: 12,
              fontWeight: 600,
              cursor: linking ? 'default' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {linking ? 'Linking...' : 'Link Issue'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Map-level GitHub Settings Dialog ─────────────────────────────

export function GitHubSettingsDialog({
  mapId,
  onClose,
}: {
  mapId: string;
  onClose: () => void;
}) {
  const currentMap = useMindmapStore((s) => s.currentMap);
  const user = useMindmapStore((s) => s.user);
  const loadMap = useMindmapStore((s) => s.loadMap);

  const workspaceId = currentMap?.workspaceId ?? 'default';
  const hasAppRepo = !!(currentMap?.githubRepoOwner && currentMap?.githubRepoName);
  const appRepoLabel = hasAppRepo ? `${currentMap!.githubRepoOwner}/${currentMap!.githubRepoName}` : null;

  // Legacy PAT state
  const [ghToken, setGhToken] = useState('');
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [showLegacy, setShowLegacy] = useState(false);

  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [syncOverview, setSyncOverview] = useState<api.GitHubSyncOverview | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncIncludeClosed, setSyncIncludeClosed] = useState(false);

  const [reconciling, setReconciling] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<api.GitHubReconcileResult | null>(null);

  const handleReconcile = async () => {
    setReconciling(true);
    setError(null);
    setReconcileResult(null);
    try {
      const result = await api.reconcileGitHub(mapId);
      setReconcileResult(result);
      if (result.applied > 0) {
        loadMap(mapId);
        if (syncOverview) await handleSyncOverview(syncIncludeClosed);
      }
    } catch (e: any) {
      setError(e.message ?? 'Failed to reconcile');
    } finally {
      setReconciling(false);
    }
  };

  const handleSyncOverview = async (includeClosed: boolean) => {
    setSyncLoading(true);
    setError(null);
    try {
      const data = await api.getGitHubSyncOverview(mapId, includeClosed);
      setSyncOverview(data);
      setSyncIncludeClosed(includeClosed);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load sync overview');
    } finally {
      setSyncLoading(false);
    }
  };

  const handlePromoteFromOverview = async (nodeId: string) => {
    try {
      await api.createGitHubIssue(mapId, nodeId);
      await handleSyncOverview(syncIncludeClosed); // refresh
      loadMap(mapId);
    } catch (e: any) {
      setError(e.message ?? 'Failed to promote node to GitHub issue');
    }
  };

  const handleConnect = async () => {
    if (!ghToken || !owner || !repo) return;
    setConnecting(true);
    setError(null);
    try {
      await api.connectGitHub(workspaceId, ghToken, owner, repo);
      setConnected(true);
    } catch (e: any) {
      setError(e.message ?? 'Failed to connect');
    } finally {
      setConnecting(false);
    }
  };

  const handleImport = async () => {
    if (!user) return;
    setImporting(true);
    setError(null);
    try {
      const result = await api.importGitHubIssues(mapId, user.id);
      setImportResult(result);
      loadMap(mapId);
    } catch (e: any) {
      setError(e.message ?? 'Failed to import');
    } finally {
      setImporting(false);
    }
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
          width: syncOverview ? 880 : 440,
          maxWidth: '90vw',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
          padding: 24,
          transition: 'width 0.2s ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1e293b' }}>
            GitHub Integration
          </h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#94a3b8', fontFamily: 'inherit' }}
          >
            x
          </button>
        </div>

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

        {importResult && (
          <div
            style={{
              marginBottom: 16,
              padding: '8px 12px',
              borderRadius: 6,
              background: '#dbeafe',
              color: '#1e40af',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Imported {importResult.imported} issues
          </div>
        )}

        {/* App-connected repo */}
        {hasAppRepo && (
          <div>
            <div
              style={{
                marginBottom: 16,
                padding: '12px 16px',
                borderRadius: 8,
                background: '#f0fdf4',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="#166534">
                <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#166534' }}>
                Linked to {appRepoLabel}
              </span>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              <button
                onClick={handleImport}
                disabled={importing}
                style={{
                  background: '#4f46e5',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  padding: '8px 16px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: importing ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                  opacity: importing ? 0.7 : 1,
                }}
              >
                {importing ? 'Importing...' : 'Import Issues'}
              </button>
              <button
                onClick={() => handleSyncOverview(syncIncludeClosed)}
                disabled={syncLoading}
                style={{
                  background: '#f1f5f9',
                  border: '1px solid #e2e8f0',
                  borderRadius: 6,
                  padding: '8px 16px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#475569',
                  cursor: syncLoading ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {syncLoading ? 'Loading...' : syncOverview ? 'Refresh Sync Status' : 'Sync Status'}
              </button>
              <button
                onClick={handleReconcile}
                disabled={reconciling}
                title="Pull recent issue state changes from GitHub (catch up missed webhooks)"
                style={{
                  background: '#f1f5f9',
                  border: '1px solid #e2e8f0',
                  borderRadius: 6,
                  padding: '8px 16px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#475569',
                  cursor: reconciling ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {reconciling ? 'Reconciling...' : 'Reconcile'}
              </button>
              <button
                onClick={onClose}
                style={{
                  background: '#f1f5f9',
                  border: 'none',
                  borderRadius: 6,
                  padding: '8px 16px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#475569',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  marginLeft: 'auto',
                }}
              >
                Close
              </button>
            </div>

            {reconcileResult && (
              <div style={{
                marginBottom: 12, padding: '8px 12px', borderRadius: 6,
                background: reconcileResult.error ? '#fef2f2' : '#f0fdf4',
                border: reconcileResult.error ? '1px solid #fecaca' : '1px solid #bbf7d0',
                fontSize: 12, color: reconcileResult.error ? '#991b1b' : '#166534',
              }}>
                {reconcileResult.error
                  ? `Reconcile failed: ${reconcileResult.error}`
                  : `Reconciled ${reconcileResult.repo}: ${reconcileResult.applied} updated, ${reconcileResult.fetched} checked.`}
              </div>
            )}

            {syncOverview && (
              <SyncOverviewSection
                overview={syncOverview}
                includeClosed={syncIncludeClosed}
                onToggleClosed={(val) => handleSyncOverview(val)}
                onPromote={handlePromoteFromOverview}
              />
            )}

            <button
              onClick={() => setShowLegacy(!showLegacy)}
              style={{
                background: 'none',
                border: 'none',
                fontSize: 11,
                color: '#94a3b8',
                cursor: 'pointer',
                fontFamily: 'inherit',
                padding: 0,
              }}
            >
              {showLegacy ? 'Hide legacy token' : 'Use legacy token instead...'}
            </button>
          </div>
        )}

        {/* Legacy PAT form (shown when no App repo, or user clicks "legacy") */}
        {(!hasAppRepo || showLegacy) && (
          <div style={{ marginTop: hasAppRepo ? 12 : 0 }}>
            {connected && (
              <div
                style={{
                  marginBottom: 16,
                  padding: '8px 12px',
                  borderRadius: 6,
                  background: '#dcfce7',
                  color: '#166534',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                Connected to {owner}/{repo}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>
                  GitHub Personal Access Token
                </label>
                <input
                  type="password"
                  value={ghToken}
                  onChange={(e) => setGhToken(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder="ghp_..."
                  style={{
                    width: '100%',
                    padding: '7px 10px',
                    border: '1px solid #e2e8f0',
                    borderRadius: 6,
                    fontSize: 13,
                    fontFamily: 'inherit',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>
                    Owner
                  </label>
                  <input
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder="org or user"
                    style={{
                      width: '100%',
                      padding: '7px 10px',
                      border: '1px solid #e2e8f0',
                      borderRadius: 6,
                      fontSize: 13,
                      fontFamily: 'inherit',
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>
                    Repo
                  </label>
                  <input
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder="repository"
                    style={{
                      width: '100%',
                      padding: '7px 10px',
                      border: '1px solid #e2e8f0',
                      borderRadius: 6,
                      fontSize: 13,
                      fontFamily: 'inherit',
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleConnect}
                disabled={connecting || !ghToken || !owner || !repo}
                style={{
                  background: '#4f46e5',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  padding: '8px 16px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: connecting ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {connecting ? 'Connecting...' : connected ? 'Reconnect' : 'Connect GitHub'}
              </button>

              {connected && (
                <button
                  onClick={handleImport}
                  disabled={importing}
                  style={{
                    background: '#f1f5f9',
                    border: '1px solid #e2e8f0',
                    borderRadius: 6,
                    padding: '8px 16px',
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#475569',
                    cursor: importing ? 'default' : 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {importing ? 'Importing...' : 'Import Issues'}
                </button>
              )}

              {!hasAppRepo && (
                <button
                  onClick={onClose}
                  style={{
                    background: '#f1f5f9',
                    border: 'none',
                    borderRadius: 6,
                    padding: '8px 16px',
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#475569',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    marginLeft: 'auto',
                  }}
                >
                  Close
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sync Overview Section ─────────────────────────────────────────
// Three-column view: synced, onlyInMindBlown, onlyInGitHub.
// Rendered inside GitHubSettingsDialog when the user clicks Sync Status.

function SyncOverviewSection({
  overview,
  includeClosed,
  onToggleClosed,
  onPromote,
}: {
  overview: api.GitHubSyncOverview;
  includeClosed: boolean;
  onToggleClosed: (val: boolean) => void;
  onPromote: (nodeId: string) => void;
}) {
  return (
    <div
      style={{
        marginTop: 4,
        paddingTop: 16,
        borderTop: '1px solid #e2e8f0',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, color: '#1e293b' }}>
          Sync Status — {overview.repo}
        </div>
        <label style={{ fontSize: 11, color: '#64748b', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={includeClosed}
            onChange={(e) => onToggleClosed(e.target.checked)}
          />
          Include closed issues
        </label>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: 12,
        }}
      >
        <SyncBucket
          title="Synced"
          count={overview.counts.synced}
          tint="#dcfce7"
          border="#bbf7d0"
          color="#166534"
          emptyMsg="No linked nodes yet."
        >
          {overview.synced.map((s) => (
            <div key={s.externalId} style={bucketRowStyle}>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2 }}>
                <a
                  href={s.issueUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#4f46e5', textDecoration: 'none', fontWeight: 600 }}
                >
                  #{s.issueNumber}
                </a>
                {' '}
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    padding: '1px 5px',
                    borderRadius: 3,
                    background: s.issueState === 'open' ? '#dcfce7' : '#f1f5f9',
                    color: s.issueState === 'open' ? '#166534' : '#64748b',
                    marginLeft: 4,
                  }}
                >
                  {s.issueState}
                </span>
              </div>
              <div style={bucketRowText}>{s.text}</div>
            </div>
          ))}
        </SyncBucket>

        <SyncBucket
          title="Only in MindBlown"
          count={overview.counts.onlyInMindBlown}
          tint="#eef2ff"
          border="#c7d2fe"
          color="#4338ca"
          emptyMsg="Every leaf is linked."
        >
          {overview.onlyInMindBlown.map((n) => (
            <div key={n.nodeId} style={bucketRowStyle}>
              <div style={bucketRowText}>{n.text}</div>
              <button
                onClick={() => onPromote(n.nodeId)}
                style={promoteButtonStyle}
                title="Create a new GitHub issue for this node"
              >
                Promote →
              </button>
            </div>
          ))}
        </SyncBucket>

        <SyncBucket
          title="Only in GitHub"
          count={overview.counts.onlyInGitHub}
          tint="#fef3c7"
          border="#fde68a"
          color="#92400e"
          emptyMsg="Every issue is linked."
        >
          {overview.onlyInGitHub.map((i) => (
            <div key={i.issueNumber} style={bucketRowStyle}>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2 }}>
                <a
                  href={i.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#4f46e5', textDecoration: 'none', fontWeight: 600 }}
                >
                  #{i.issueNumber}
                </a>
                {' '}
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    padding: '1px 5px',
                    borderRadius: 3,
                    background: i.state === 'open' ? '#dcfce7' : '#f1f5f9',
                    color: i.state === 'open' ? '#166534' : '#64748b',
                    marginLeft: 4,
                  }}
                >
                  {i.state}
                </span>
              </div>
              <div style={bucketRowText}>{i.title}</div>
            </div>
          ))}
        </SyncBucket>
      </div>
    </div>
  );
}

function SyncBucket({
  title,
  count,
  tint,
  border,
  color,
  emptyMsg,
  children,
}: {
  title: string;
  count: number;
  tint: string;
  border: string;
  color: string;
  emptyMsg: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: `1px solid ${border}`,
        borderRadius: 8,
        overflow: 'hidden',
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 120,
      }}
    >
      <div
        style={{
          background: tint,
          padding: '8px 12px',
          borderBottom: `1px solid ${border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color }}>{title}</span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color,
            background: '#fff',
            borderRadius: 10,
            padding: '1px 8px',
          }}
        >
          {count}
        </span>
      </div>
      <div
        style={{
          padding: 8,
          overflowY: 'auto',
          maxHeight: 360,
          flex: 1,
        }}
      >
        {count === 0 ? (
          <div style={{ fontSize: 11, color: '#94a3b8', textAlign: 'center', padding: 16 }}>
            {emptyMsg}
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

const bucketRowStyle: React.CSSProperties = {
  padding: '6px 8px',
  borderRadius: 6,
  background: '#f8fafc',
  marginBottom: 4,
};

const bucketRowText: React.CSSProperties = {
  fontSize: 12,
  color: '#1e293b',
  lineHeight: 1.3,
  wordBreak: 'break-word',
};

const promoteButtonStyle: React.CSSProperties = {
  marginTop: 4,
  background: '#4f46e5',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  padding: '3px 8px',
  fontSize: 10,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};
