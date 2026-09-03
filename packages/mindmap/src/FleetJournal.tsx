/**
 * Journal section of the Fleet tab — what the Leidang fleet did in a
 * window, read from `GET /fleet-journal`. The hand-written night report
 * (ticks, merged PRs with node + effort, issues closed, follow-ups)
 * automated: presets for last night (17:00 → 07:00), 24 h and 7 d, a
 * tick table, and the delivered / picked-up / blocked / follow-up lists.
 * Clicking a node selects it, so the node panel's Fleet trail shows who
 * held it and when.
 *
 * Fetches on demand only (window change, explicit refresh) — this is a
 * report, not live telemetry; the Fleet card above is the live view.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { journalWindow } from '@mindblown/core';
import type { FleetJournal, JournalPreset, JournalTick, JournalWorker } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import { Card, Link } from './DigestView.js';

const PRESETS: { id: JournalPreset; label: string; hint: string }[] = [
  { id: 'last-night', label: 'Last night', hint: 'Yesterday 17:00 → today 07:00 (local); before 07:00 the window ends now' },
  { id: '24h', label: '24 h', hint: 'Trailing 24 hours' },
  { id: '7d', label: '7 d', hint: 'Trailing 7 days' },
];

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function dayLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: '2-digit' });
}
function dayKey(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function workerLabel(w: JournalWorker | null): string {
  if (!w) return 'unknown worker';
  return w.host && w.worker ? `${w.worker}@${w.host}` : w.session;
}
function fmtVal(v: unknown): string {
  if (v == null) return '∅';
  if (Array.isArray(v)) return v.length ? v.join(' › ') : '[]';
  return typeof v === 'string' ? v : JSON.stringify(v);
}
const sevColor = (s: string) => (s === 'critical' ? '#991b1b' : s === 'warn' || s === 'warning' ? '#b45309' : '#64748b');

export function FleetJournalSection() {
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const nodes = useMindmapStore((s) => s.nodes);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const [preset, setPreset] = useState<JournalPreset>('last-night');
  const [journal, setJournal] = useState<FleetJournal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState<Record<string, boolean>>({ ticks: false, delivered: true, created: false, claims: false });

  // Window resolved at fetch time, so "last night" is right at 03:40 (still
  // running → ends now) and at 09:00 (ended 07:00) without a ticker.
  useEffect(() => {
    if (!currentMapId) return;
    let cancelled = false;
    const w = journalWindow(preset);
    setLoading(true);
    api
      .fetchFleetJournal(currentMapId, { from: w.from.toISOString(), to: w.to.toISOString() })
      .then((r) => {
        if (cancelled) return;
        setJournal(r.journal);
        setError(null);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : 'unavailable'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [currentMapId, preset, reload]);

  const toggle = useCallback((k: string) => setOpen((o) => ({ ...o, [k]: !o[k] })), []);
  const nodeLink = useCallback(
    (id: string, text: string) => (nodes[id] ? <Link onClick={() => selectNode(id)}>{text}</Link> : <span>{text}</span>),
    [nodes, selectNode],
  );

  const t = journal?.totals;
  const closedIssues = useMemo(() => (journal ? journal.delivered.flatMap((d) => d.issues) : []), [journal]);

  return (
    <Card title="Journal — what the fleet did">
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            data-testid={`journal-preset-${p.id}`}
            style={{ ...btn, ...(preset === p.id ? btnActive : {}) }}
            title={p.hint}
            disabled={loading}
            onClick={() => setPreset(p.id)}
          >
            {p.label}
          </button>
        ))}
        <button style={btn} disabled={loading} onClick={() => setReload((n) => n + 1)} title="Read again">
          ↻
        </button>
        {journal && (
          <span style={{ fontSize: 12, color: '#64748b' }}>
            {dayLabel(journal.window.from)} {hhmm(journal.window.from)} → {dayLabel(journal.window.to)} {hhmm(journal.window.to)}
          </span>
        )}
        {loading && <span style={{ fontSize: 12, color: '#94a3b8' }}>loading…</span>}
      </div>

      {error && <div style={{ fontSize: 12, color: '#b45309' }}>Journal unavailable ({error}).</div>}
      {!journal && !error && !loading && <div style={{ fontSize: 12, color: '#94a3b8' }}>No journal loaded.</div>}

      {journal && t && (
        <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.6 }}>
          <div data-testid="journal-totals">
            <strong>{t.delivered}</strong> delivered ({t.prsMerged} with PR{t.actualEffortSum > 0 ? `, actual ${t.actualEffortSum}` : ''}) ·{' '}
            <strong>{t.created}</strong> follow-ups · <strong>{t.claims}</strong> picked up · {t.releases} handed back · {t.blocked} blocked ·{' '}
            {t.ticks} ticks{t.capMin !== null ? ` · cap ${t.capMin}${t.capMax !== null && t.capMax !== t.capMin ? `–${t.capMax}` : ''}` : ''}
            {t.claimsMax !== null ? ` · claims max ${t.claimsMax}` : ''} · {t.knobWrites} knob writes · {t.workers} workers
            {t.anomaliesWarn > 0 && <span style={{ color: '#b45309' }}> · {t.anomaliesWarn} warn+ anomalies</span>}
          </div>

          {/* Ticks */}
          <Section id="ticks" label={`Ticks (${journal.ticks.length})`} open={!!open.ticks} onToggle={toggle}>
            {journal.ticks.length === 0 ? (
              <Empty>No orchestrator tick in the window.</Empty>
            ) : (
              <TickTable ticks={journal.ticks} />
            )}
          </Section>

          {/* Delivered */}
          <Section id="delivered" label={`Delivered (${journal.delivered.length})`} open={!!open.delivered} onToggle={toggle}>
            {journal.delivered.length === 0 ? (
              <Empty>Nothing moved to done in the window.</Empty>
            ) : (
              <ul style={list} data-testid="journal-delivered">
                {journal.delivered.map((d) => (
                  <li key={d.nodeId}>
                    <span style={{ color: '#94a3b8' }}>{hhmm(d.completedAt)}</span>{' '}
                    {d.pr ? (
                      <a href={d.pr.url} target="_blank" rel="noreferrer" style={{ color: '#4f46e5', textDecoration: 'none', fontWeight: 600 }}>
                        PR #{d.pr.number}
                      </a>
                    ) : (
                      <span style={{ color: '#94a3b8' }}>no PR</span>
                    )}{' '}
                    {nodeLink(d.nodeId, d.text)}
                    <span style={{ color: '#64748b' }}>
                      {' '}— {workerLabel(d.deliveredBy)}
                      {d.actualEffort !== null ? ` · actual ${d.actualEffort}` : ''}
                      {d.versionName ? ` · ${d.versionName}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {closedIssues.length > 0 && (
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                Issues closed ({closedIssues.length}):{' '}
                {closedIssues.map((i, k) => (
                  <span key={i.externalId}>
                    {k > 0 && ', '}
                    <a href={i.url} target="_blank" rel="noreferrer" style={{ color: '#4f46e5', textDecoration: 'none' }}>
                      #{i.externalId.split('#')[1] ?? i.externalId}
                    </a>
                  </span>
                ))}
              </div>
            )}
          </Section>

          {/* Picked up / handed back / blocked */}
          <Section
            id="claims"
            label={`Picked up (${journal.claims.length}) · handed back (${journal.releases.length}) · blocked (${journal.blocked.length})`}
            open={!!open.claims}
            onToggle={toggle}
          >
            {journal.claims.length + journal.releases.length + journal.blocked.length === 0 ? (
              <Empty>No claim, release or block recorded in the window.</Empty>
            ) : (
              <ul style={list}>
                {journal.claims.map((c, i) => (
                  <li key={`c${i}`}>
                    <span style={{ color: '#94a3b8' }}>{hhmm(c.at)}</span> {workerLabel(c)} picked up {nodeLink(c.nodeId, c.text)}
                    <span style={{ color: '#94a3b8' }}> ({c.via})</span>
                  </li>
                ))}
                {journal.releases.map((r, i) => (
                  <li key={`r${i}`} style={{ color: '#9a3412' }}>
                    <span style={{ color: '#94a3b8' }}>{hhmm(r.at)}</span> {workerLabel(r)} handed back {nodeLink(r.nodeId, r.text)} — {r.reason}
                    {r.heldMinutes !== null ? ` after ${r.heldMinutes} min` : ''}
                    {r.note ? <span style={{ color: '#64748b' }}>: {r.note}</span> : null}
                  </li>
                ))}
                {journal.blocked.map((b, i) => (
                  <li key={`b${i}`} style={{ color: '#991b1b' }}>
                    <span style={{ color: '#94a3b8' }}>{hhmm(b.at)}</span> blocked {nodeLink(b.nodeId, b.text)}
                    {b.reason ? <span style={{ color: '#64748b' }}> — {b.reason}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Follow-ups */}
          <Section id="created" label={`Follow-ups created (${journal.created.length})`} open={!!open.created} onToggle={toggle}>
            {journal.created.length === 0 ? (
              <Empty>No node created in the window.</Empty>
            ) : (
              <>
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  by version: {tally(t.createdByVersion)} · by priority: {tally(t.createdByPriority)}
                </div>
                <ul style={list}>
                  {journal.created.map((c) => (
                    <li key={c.nodeId}>
                      <span style={{ color: '#94a3b8' }}>{hhmm(c.createdAt)}</span> {nodeLink(c.nodeId, c.text)}
                      <span style={{ color: '#64748b' }}>
                        {[c.priority, c.effortEstimate !== null ? `est ${c.effortEstimate}` : null, c.versionName].filter(Boolean).length > 0 &&
                          ` [${[c.priority, c.effortEstimate !== null ? `est ${c.effortEstimate}` : null, c.versionName].filter(Boolean).join(' · ')}]`}
                        {c.createdBy ? ` — ${c.createdBy}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Section>

          {/* Knob writes */}
          {journal.knobWrites.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 12, color: '#64748b' }} data-testid="journal-knobs">
              <div style={{ fontWeight: 700, color: '#334155' }}>Knob writes ({journal.knobWrites.length})</div>
              <ul style={list}>
                {journal.knobWrites.map((k, i) => (
                  <li key={i}>
                    <span style={{ color: '#94a3b8' }}>{hhmm(k.at)}</span> {k.field}: {fmtVal(k.oldValue)} → <strong>{fmtVal(k.newValue)}</strong>
                    {k.userName ? ` — ${k.userName}` : k.userId ? ` — ${k.userId.slice(0, 8)}` : ' — fleet'}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function tally(m: Record<string, number>): string {
  const e = Object.entries(m).sort((a, b) => b[1] - a[1]);
  return e.length ? e.map(([k, n]) => `${k} ${n}`).join(', ') : '—';
}

function Section({ id, label, open, onToggle, children }: { id: string; label: string; open: boolean; onToggle: (id: string) => void; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 6 }} data-testid={`journal-section-${id}`}>
      <Link onClick={() => onToggle(id)}>
        <span style={{ color: '#94a3b8', fontSize: 10 }}>{open ? '▾' : '▸'}</span> <strong>{label}</strong>
      </Link>
      {open && <div style={{ marginTop: 2 }}>{children}</div>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: '#94a3b8' }}>{children}</div>;
}

function TickTable({ ticks }: { ticks: JournalTick[] }) {
  let day = '';
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }} data-testid="journal-ticks">
        <thead>
          <tr style={{ color: '#64748b', textAlign: 'left' }}>
            <th style={th}>Time</th>
            <th style={th}>Claims/cap</th>
            <th style={th}>In gate</th>
            <th style={th}>Brief</th>
            <th style={th}>Writes · anomalies</th>
          </tr>
        </thead>
        <tbody>
          {ticks.map((t) => {
            const k = dayKey(t.receivedAt);
            const showDay = k !== day;
            day = k;
            return (
              <tr key={t.receivedAt} style={{ borderTop: '1px solid #f1f5f9' }}>
                <td style={td}>
                  {showDay && <span style={{ color: '#94a3b8' }}>{dayLabel(t.receivedAt)} </span>}
                  {hhmm(t.receivedAt)}
                </td>
                <td style={td}>
                  {t.claims ?? '?'}/{t.cap ?? '?'}
                </td>
                <td style={td}>{t.pullableInGate ?? '—'}</td>
                <td style={td}>{t.needsBrief ?? '—'}</td>
                <td style={td}>
                  {t.capWrite && (
                    <span style={{ ...pill, background: '#e0e7ff', color: '#3730a3' }} title={t.capWrite.reason ?? undefined}>
                      cap → {t.capWrite.set}
                    </span>
                  )}{' '}
                  {t.policyWrite && (
                    <span style={{ ...pill, background: '#e0e7ff', color: '#3730a3' }} title={t.policyWrite.reason ?? undefined}>
                      policy → {t.policyWrite.set.join(' › ')}
                    </span>
                  )}{' '}
                  {t.gateRecommendation && (
                    <span style={{ ...pill, background: '#fef3c7', color: '#92400e' }} title={t.gateRecommendation.reason ?? undefined}>
                      gate? {t.gateRecommendation.set.join(' + ')}
                    </span>
                  )}{' '}
                  {t.noJudgment && <span style={{ ...pill, background: '#ffedd5', color: '#9a3412' }}>no judgment</span>}{' '}
                  {t.anomalies.map((a, i) => (
                    <span key={i} style={{ color: sevColor(a.severity) }} title={a.what}>
                      {i > 0 && ' · '}
                      <strong>{a.severity}</strong> {a.what.length > 80 ? `${a.what.slice(0, 80)}…` : a.what}
                    </span>
                  ))}
                  {t.asksCount > 0 && <span style={{ color: '#1e40af' }}> · {t.asksCount} ask{t.asksCount === 1 ? '' : 's'}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const list: React.CSSProperties = { margin: '2px 0 4px', paddingLeft: 18, fontSize: 12, lineHeight: 1.7 };
const th: React.CSSProperties = { padding: '2px 8px 2px 0', fontWeight: 600 };
const td: React.CSSProperties = { padding: '2px 8px 2px 0', verticalAlign: 'top' };
const pill: React.CSSProperties = { display: 'inline-block', padding: '0 7px', borderRadius: 999, fontSize: 11, fontWeight: 600 };
const btn: React.CSSProperties = { fontSize: 12, padding: '3px 10px', border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', color: '#334155', cursor: 'pointer', fontFamily: 'inherit' };
const btnActive: React.CSSProperties = { background: '#4f46e5', border: '1px solid #4f46e5', color: '#fff' };
