/**
 * Waiting for approval (#494) — proposed tickets the fleet will not run
 * until a trusted person decides: Approve (stop at the PR, or full auto),
 * Edit & approve, Reject with a note for the forge issue.
 *
 * MindBlown's own rows, read from the nodes' approval stamps (#492) —
 * not fleet-collected asks, so nothing here goes through the asks push.
 * Each row says whether the reader may decide (the map's trusted list,
 * never a fleet key); everyone else sees the list read-only.
 *
 * Desktop renders it as a Fleet-tab card above Questions; the phone
 * renders the same rows as a mobile card, because approving mostly
 * happens there after a push (#493).
 */
import React, { useEffect, useState } from 'react';
import type { PendingApproval, PendingApprovalList } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { FleetTarget } from './api.js';
import { Card } from './DigestView.js';
import { projectLabel, scopeTarget, useFleetScope } from './fleetScope.js';
import { projectTag } from './FleetTelemetry.js';

const POLL_MS = 60_000;

const LEVEL_LABEL: Record<PendingApproval['trustLevel'], string> = {
  trusted: 'trusted',
  known: 'map member',
  external: 'outside',
};

/**
 * `target` = what to list; without it, the Fleet tab's scope (this
 * project or the whole fleet). Renders nothing while nothing waits.
 */
export function ApprovalsSection({ target: given, mobile = false }: { target?: FleetTarget; mobile?: boolean }) {
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const asksRev = useMindmapStore((s) => s.asksRev);
  const viewRole = useMindmapStore((s) => s.viewRole);
  const scope = useFleetScope();
  const target = given ?? scopeTarget(scope, currentMapId);
  const targetKey = target ? JSON.stringify(target) : '';
  const [data, setData] = useState<PendingApprovalList | null>(null);
  const [poll, setPoll] = useState(0);
  // Decided rows stay on screen with what was written until the next scope change.
  const [done, setDone] = useState<Record<string, string>>({});

  useEffect(() => {
    const p = setInterval(() => setPoll((t) => t + 1), POLL_MS);
    return () => clearInterval(p);
  }, []);
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    // An older server or no access: no section, the rest of the page is unaffected.
    api.fetchApprovals(target).then((r) => !cancelled && setData(r), () => !cancelled && setData(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetKey is `target` by value
  }, [targetKey, asksRev, poll]);
  // A different scope is a different list: the old rows don't stay up under it.
  useEffect(() => {
    setDone({});
    setData(null);
  }, [targetKey]);

  // A decided row leaves at once — the refetch must not bring back a clickable copy.
  const rows = (data?.items ?? []).filter((r) => !(r.nodeId in done));
  const decided = Object.entries(done);
  if (rows.length === 0 && decided.length === 0) return null;

  // The stakeholder lens reads; the server still decides who may click.
  const readOnly = viewRole === 'stakeholder';
  const title = `Waiting for approval — the fleet runs these only after a yes (${rows.length})`;
  const body = (
    <div data-testid="approvals" id="approvals">
      {rows.map((r) => (
        <ApprovalRow
          key={r.nodeId}
          row={r}
          project={projectLabel(scope, r.mapId)}
          readOnly={readOnly || !r.canApprove}
          mobile={mobile}
          onDone={(line) => {
            setDone((d) => ({ ...d, [r.nodeId]: line }));
            setPoll((t) => t + 1);
          }}
          onStale={() => setPoll((t) => t + 1)}
        />
      ))}
      {decided.map(([id, line]) => (
        <div key={id} style={{ fontSize: 13, color: '#166534', padding: '6px 0' }}>
          {line}
        </div>
      ))}
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
      <Card title={title} accent="#fcd34d">
        {body}
      </Card>
    </div>
  );
}

type Mode = 'idle' | 'edit' | 'reject';

