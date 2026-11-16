/**
 * Approvals (#494) — proposed tickets the fleet will not run until a
 * trusted person decides: Approve (stop at the PR, or full auto), Edit &
 * approve, Approve & ask (work starts, the AI's open questions go on the
 * issue), Ask the reporter, Reject with a note for the forge issue.
 *
 * MindBlown's own rows, read from the nodes' approval stamps (#492) —
 * not fleet-collected asks, so nothing here goes through the asks push.
 * Each row says whether the reader may decide (the map's trusted list,
 * never a fleet key); everyone else sees it read-only.
 *
 * They have their own page (`/?approvals`): every map the reader can see,
 * grouped by project — a gate to clear, not a question to answer, so it
 * no longer shares the Fleet tab with Questions. The Fleet tab keeps a
 * one-line pointer, the header a count, and pushes / digest mails land
 * on the page. The ticket's detail view (#610) still renders its own row.
 */
import React, { useEffect, useState } from 'react';
import type { ApprovalReview, PendingApproval, PendingApprovalList } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { FleetTarget } from './api.js';
import { Card, Shell, Muted } from './DigestView.js';
import { scopeTarget, useFleetScope } from './fleetScope.js';
import { projectTag } from './FleetTelemetry.js';

const POLL_MS = 60_000;

/** The Approvals page. A plain link: it is its own page, outside any map. */
export const APPROVALS_HREF = '/?approvals';

export function isApprovalsPage(search: string): boolean {
  return new URLSearchParams(search).has('approvals');
}

const LEVEL_LABEL: Record<PendingApproval['trustLevel'], string> = {
  trusted: 'trusted',
  known: 'map member',
  external: 'outside',
};

/** `/api/approvals` (null = every map) or one target, refetched every minute and on `asks:updated`. */
function useApprovalList(target: FleetTarget | null): { data: PendingApprovalList | null; error: string | null; refetch: () => void } {
  const asksRev = useMindmapStore((s) => s.asksRev);
  const key = target ? JSON.stringify(target) : 'all';
  const [data, setData] = useState<PendingApprovalList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [poll, setPoll] = useState(0);
  useEffect(() => {
    const p = setInterval(() => setPoll((t) => t + 1), POLL_MS);
    return () => clearInterval(p);
  }, []);
  useEffect(() => {
    let cancelled = false;
    (target ? api.fetchApprovals(target) : api.fetchAllApprovals()).then(
      (r) => {
        if (cancelled) return;
        setData(r);
        setError(null);
      },
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : 'unavailable'),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key is `target` by value
  }, [key, asksRev, poll]);
  return { data, error, refetch: () => setPoll((t) => t + 1) };
}

/** Rows grouped by project, projects by name. */
export function groupApprovals(items: PendingApproval[]): { mapId: string; mapName: string; rows: PendingApproval[] }[] {
  const byMap = new Map<string, { mapId: string; mapName: string; rows: PendingApproval[] }>();
  for (const r of items) {
    const g = byMap.get(r.mapId) ?? { mapId: r.mapId, mapName: r.mapName, rows: [] };
    g.rows.push(r);
    byMap.set(r.mapId, g);
  }
  return [...byMap.values()].sort((a, b) => a.mapName.localeCompare(b.mapName));
}

/**
 * The Approvals page (`/?approvals`): everything waiting on every map the
 * reader can view, one card per project. Desktop and phone.
 */
