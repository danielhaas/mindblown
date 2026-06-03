/**
 * Settings → API keys panel.
 *
 * Generates per-user API keys for headless MCP / CLI clients (Claude Code
 * is the primary consumer). Plaintext is shown ONCE on creation in a
 * dialog with a pre-formatted Claude Code config snippet ready to paste
 * into ~/.claude/mcp.json. Existing keys are listed by prefix + name; the
 * full secret is never recoverable.
 *
 * Replaces the legacy ClaudeConnectPanel which minted long-lived JWTs
 * for the stdio MCP shim — the HTTP MCP at /mcp + an API key is now the
 * recommended setup.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKey,
  type CreatedApiKey,
} from './api.js';

const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';

function mcpConfigSnippet(plaintextKey: string): string {
  // Heuristic: if the API is served at https://<host>, the MCP endpoint
  // is at /mcp on the same host. For localhost dev, point at the API
  // server directly. Either way, the token is the API key plaintext.
  //
  // Shape MUST match README.md's "Setup (HTTP MCP)" block — Claude
  // Code's ~/.claude/mcp.json requires the outer `mcpServers` wrapper.
  // Without it the paste does nothing on the user's side and step 3 of
  // the persona test ("paste UI snippet into ~/.claude/mcp.json") fails
  // silently.
  const mcpUrl = `${API_URL.replace(/\/$/, '')}/mcp`;
  return JSON.stringify(
    {
      mcpServers: {
        mindblown: {
          type: 'http',
          url: mcpUrl,
          headers: { Authorization: `Bearer ${plaintextKey}` },
        },
      },
    },
    null,
    2,
  );
}

function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function SettingsApiKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKey, setNewKey] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { keys } = await listApiKeys();
      setKeys(keys);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load API keys');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onGenerate = useCallback(async () => {
    if (!newKeyName.trim()) {
      setError('Name is required');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const created = await createApiKey(newKeyName.trim());
      setNewKey(created);
      setNewKeyName('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create API key');
    } finally {
      setCreating(false);
    }
  }, [newKeyName, refresh]);

  const onRevoke = useCallback(
    async (id: string, name: string) => {
      if (!confirm(`Revoke API key "${name}"? This cannot be undone.`)) return;
      try {
        await revokeApiKey(id);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to revoke key');
      }
    },
    [refresh],
  );

  const snippet = useMemo(() => (newKey ? mcpConfigSnippet(newKey.key) : ''), [newKey]);

  const onCopy = useCallback(async () => {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy to clipboard — select the text manually.');
    }
  }, [snippet]);

  const closeCreateModal = useCallback(() => {
    setShowCreateModal(false);
    setNewKey(null);
    setNewKeyName('');
    setError(null);
  }, []);

  const activeKeys = keys.filter((k) => !k.revokedAt);
  const revokedKeys = keys.filter((k) => k.revokedAt);

  return (
    <div
      data-testid="settings-api-keys"
      style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid #f1f5f9' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#1e293b"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
        </svg>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#1e293b' }}>
          API keys
        </h3>
      </div>

      <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 12px' }}>
        Per-user keys for headless clients (Claude Code MCP, CLI tools).
        Each key acts as you do — keep them secret, and revoke promptly if
        leaked. The plaintext is shown ONCE on creation.
      </p>

      {error && !showCreateModal && (
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

      <button
        data-testid="api-keys-generate-button"
        onClick={() => {
          setShowCreateModal(true);
          setNewKey(null);
          setError(null);
        }}
        style={{
          background: '#4f46e5',
          color: '#fff',
          border: 'none',
          borderRadius: 8,
          padding: '8px 16px',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          fontFamily: 'inherit',
          marginBottom: 16,
        }}
      >
        Generate for Claude Code
      </button>

      {loading ? (
        <div style={{ fontSize: 12, color: '#94a3b8' }}>Loading keys…</div>
      ) : activeKeys.length === 0 ? (
        <div style={{ fontSize: 12, color: '#94a3b8' }}>
          No active API keys yet.
        </div>
      ) : (
        <div data-testid="api-keys-list" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {activeKeys.map((key) => (
            <div
              key={key.id}
              data-testid={`api-key-row-${key.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '10px 12px',
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: 8,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>
                  {key.name}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: '#64748b',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    marginTop: 2,
                  }}
                >
                  {key.prefix}… · created {relTime(key.createdAt)} · last used {relTime(key.lastUsedAt)}
                  {key.expiresAt ? ` · expires ${new Date(key.expiresAt).toLocaleDateString()}` : ''}
                </div>
              </div>
              <button
                data-testid={`api-key-revoke-${key.id}`}
                onClick={() => onRevoke(key.id, key.name)}
                style={{
                  background: 'transparent',
                  color: '#dc2626',
                  border: '1px solid #fecaca',
                  borderRadius: 6,
                  padding: '4px 10px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}

      {revokedKeys.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ fontSize: 12, color: '#94a3b8', cursor: 'pointer' }}>
            {revokedKeys.length} revoked
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {revokedKeys.map((key) => (
              <div
                key={key.id}
                style={{
                  fontSize: 11,
                  color: '#94a3b8',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                }}
              >
                {key.name} ({key.prefix}…) — revoked {relTime(key.revokedAt)}
              </div>
            ))}
          </div>
        </details>
      )}

      {showCreateModal && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={closeCreateModal}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff',
              borderRadius: 12,
              padding: 24,
              width: 'min(600px, 90vw)',
              maxHeight: '80vh',
              overflow: 'auto',
            }}
          >
            {!newKey ? (
              <>
                <h3
                  style={{
                    margin: '0 0 12px',
                    fontSize: 16,
                    fontWeight: 600,
                    color: '#1e293b',
                  }}
                >
                  Generate API key
                </h3>
                <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 16px' }}>
                  Name this key so you can identify it later (e.g. "Dan's
                  laptop", "CI runner").
                </p>
                <input
                  data-testid="api-key-name-input"
                  type="text"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="Key name"
                  autoFocus
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: 13,
                    border: '1px solid #e2e8f0',
                    borderRadius: 8,
                    marginBottom: 16,
                    fontFamily: 'inherit',
                    boxSizing: 'border-box',
                  }}
                />
                {error && (
                  <div
                    style={{
                      fontSize: 12,
                      color: '#dc2626',
                      marginBottom: 12,
                    }}
                  >
                    {error}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button
                    onClick={closeCreateModal}
                    style={{
                      background: 'transparent',
                      color: '#64748b',
                      border: '1px solid #e2e8f0',
                      borderRadius: 8,
                      padding: '6px 14px',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    data-testid="api-key-create-submit"
                    onClick={onGenerate}
                    disabled={creating || !newKeyName.trim()}
                    style={{
                      background:
                        creating || !newKeyName.trim() ? '#94a3b8' : '#4f46e5',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 8,
                      padding: '6px 14px',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor:
                        creating || !newKeyName.trim() ? 'default' : 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {creating ? 'Generating…' : 'Generate'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3
                  style={{
                    margin: '0 0 12px',
                    fontSize: 16,
                    fontWeight: 600,
                    color: '#1e293b',
                  }}
                >
                  API key created
                </h3>
                <div
                  style={{
                    background: '#fef3c7',
                    border: '1px solid #fcd34d',
                    color: '#92400e',
                    fontSize: 12,
                    padding: '8px 12px',
                    borderRadius: 6,
                    marginBottom: 12,
                  }}
                >
                  This is the only time the full key is shown — copy it
                  now. You won't be able to see it again.
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>
                    Plaintext key:
                  </div>
                  <pre
                    data-testid="api-key-plaintext"
                    style={{
                      margin: 0,
                      padding: '8px 12px',
                      background: '#0f172a',
                      color: '#e2e8f0',
                      borderRadius: 8,
                      fontSize: 12,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      wordBreak: 'break-all',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {newKey.key}
                  </pre>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>
                    Drop this block into{' '}
                    <code style={{ fontSize: 11 }}>~/.claude/mcp.json</code>{' '}
                    (or the equivalent for your client):
                  </div>
                  <pre
                    data-testid="api-key-mcp-snippet"
                    style={{
                      margin: 0,
                      padding: '12px 14px',
                      background: '#0f172a',
                      color: '#e2e8f0',
                      borderRadius: 8,
                      fontSize: 12,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      whiteSpace: 'pre',
                      overflow: 'auto',
                      lineHeight: 1.5,
                    }}
                  >
                    {snippet}
                  </pre>
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button
                    onClick={onCopy}
                    style={{
                      background: copied ? '#16a34a' : '#1e293b',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 8,
                      padding: '6px 14px',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {copied ? 'Copied' : 'Copy config'}
                  </button>
                  <button
                    onClick={closeCreateModal}
                    style={{
                      background: '#4f46e5',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 8,
                      padding: '6px 14px',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Done
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
