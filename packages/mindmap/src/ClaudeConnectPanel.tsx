/**
 * "Connect to Claude" panel — mints a long-lived JWT on demand and hands
 * the user a ready-to-paste `claude mcp add` command for the MindBlown MCP
 * server. No token management: regenerating just issues a new one.
 */

import { useCallback, useState } from 'react';
import { createLongLivedToken } from './api.js';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';

function buildCommand(token: string): string {
  return [
    'claude mcp add mindblown',
    `  --env MINDBLOWN_API_URL=${API_URL}`,
    `  --env MINDBLOWN_TOKEN=${token}`,
    '  -- npx -y @mindblown/mcp',
  ].join(' \\\n');
}

export function ClaudeConnectPanel() {
  const [command, setCommand] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const onGenerate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { token } = await createLongLivedToken();
      setCommand(buildCommand(token));
      setCopied(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate token');
    } finally {
      setLoading(false);
    }
  }, []);

  const onCopy = useCallback(async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy to clipboard — select the text manually.');
    }
  }, [command]);

  return (
    <div style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid #f1f5f9' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1e293b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#1e293b' }}>
          Connect to Claude Code
        </h3>
      </div>

      <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 12px' }}>
        Add MindBlown as an MCP server so Claude Code can read and edit your maps.
        Clicking below mints a 1-year token and gives you a single command to paste
        into your terminal.
      </p>

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

      {!command && (
        <button
          onClick={onGenerate}
          disabled={loading}
          style={{
            background: loading ? '#94a3b8' : '#4f46e5',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            padding: '8px 16px',
            fontSize: 13,
            fontWeight: 600,
            cursor: loading ? 'default' : 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {loading ? 'Generating...' : 'Generate connection command'}
        </button>
      )}

      {command && (
        <>
          <pre
            style={{
              margin: '0 0 8px',
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
            {command}
          </pre>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={onCopy}
              style={{
                background: copied ? '#16a34a' : '#1e293b',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {copied ? 'Copied' : 'Copy command'}
            </button>
            <button
              onClick={onGenerate}
              disabled={loading}
              style={{
                background: 'transparent',
                color: '#64748b',
                border: '1px solid #e2e8f0',
                borderRadius: 8,
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 600,
                cursor: loading ? 'default' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Regenerate
            </button>
          </div>
          <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
            Paste this in your terminal, then restart Claude Code. The token
            expires in 365 days — regenerate to get a fresh one (old tokens
            remain valid until they expire).
          </p>
        </>
      )}
    </div>
  );
}
