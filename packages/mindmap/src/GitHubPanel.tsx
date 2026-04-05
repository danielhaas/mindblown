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

  const [ghToken, setGhToken] = useState('');
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      // Reload map to get imported nodes
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
          width: 440,
          maxWidth: '90vw',
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
          padding: 24,
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

        {/* Connection form */}
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

        {/* Buttons */}
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
      </div>
    </div>
  );
}
