/**
 * Waiting for the reporter — tickets an outside reporter filed whose fix
 * is merged. They are finished when the reporter has seen the fix working:
 *
 *   merged, not live yet   → "Deployed — ask the reporters" (per project)
 *   asked on the issue     → closes when the reporter closes it, or after
 *                            the timeout; "Close now" if you checked it
 *   the reporter replied   → Reopen with your brief, or Close
 *
 * The reporter's reply is their own words, shown as a quote. Reopening
 * never copies it into the ticket: the person writes what the fleet does.
 */
import React, { useEffect, useState } from 'react';
import type { ReporterCheck, ReporterCheckList } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { FleetTarget } from './api.js';
import { Card } from './DigestView.js';
import { projectLabel, scopeTarget, useFleetScope } from './fleetScope.js';
import { projectTag } from './FleetTelemetry.js';

const POLL_MS = 60_000;

export function ReporterChecksSection({ target: given, mobile = false }: { target?: FleetTarget; mobile?: boolean }) {
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const asksRev = useMindmapStore((s) => s.asksRev);
  const viewRole = useMindmapStore((s) => s.viewRole);
  const scope = useFleetScope();
  const target = given ?? scopeTarget(scope, currentMapId);
  const targetKey = target ? JSON.stringify(target) : '';
  const [data, setData] = useState<ReporterCheckList | null>(null);
  const [poll, setPoll] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const p = setInterval(() => setPoll((t) => t + 1), POLL_MS);
    return () => clearInterval(p);
  }, []);
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    api.fetchReporterChecks(target).then((r) => !cancelled && setData(r), () => !cancelled && setData(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetKey is `target` by value
  }, [targetKey, asksRev, poll]);
  useEffect(() => {
    setData(null);
    setNote(null);
  }, [targetKey]);

  const items = data?.items ?? [];
  if (items.length === 0 && !note) return null;
  const readOnly = viewRole === 'stakeholder';
  const refresh = () => setPoll((t) => t + 1);

  // One "Deployed" button per project with merged work waiting.
  const waitingByMap = new Map<string, ReporterCheck[]>();
  for (const c of items) if (c.state === 'waiting-deploy') waitingByMap.set(c.mapId, [...(waitingByMap.get(c.mapId) ?? []), c]);
  const others = items.filter((c) => c.state !== 'waiting-deploy');

  const title = `Waiting for the reporter — outside tickets close when the reporter has checked the fix (${items.length})`;
  const body = (
    <div data-testid="reporter-checks">
      {[...waitingByMap.entries()].map(([mapId, rows]) => (
        <DeployRow key={mapId} rows={rows} project={projectLabel(scope, mapId)} readOnly={readOnly || !rows[0].canDecide} onDone={(line) => (setNote(line), refresh())} />
      ))}
      {others.map((c) => (
        <CheckRow key={c.nodeId} check={c} project={projectLabel(scope, c.mapId)} readOnly={readOnly || !c.canDecide} mobile={mobile} onDone={(line) => (setNote(line), refresh())} />
      ))}
      {note && <div style={{ fontSize: 13, color: '#166534', padding: '6px 0' }}>{note}</div>}
    </div>
  );
  if (mobile) {
    return (
      <div className="mb-card">
        <div className="mb-card-title">{title}</div>
        {body}
      </div>
    );
  }
  return (
    <div style={{ marginBottom: 16 }}>
      <Card title={title} accent="#93c5fd">
        {body}
      </Card>
    </div>
  );
}