export function ApprovalsPage({ mobile = false }: { mobile?: boolean }) {
  const { data, error, refetch } = useApprovalList(null);
  // Decided rows leave at once — the refetch must not bring back a clickable copy —
  // and what was written stays on screen under the project until a reload.
  const [done, setDone] = useState<Record<string, { mapId: string; line: string }>>({});
  const rows = (data?.items ?? []).filter((r) => !(r.nodeId in done));
  const groups = groupApprovals(rows);
  // A project whose last row was just decided keeps its card, to show what happened.
  for (const [, d] of Object.entries(done)) {
    if (!groups.some((g) => g.mapId === d.mapId)) {
      const name = data?.items.find((r) => r.mapId === d.mapId)?.mapName ?? 'Project';
      groups.push({ mapId: d.mapId, mapName: name, rows: [] });
    }
  }
  const waiting = rows.filter((r) => r.canApprove).length;

  const status = error && !data ? (
    <Muted>Approvals unavailable: {error} — retrying every minute.</Muted>
  ) : !data ? (
    <Muted>Loading…</Muted>
  ) : groups.length === 0 ? (
    <Muted>Nothing is waiting for approval.</Muted>
  ) : null;

  const cards = groups.map((g) => {
    const decided = Object.entries(done).filter(([, d]) => d.mapId === g.mapId);
    const body = (
      <div data-testid="approval-group" data-map-id={g.mapId}>
        {g.rows.map((r) => (
          <ApprovalRow
            key={r.nodeId}
            row={r}
            project={null}
            readOnly={!r.canApprove}
            mobile={mobile}
            onDone={(line) => {
              setDone((d) => ({ ...d, [r.nodeId]: { mapId: r.mapId, line } }));
              refetch();
            }}
            onStale={refetch}
          />
        ))}
        {decided.map(([id, d]) => (
          <div key={id} style={{ fontSize: 13, color: '#166534', padding: '6px 0' }}>
            {d.line}
          </div>
        ))}
      </div>
    );
    const title = `${g.mapName} (${g.rows.length})`;
    const open = (
      <a href={`/?map=${encodeURIComponent(g.mapId)}&view=fleet`} style={{ fontSize: 12, color: '#4f46e5' }}>
        Open project →
      </a>
    );
    if (mobile) {
      return (
        <div className="mb-card" key={g.mapId}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div className="mb-card-title">{title}</div>
            {open}
          </div>
          {body}
        </div>
      );
    }
    return (
      <div key={g.mapId} style={{ marginBottom: 16 }}>
        <Card title={title} accent="#fcd34d">
          <div style={{ marginBottom: 8 }}>{open}</div>
          {body}
        </Card>
      </div>
    );
  });

  const intro = `Proposed tickets the fleet runs only after a yes${data ? ` — ${waiting} for you to decide` : ''}. Worker questions stay on each project's Fleet tab.`;

  if (mobile) {
    return (
      <div className="mb-mobile">
        <div className="mb-topbar">
          <a className="mb-topbar-btn" href="/" style={{ textDecoration: 'none' }}>
            ← Maps
          </a>
          <div className="mb-topbar-title">Approvals</div>
          <span style={{ width: 60 }} />
        </div>
        <div className="mb-body" data-testid="approvals-page">
          <div style={{ fontSize: 13, color: '#64748b', padding: '0 4px 8px' }}>{intro}</div>
          {status}
          {cards}
        </div>
      </div>
    );
  }
  return (
    <Shell>
      <div data-testid="approvals-page" id="approvals">
        <div style={{ marginBottom: 12, fontSize: 12 }}>
          <a href="/" style={{ color: '#4f46e5' }}>
            ← All maps
          </a>
        </div>
        <h1 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 700, color: '#1e293b' }}>Approvals</h1>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#64748b' }}>{intro}</p>
        {status}
        {cards}
      </div>
    </Shell>
  );
}

/**
 * Header count: tickets the reader may decide, on every map — a link to
 * the page. Nothing while none wait (or the server doesn't answer).
 */
export function ApprovalsBadge({ mobile = false }: { mobile?: boolean }) {
  const { data } = useApprovalList(null);
  const n = data?.items.filter((r) => r.canApprove).length ?? 0;
  if (n === 0) return null;
  const label = `${n} to approve`;
  return (
    <a
      href={APPROVALS_HREF}
      data-testid="approvals-badge"
      title="Proposed tickets waiting for your yes — open Approvals"
      style={{
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        textDecoration: 'none',
        color: '#92400e',
        background: '#fef3c7',
        border: '1px solid #fcd34d',
        borderRadius: 999,
        padding: mobile ? '2px 8px' : '3px 10px',
      }}
    >
      {label}
    </a>
  );
}

/**
 * The Fleet tab's pointer (desktop and phone): how many tickets of its
 * scope wait for approval, and the way to the page. Nothing while none do.
 */
export function ApprovalsLink({ target: given, mobile = false }: { target?: FleetTarget; mobile?: boolean }) {
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const scope = useFleetScope();
  const target = given ?? scopeTarget(scope, currentMapId);
  const { data } = useApprovalList(target);
  const n = data?.items.length ?? 0;
  if (!target || n === 0) return null;
  return (
    <div
      className={mobile ? 'mb-card' : undefined}
      data-testid="approvals-link"
      style={mobile ? { fontSize: 14 } : { marginBottom: 16, padding: '10px 14px', fontSize: 13, background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 12 }}
    >
      {n === 1 ? '1 proposed ticket waits' : `${n} proposed tickets wait`} for approval — the fleet runs them only after a yes.{' '}
      <a href={APPROVALS_HREF} style={{ color: '#4f46e5', fontWeight: 600 }}>
        Open Approvals →
      </a>
    </div>
  );
}

type Mode = 'idle' | 'edit' | 'reject' | 'ask' | 'approve-ask';

