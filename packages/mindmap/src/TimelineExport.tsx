/**
 * Export → Markdown timeline, and Publish to wiki (#637).
 *
 * Lives in the Import / Export dialog's export tab. The timeline is rendered
 * on the server (GET /api/maps/:id/export.md) so the copy, the download, the
 * MCP tool and the wiki page are the same document.
 */
import { useEffect, useState } from 'react';
import * as api from './api.js';
import type { WikiStatus } from './api.js';

const box: React.CSSProperties = {
  padding: '12px 16px',
  background: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
const btn: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: 600,
  border: '1px solid #c7d2fe',
  background: '#eef2ff',
  color: '#4f46e5',
  borderRadius: 6,
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const input: React.CSSProperties = {
  padding: '6px 8px',
  fontSize: 12,
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  fontFamily: 'inherit',
};
const hint: React.CSSProperties = { fontSize: 11, color: '#94a3b8' };

function download(text: string, fileName: string) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function TimelineExport({ mapId, mapName }: { mapId: string; mapName: string }) {
  const [detail, setDetail] = useState<'summary' | 'full'>('summary');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (action: 'copy' | 'download') => {
    setBusy(true);
    setMessage(null);
    try {
      const md = await api.exportTimelineMarkdown(mapId, { detail });
      if (action === 'copy') {
        await navigator.clipboard.writeText(md);
        setMessage('Copied — paste it into any wiki or document.');
      } else {
        download(md, `${mapName.replace(/[^\w.-]+/g, '-')}-timeline.md`);
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={box}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>Markdown timeline</div>
        <div style={hint}>
          For readers outside the project: milestones in schedule order, projected dates, what each is waiting on.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={detail} onChange={(e) => setDetail(e.target.value as 'summary' | 'full')} style={input} aria-label="Detail">
          <option value="summary">Summary</option>
          <option value="full">Full (ids, effort)</option>
        </select>
        <button style={btn} disabled={busy} onClick={() => void run('copy')}>Copy</button>
        <button style={btn} disabled={busy} onClick={() => void run('download')}>Download .md</button>
      </div>
      {message && <div style={hint}>{message}</div>}
      <WikiPublish mapId={mapId} />
    </div>
  );
}

function WikiPublish({ mapId }: { mapId: string }) {
  const [status, setStatus] = useState<WikiStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ baseUrl: '', token: '', collectionId: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getWikiStatus(mapId)
      .then((s) => {
        if (!live) return;
        setStatus(s);
        setForm({ baseUrl: s.baseUrl ?? '', token: '', collectionId: s.collectionId ?? '' });
      })
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [mapId]);

  const publish = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.publishToWiki(mapId);
      setStatus((s) => (s ? { ...s, document: { id: r.documentId, url: r.documentUrl, publishedAt: r.publishedAt } } : s));
      setMessage(r.created ? 'Created the wiki page.' : 'Updated the wiki page.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const s = await api.saveWikiSettings(mapId, {
        baseUrl: form.baseUrl,
        collectionId: form.collectionId,
        ...(form.token ? { token: form.token } : {}),
      });
      setStatus(s);
      setEditing(false);
      setForm((f) => ({ ...f, token: '' }));
      setMessage('Wiki connection saved.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;

  return (
    <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#1e293b' }}>Publish to wiki (Outline)</div>
      {status.configured && !editing ? (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button style={btn} disabled={busy} onClick={() => void publish()}>
              {status.document ? 'Update wiki page' : 'Publish to wiki'}
            </button>
            <button style={{ ...btn, background: 'transparent', borderColor: '#e2e8f0', color: '#64748b' }} onClick={() => setEditing(true)}>
              Connection…
            </button>
          </div>
          {status.document ? (
            <div style={hint}>
              <a href={status.document.url} target="_blank" rel="noreferrer">Open the wiki page</a> — last published{' '}
              {new Date(status.document.publishedAt).toLocaleString()}. The page is read-only output; edit the map.
            </div>
          ) : (
            <div style={hint}>Creates a page in {status.baseUrl}; publishing again updates the same page.</div>
          )}
        </>
      ) : (
        <>
          <div style={hint}>
            The workspace owner connects an Outline wiki once: its URL, an API token (Settings → API in Outline) and the
            collection id the pages go to.
          </div>
          <input style={input} placeholder="https://wiki.example.com" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          <input
            style={input}
            type="password"
            placeholder={status.configured ? 'API token (leave empty to keep)' : 'API token'}
            value={form.token}
            onChange={(e) => setForm({ ...form, token: e.target.value })}
          />
          <input style={input} placeholder="Collection id" value={form.collectionId} onChange={(e) => setForm({ ...form, collectionId: e.target.value })} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={btn} disabled={busy} onClick={() => void save()}>Save connection</button>
            {status.configured && (
              <button style={{ ...btn, background: 'transparent', borderColor: '#e2e8f0', color: '#64748b' }} onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </>
      )}
      {message && <div style={hint}>{message}</div>}
    </div>
  );
}