/** Merged, not live: the deploy signal asks every reporter of the project at once. */
function DeployRow({ rows, project, readOnly, onDone }: { rows: ReporterCheck[]; project: string | null; readOnly: boolean; onDone: (line: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function deployed() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.markDeployed(rows[0].mapId);
      const failed = res.failed.map((f) => `${f.issue}: ${f.error}`).join('; ');
      if (failed) setError(`Not asked: ${failed}`);
      const waiting = res.notLanded.length ? ` — not merged yet, still waiting: ${res.notLanded.map((n) => n.issue).join(', ')}` : '';
      if (res.asked.length > 0 || waiting) onDone(`${res.asked.length > 0 ? '✓' : '⚠'} Asked ${res.asked.length} reporter(s) to check the fix${waiting}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ borderTop: '1px solid #f1f5f9', padding: '10px 0' }} data-testid="reporter-check-deploy">
      <div style={{ fontSize: 14, color: '#0f172a' }}>
        {project && <span style={projectTag}>{project}</span>}
        <b>Merged, not live yet ({rows.length})</b>
      </div>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13, color: '#334155' }}>
        {rows.map((c) => (
          <li key={c.nodeId}>
            {c.title}{' '}
            <a href={c.issue.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#4f46e5' }}>
              {c.issue.ref}
            </a>{' '}
            <span style={{ fontSize: 12, color: '#64748b' }}>· {c.reporter}</span>
          </li>
        ))}
      </ul>
      {!readOnly && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <button disabled={busy} onClick={deployed} style={btn('primary', busy)} data-testid="mark-deployed">
            Deployed — ask the reporters
          </button>
          <span style={{ fontSize: 12, color: '#64748b' }}>Reopens each issue and asks the reporter to check the fix.</span>
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>{error}</div>}
    </div>
  );
}

function CheckRow({ check: c, project, readOnly, mobile, onDone }: { check: ReporterCheck; project: string | null; readOnly: boolean; mobile: boolean; onDone: (line: string) => void }) {
  const [mode, setMode] = useState<'idle' | 'reopen'>('idle');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<api.CheckResponse>, line: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await action();
      const failed = res.writes.filter((w) => !w.done);
      onDone(failed.length ? `⚠ ${line} — ${failed.map((w) => `${w.kind} failed: ${w.error}`).join('; ')}` : `✓ ${line}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }
  const status =
    c.state === 'replied'
      ? `${c.reporter} replied on ${new Date(c.reply!.at).toLocaleDateString()}`
      : `asked ${c.askedAt ? new Date(c.askedAt).toLocaleDateString() : ''}${c.remindedAt ? ', reminded' : ''}${c.closesAt ? ` · closes ${new Date(c.closesAt).toLocaleDateString()} without an answer` : ''}`;

  return (
    <div style={{ borderTop: '1px solid #f1f5f9', padding: '10px 0' }} data-testid="reporter-check-row">
      <div style={{ fontSize: 14, color: '#0f172a' }}>
        {project && <span style={projectTag}>{project}</span>}
        <b>{c.title}</b>
        <a href={c.issue.url} target="_blank" rel="noreferrer" style={{ marginLeft: 6, fontSize: 12, color: '#4f46e5' }}>
          {c.issue.ref}
        </a>
      </div>
      <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{status}</div>
      {c.reply && (
        <blockquote
          style={{ margin: '6px 0 0', padding: '4px 8px', borderLeft: '3px solid #cbd5e1', background: '#f8fafc', fontSize: 13, color: '#334155', whiteSpace: 'pre-wrap' }}
          data-testid="reporter-reply"
        >
          {c.reply.excerpt}{' '}
          <a href={c.reply.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#4f46e5' }}>
            full reply
          </a>
        </blockquote>
      )}
      {!readOnly && mode === 'reopen' && (
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={mobile ? 4 : 3}
          style={field}
          aria-label="What is still wrong"
          placeholder="What is still wrong — in your words; this becomes the ticket's brief for the fleet"
        />
      )}
      {!readOnly && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {mode === 'idle' && (
            <>
              {c.state === 'replied' && (
                <button disabled={busy} onClick={() => setMode('reopen')} style={btn('primary', busy)} data-testid="reopen-after-check">
                  Reopen…
                </button>
              )}
              <button
                disabled={busy}
                onClick={() => run(() => api.closeAfterCheck(c.mapId, c.nodeId), `Closed ${c.issue.ref}`)}
                style={btn('plain', busy)}
                data-testid="close-after-check"
              >
                {c.state === 'replied' ? 'Close the issue' : 'Close now — I checked it'}
              </button>
            </>
          )}
          {mode === 'reopen' && (
            <>
              <button
                disabled={busy || !brief.trim()}
                onClick={() => run(() => api.reopenAfterCheck(c.mapId, c.nodeId, brief.trim()), `Reopened: ${c.title}`)}
                style={btn('primary', busy)}
                data-testid="confirm-reopen"
              >
                Reopen the ticket
              </button>
              <button disabled={busy} onClick={() => setMode('idle')} style={btn('plain', busy)}>
                Cancel
              </button>
            </>
          )}
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>{error}</div>}
    </div>
  );
}

const field: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  marginTop: 6,
  fontSize: 13,
  padding: 6,
  border: '1px solid #cbd5e1',
  borderRadius: 6,
  fontFamily: 'inherit',
};

const btn = (kind: 'primary' | 'plain', disabled: boolean): React.CSSProperties => ({
  fontSize: 13,
  padding: '6px 12px',
  borderRadius: 6,
  border: `1px solid ${kind === 'primary' ? '#2563eb' : '#cbd5e1'}`,
  background: kind === 'primary' ? '#2563eb' : '#fff',
  color: kind === 'primary' ? '#fff' : '#334155',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
});