/** One waiting ticket with its Approve / Edit & approve / Reject — also the Kanban detail view's (#610). */
export function ApprovalRow({
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
  const [askText, setAskText] = useState('');
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
  const canAsk =
    !readOnly && !!r.issue && (r.review?.verdict === 'needs-info' || r.review?.verdict === 'open-questions') && r.review.questions.length > 0;
  const askedQuestions = () => askText.split('\n').map((q) => q.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim()).filter(Boolean);
  const openAsk = (next: 'ask' | 'approve-ask') => {
    setAskText(r.review!.questions.join('\n'));
    setMode(next);
  };
  // A decision: the work starts, the questions go on the issue. The stamp stands even if the post fails.
  const approveAndAsk = () =>
    run(
      () => api.approveTicket(r.mapId, r.nodeId, { merge, expectedRevision: r.revision, askQuestions: askedQuestions() }),
      (res) => {
        const failed = res.writes.filter((w) => !w.done);
        const how = merge === 'pr-only' ? 'the fleet stops at the PR' : 'full auto';
        return failed.length
          ? `⚠ Approved: ${r.title} — ${how}; the questions were NOT posted: ${failed.map((w) => w.error).join('; ')}`
          : `✓ Approved: ${r.title} — ${how}; questions posted on ${r.issue?.ref ?? 'the issue'}`;
      },
    );
  // Not a decision: the row stays, refetched to show "asked".
  async function ask() {
    setBusy(true);
    setError(null);
    try {
      const questions = askedQuestions();
      const res = await api.askReporter(r.mapId, r.nodeId, { questions, expectedRevision: r.revision });
      const failed = res.writes.filter((w) => !w.done);
      if (failed.length > 0) setError(`Not posted: ${failed.map((w) => w.error).join('; ')}`);
      else setMode('idle');
      onStale();
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
      {r.review && <ReviewNote review={r.review} />}
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
      {!readOnly && (mode === 'ask' || mode === 'approve-ask') && (
        <textarea
          value={askText}
          onChange={(e) => setAskText(e.target.value)}
          rows={4}
          style={field}
          aria-label="Questions for the reporter, one per line"
          placeholder="One question per line — posted as a comment on the issue"
        />
      )}
      {!readOnly && mode === 'approve-ask' && (
        <div style={{ fontSize: 12, color: '#475569', marginTop: 4 }}>
          The fleet starts now; the worker gets these questions as posted, picks a default for each and names it in the PR.
        </div>
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
          {mode !== 'reject' && mode !== 'ask' && (
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
              {canAsk && !r.review!.askedAt && (
                <button disabled={busy} onClick={() => openAsk('approve-ask')} style={btn('plain', busy)} data-testid="approve-ask">
                  Approve & ask
                </button>
              )}
              {canAsk && (
                <button disabled={busy} onClick={() => openAsk('ask')} style={btn('plain', busy)} data-testid="ask-reporter">
                  {r.review!.askedAt ? 'Ask again' : 'Ask the reporter'}
                </button>
              )}
              <button disabled={busy} onClick={() => setMode('reject')} style={btn('danger', busy)}>
                Reject
              </button>
            </>
          )}
          {mode === 'approve-ask' && (
            <>
              <button disabled={busy || askedQuestions().length === 0 || !canAsk} onClick={approveAndAsk} style={btn('primary', busy)} data-testid="confirm-approve-ask">
                Approve & post on {r.issue?.ref ?? 'the issue'}
              </button>
              <button disabled={busy} onClick={() => setMode('idle')} style={btn('plain', busy)}>
                Cancel
              </button>
            </>
          )}
          {mode === 'ask' && (
            <>
              <button disabled={busy || askedQuestions().length === 0 || !canAsk} onClick={ask} style={btn('primary', busy)} data-testid="confirm-ask">
                Post on {r.issue?.ref ?? 'the issue'}
              </button>
              <button disabled={busy} onClick={() => setMode('idle')} style={btn('plain', busy)}>
                Cancel
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

const VERDICT_STYLE: Record<ApprovalReview['verdict'], { label: string; color: string; background: string }> = {
  ready: { label: 'Looks ready', color: '#166534', background: '#f0fdf4' },
  'open-questions': { label: 'Ready to start — open questions', color: '#1e40af', background: '#eff6ff' },
  'needs-info': { label: 'Needs more information', color: '#92400e', background: '#fffbeb' },
  doubtful: { label: 'Doubtful', color: '#991b1b', background: '#fef2f2' },
};

/** The AI's read of the ticket (verdict, why, what to ask the reporter) — advice beside the text. */
function ReviewNote({ review }: { review: ApprovalReview }) {
  const s = VERDICT_STYLE[review.verdict];
  return (
    <div style={{ fontSize: 12, color: s.color, background: s.background, borderRadius: 4, padding: '4px 8px', marginTop: 6 }} data-testid="approval-review">
      <b>AI: {s.label}</b>
      {review.reason && <> — {review.reason}</>}
      {review.questions.length > 0 && (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {review.questions.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
      )}
      {review.askedAt && (
        <div style={{ marginTop: 4 }} data-testid="reporter-asked">
          Asked the reporter on {new Date(review.askedAt).toLocaleDateString()} — waiting for an answer on the issue.
        </div>
      )}
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