function ApprovalRow({
  row: r,
  project,
  readOnly,
  mobile,
  onDone,
  onStale,
}: {
  row: PendingApproval;
  project: string | null;
  readOnly: boolean;
  mobile: boolean;
  onDone: (line: string) => void;
  /** The ticket changed since it was read: refetch, the person reads again. */
  onStale: () => void;
}) {
  const [stopAtPr, setStopAtPr] = useState(r.approval.merge === 'pr-only');
  const [mode, setMode] = useState<Mode>('idle');
  const [text, setText] = useState(r.description);
  // A refetch with newer text: the edit box starts from it next time.
  useEffect(() => {
    if (mode !== 'edit') setText(r.description);
  }, [r.description, mode]);
  const [note, setNote] = useState('');
  const [closeIssue, setCloseIssue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const merge = stopAtPr ? 'pr-only' : 'auto';

  async function run(action: () => Promise<api.ApprovalResponse>, line: (res: api.ApprovalResponse) => string) {
    setBusy(true);
    setError(null);
    try {
      const res = await action();
      onDone(line(res));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
      if (e instanceof api.ApiError && e.status === 409) {
        setMode('idle');
        onStale();
      }
    } finally {
      setBusy(false);
    }
  }
  const approve = (description?: string) =>
    run(
      () => api.approveTicket(r.mapId, r.nodeId, { merge, description, expectedRevision: r.revision }),
      () => `✓ Approved: ${r.title} — ${merge === 'pr-only' ? 'the fleet stops at the PR' : 'full auto'}`,
    );
  const reject = () =>
    run(
      () => api.rejectTicket(r.mapId, r.nodeId, { note: note.trim() || undefined, closeIssue }),
      (res) => {
        const failed = res.writes.filter((w) => !w.done);
        return `✗ Rejected: ${r.title}${failed.length ? ` — ${failed.map((w) => `${w.kind} failed: ${w.error}`).join('; ')}` : ''}`;
      },
    );

  return (
    <div style={{ borderTop: '1px solid #f1f5f9', padding: '10px 0' }} data-testid="approval-row">
      <div style={{ fontSize: 14, color: '#0f172a' }}>
        {project && <span style={projectTag}>{project}</span>}
        <b>{r.title}</b>
        {r.issue && (
          <a href={r.issue.url} target="_blank" rel="noreferrer" style={{ marginLeft: 6, fontSize: 12, color: '#4f46e5' }}>
            {r.issue.ref}
          </a>
        )}
      </div>
      <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
        from {r.reporterLabel} · {LEVEL_LABEL[r.trustLevel]} · {new Date(r.createdAt).toLocaleDateString()}
      </div>
      {r.hints.length > 0 && (
        <div style={{ fontSize: 12, color: '#92400e', background: '#fffbeb', borderRadius: 4, padding: '4px 8px', marginTop: 6 }} data-testid="approval-hints">
          Read twice: {r.hints.join('; ')}. A hint, not a verdict.
        </div>
      )}
      {r.description && mode !== 'edit' && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 12, color: '#475569', cursor: 'pointer' }}>Original text</summary>
          <div style={{ fontSize: 13, color: '#334155', whiteSpace: 'pre-wrap', marginTop: 4 }}>{r.description}</div>
        </details>
      )}

      {!readOnly && mode === 'edit' && (
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={mobile ? 6 : 8} style={field} aria-label="Description" />
      )}
      {!readOnly && mode === 'reject' && (
        <div style={{ marginTop: 6 }}>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            style={field}
            placeholder={r.issue ? `Why — posted on ${r.issue.ref} (optional)` : 'Why — kept in the change log (optional)'}
            aria-label="Reject note"
          />
          {r.issue && (
            <label style={{ fontSize: 12, color: '#475569', display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={closeIssue} onChange={(e) => setCloseIssue(e.target.checked)} /> Close the issue
            </label>
          )}
        </div>
      )}

      {!readOnly && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          {mode !== 'reject' && (
            <label style={{ fontSize: 12, color: '#475569', display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={stopAtPr} onChange={(e) => setStopAtPr(e.target.checked)} /> Stop at PR
            </label>
          )}
          {mode === 'idle' && (
            <>
              <button disabled={busy} onClick={() => approve()} style={btn('primary', busy)} data-testid="approve">
                Approve
              </button>
              <button disabled={busy} onClick={() => setMode('edit')} style={btn('plain', busy)}>
                Edit & approve
              </button>
              <button disabled={busy} onClick={() => setMode('reject')} style={btn('danger', busy)}>
                Reject
              </button>
            </>
          )}
          {mode === 'edit' && (
            <>
              <button disabled={busy} onClick={() => approve(text)} style={btn('primary', busy)}>
                Save & approve
              </button>
              <button disabled={busy} onClick={() => setMode('idle')} style={btn('plain', busy)}>
                Cancel
              </button>
            </>
          )}
          {mode === 'reject' && (
            <>
              <button disabled={busy} onClick={reject} style={btn('danger', busy)} data-testid="confirm-reject">
                Reject
              </button>
              <button disabled={busy} onClick={() => setMode('idle')} style={btn('plain', busy)}>
                Cancel
              </button>
            </>
          )}
        </div>
      )}
      {readOnly && !r.canApprove && (
        <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>Only people on the map's trusted list can decide.</div>
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

const btn = (kind: 'primary' | 'plain' | 'danger', disabled: boolean): React.CSSProperties => ({
  fontSize: 13,
  padding: '6px 12px',
  borderRadius: 6,
  border: `1px solid ${kind === 'primary' ? '#2563eb' : kind === 'danger' ? '#fca5a5' : '#cbd5e1'}`,
  background: kind === 'primary' ? '#2563eb' : kind === 'danger' ? '#fef2f2' : '#fff',
  color: kind === 'primary' ? '#fff' : kind === 'danger' ? '#991b1b' : '#334155',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
});
