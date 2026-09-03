/**
 * Fragen tab — `/leidang-asks` in the browser.
 *
 * The list is what the orchestrator last pushed from claude-fleet's
 * collector (one record per ticket, deduplicated over tick / rollups /
 * pending-notes / GitHub). Nothing here is derived from the map's own
 * blocked nodes: the collector is the truth, this is the inbox. Answering
 * writes exactly what `leidang-asks-apply` writes (server side): the
 * «Entscheid (Dan, Datum): …» comment on the ticket, the decision at the
 * top of the node, blocked → todo. «Später» and «an Rita/Susi/Dana» only
 * record. No answer is written without a click.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ASK_ANSWERERS, isNoQuestion, isVersionOnly, planAskWrites, proseMirrorToPlainText, sortAsks } from '@mindblown/core';
import type { Ask, AskAnswerInput, AskRow, AskWritePlan, Node } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { AsksResponse } from './api.js';
import { Shell, Muted } from './DigestView.js';

const POLL_MS = 60_000;

const HINT_LABEL: Record<string, string> = {
  decision: 'Entscheid',
  'ops-task': 'Ops-Aufgabe',
  'waiting-external': 'wartet extern',
  'already-decided': 'schon entschieden',
  'parked-plan': 'geparkter Plan',
};

const STATUS_LABEL: Record<string, string> = {
  answered: 'beantwortet',
  later: 'später',
  delegated: 'delegiert',
};

function ref(a: Ask): string {
  return a.ticket != null ? `#${a.ticket}` : (a.requirement ?? a.id);
}

function title(a: Ask): string {
  const t = (a.title ?? '').trim();
  const r = ref(a);
  // The ref is shown in front of the title; don't print it twice.
  return t.startsWith(r + ' ') ? t.slice(r.length + 1) : t;
}

type AnswerResult = { ok: boolean; lines: string[] };

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

type Filter = { answerer: string | null; hint: string | null };

export function AsksView() {
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const asksRev = useMindmapStore((s) => s.asksRev);
  const viewRole = useMindmapStore((s) => s.viewRole);
  const user = useMindmapStore((s) => s.user);
  const [data, setData] = useState<AsksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [poll, setPoll] = useState(0);
  const [filter, setFilter] = useState<Filter>({ answerer: null, hint: null });
  const [showDone, setShowDone] = useState(false);
  const [showNoQuestion, setShowNoQuestion] = useState(false);
  const [showVersionOnly, setShowVersionOnly] = useState(false);
  // What each click wrote, kept per ask id: the refetch after asks:updated
  // moves an answered row out of the open set, but the report of what was
  // written (and what failed) must stay on screen where Dan clicked.
  const [results, setResults] = useState<Record<string, AnswerResult>>({});
  // Questions that were open on screen and are missing from the next push:
  // resolved elsewhere (terminal round, ticket closed, node unparked by hand).
  // Kept as a stub until dismissed, so a card never vanishes under a click
  // without a word (#5819, 2026-09-03).
  const [gone, setGone] = useState<Record<string, { ask: Ask; at: string }>>({});
  const lastOpen = useRef<Map<string, Ask> | null>(null);

  useEffect(() => {
    const p = setInterval(() => setPoll((t) => t + 1), POLL_MS);
    return () => clearInterval(p);
  }, []);

  useEffect(() => {
    if (!currentMapId) return;
    let cancelled = false;
    api
      .fetchAsks(currentMapId, { status: 'all' })
      .then((r) => {
        if (cancelled) return;
        const now = new Map(r.items.map((x) => [x.ask.id, x.ask] as const));
        const prev = lastOpen.current;
        if (prev && prev.size > 0) {
          const missing = [...prev].filter(([id]) => !now.has(id));
          if (missing.length > 0) {
            const at = r.pushedAt ?? r.now;
            setGone((g) => ({ ...g, ...Object.fromEntries(missing.map(([id, ask]) => [id, { ask, at }])) }));
          }
        }
        lastOpen.current = new Map(r.items.filter((x) => x.status === 'open').map((x) => [x.ask.id, x.ask] as const));
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : 'unavailable'));
    return () => {
      cancelled = true;
    };
  }, [currentMapId, asksRev, poll]);

  // Only the stakeholder lens is read-only; PM, developer and All answer.
  const readOnly = viewRole === 'stakeholder';
  // First name only — «Entscheid (Dan, …)» is what the terminal round writes
  // and what the collector recognises as an already-taken decision. Dan's
  // account says «Daniel»; he asked for «Dan» (2026-09-03), same as the skill.
  const BY_ALIAS: Record<string, string> = { Daniel: 'Dan' };
  const firstName = user?.name?.trim().split(/\s+/)[0] || 'Dan';
  const by = BY_ALIAS[firstName] ?? firstName;

  const groups = useMemo(() => {
    const rows = sortAsks(data?.items ?? []);
    const open = rows.filter((r) => r.status === 'open' || results[r.ask.id]);
    const done = rows.filter((r) => r.status !== 'open' && !results[r.ask.id]);
    const questions = open.filter((r) => !isNoQuestion(r.ask) && !isVersionOnly(r.ask));
    const noQuestion = open.filter((r) => isNoQuestion(r.ask));
    const versionOnly = open.filter((r) => isVersionOnly(r.ask) && !isNoQuestion(r.ask));
    const byAnswerer: Record<string, number> = {};
    const byHint: Record<string, number> = {};
    for (const r of questions) {
      byAnswerer[r.ask.answerer] = (byAnswerer[r.ask.answerer] ?? 0) + 1;
      byHint[r.ask.hint] = (byHint[r.ask.hint] ?? 0) + 1;
    }
    const visible = questions.filter(
      (r) => (!filter.answerer || r.ask.answerer === filter.answerer) && (!filter.hint || r.ask.hint === filter.hint),
    );
    return { questions, visible, noQuestion, versionOnly, done, byAnswerer, byHint };
  }, [data, filter, results]);

  const onResult = (id: string, r: AnswerResult) => setResults((m) => ({ ...m, [id]: r }));

  if (!currentMapId) return <Shell><Muted>Loading…</Muted></Shell>;
  if (error) return <Shell><Muted>Fragen nicht ladbar: {error}</Muted></Shell>;
  if (!data) return <Shell><Muted>Loading…</Muted></Shell>;

  if (!data.pushedAt) {
    return (
      <Shell>
        <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>Fragen</h2>
        <Muted>
          Noch keine Fragen gepusht. Der Orchestrator schickt die Liste jeden Tick (PUT /maps/:id/asks) — ist die Fleet aus, oder fehlt der Push?
        </Muted>
      </Shell>
    );
  }

  const answerers = (ASK_ANSWERERS as readonly string[]).filter((a) => groups.byAnswerer[a]);
  const hints = Object.keys(groups.byHint);

  return (
    <Shell>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>
          Fragen <span style={{ color: '#64748b', fontWeight: 400 }}>({groups.questions.length})</span>
        </h2>
        <Muted>
          Stand {fmtTime(data.pushedAt)}
          {data.meta?.tick ? ` · Tick ${data.meta.tick}` : ''}
          {readOnly ? ' · nur lesen (Rolle)' : ''}
        </Muted>
      </div>

      {/* counters double as filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '12px 0 4px' }}>
        <Chip active={filter.answerer === null} onClick={() => setFilter((f) => ({ ...f, answerer: null }))}>alle</Chip>
        {answerers.map((a) => (
          <Chip key={a} active={filter.answerer === a} onClick={() => setFilter((f) => ({ ...f, answerer: f.answerer === a ? null : a }))}>
            {a} {groups.byAnswerer[a]}
          </Chip>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '0 0 16px' }}>
        {hints.map((h) => (
          <Chip key={h} active={filter.hint === h} onClick={() => setFilter((f) => ({ ...f, hint: f.hint === h ? null : h }))} subtle>
            {HINT_LABEL[h] ?? h} {groups.byHint[h]}
          </Chip>
        ))}
      </div>

      {Object.entries(gone)
        .filter(([, g]) => (!filter.answerer || g.ask.answerer === filter.answerer) && (!filter.hint || g.ask.hint === filter.hint))
        .map(([id, g]) => (
          <GoneCard key={`gone-${id}`} ask={g.ask} at={g.at} onDismiss={() => setGone((m) => { const n = { ...m }; delete n[id]; return n; })} />
        ))}

      {groups.visible.length === 0 && <Muted>Keine offene Frage{filter.answerer || filter.hint ? ' in diesem Filter' : ''}. 🎉</Muted>}

      {groups.visible.map((r) => (
        <AskCard key={r.ask.id} row={r} mapId={currentMapId} by={by} readOnly={readOnly} result={results[r.ask.id] ?? null} onResult={onResult} />
      ))}

      {groups.versionOnly.length > 0 && (
        <Fold
          label={`Nur Version fehlt — NEEDS-VERSION (${groups.versionOnly.length}, Antwort = Milestone)`}
          open={showVersionOnly}
          onToggle={() => setShowVersionOnly((v) => !v)}
        >
          {groups.versionOnly.map((r) => (
            <AskCard key={r.ask.id} row={r} mapId={currentMapId} by={by} readOnly={readOnly} result={results[r.ask.id] ?? null} onResult={onResult} />
          ))}
        </Fold>
      )}

      {groups.noQuestion.length > 0 && (
        <Fold
          label={`Keine Frage — geparkte Planposten / Text ist schon der Entscheid (${groups.noQuestion.length})`}
          open={showNoQuestion}
          onToggle={() => setShowNoQuestion((v) => !v)}
        >
          {groups.noQuestion.map((r) => (
            <div key={r.ask.id} style={{ fontSize: 13, padding: '4px 0', color: '#475569' }}>
              <b>{ref(r.ask)}</b> [{HINT_LABEL[r.ask.hint] ?? r.ask.hint}] {title(r.ask)}
              {r.ask.idle_hours != null ? ` · idle ${r.ask.idle_hours}h` : ''}
            </div>
          ))}
        </Fold>
      )}

      {groups.done.length > 0 && (
        <Fold label={`Beantwortet / vertagt / delegiert (${groups.done.length})`} open={showDone} onToggle={() => setShowDone((v) => !v)}>
          {groups.done.map((r) => (
            <DoneRow key={r.ask.id} row={r} />
          ))}
        </Fold>
      )}
    </Shell>
  );
}

function Chip({ active, subtle, onClick, children }: { active: boolean; subtle?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 12,
        padding: '3px 10px',
        borderRadius: 999,
        border: `1px solid ${active ? '#2563eb' : '#e2e8f0'}`,
        background: active ? '#dbeafe' : subtle ? 'transparent' : '#fff',
        color: active ? '#1d4ed8' : '#475569',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function Fold({ label, open, onToggle, children }: { label: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 20 }}>
      <button
        onClick={onToggle}
        style={{ background: 'none', border: 'none', padding: 0, fontSize: 13, color: '#475569', cursor: 'pointer', fontWeight: 600 }}
      >
        {open ? '▾' : '▸'} {label}
      </button>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </section>
  );
}

function DoneRow({ row }: { row: AskRow }) {
  const a = row.ask;
  const failed = row.writes.filter((w) => w.error);
  return (
    <div style={{ fontSize: 13, padding: '6px 0', borderBottom: '1px solid #f1f5f9', color: '#475569' }}>
      <b>{ref(a)}</b> {title(a)} · {STATUS_LABEL[row.status] ?? row.status}
      {row.answeredBy ? ` (${row.answeredBy}, ${fmtTime(row.answeredAt)})` : ''}
      {row.answer?.decision ? <div style={{ color: '#0f172a' }}>Entscheid: {row.answer.decision}</div> : null}
      {row.answer?.delegateTo ? <div>→ {row.answer.delegateTo}</div> : null}
      {row.workerPending ? <div style={{ color: '#b45309' }}>Worker-Notiz ausstehend (nächster Tick)</div> : null}
      {failed.length > 0 && (
        <div style={{ color: '#b91c1c' }}>
          {failed.map((w) => `${w.kind} ${w.target}: ${w.error}`).join(' · ')}
        </div>
      )}
    </div>
  );
}

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

function AskCard({
  row,
  mapId,
  by,
  readOnly,
  result,
  onResult,
}: {
  row: AskRow;
  mapId: string;
  by: string;
  readOnly: boolean;
  result: AnswerResult | null;
  onResult: (id: string, r: AnswerResult) => void;
}) {
  const a = row.ask;
  const selectNode = useMindmapStore((s) => s.selectNode);
  const setActiveView = useMindmapStore((s) => s.setActiveView);
  const [decision, setDecision] = useState('');
  const [milestone, setMilestone] = useState('');
  const [noRequeue, setNoRequeue] = useState(false);
  const [delegateTo, setDelegateTo] = useState<'Rita' | 'Susi' | 'Dana'>('Rita');
  const [busy, setBusy] = useState(false);
  const setResult = (r: AnswerResult) => onResult(a.id, r);
  // «Mehr»: everything the collector folded into this record plus the node
  // itself (blockedReason, description) — fetched on first open only.
  const [more, setMore] = useState(false);
  const [node, setNode] = useState<Node | null | 'loading' | 'error'>(null);
  useEffect(() => {
    if (!more || node !== null || !a.unblocks.node_id) return;
    setNode('loading');
    api
      .fetchNode(mapId, a.unblocks.node_id)
      .then((n) => setNode(n))
      .catch(() => setNode('error'));
  }, [more, node, a.unblocks.node_id, mapId]);

  const options = a.options.length > 0 ? a.options : ['Ja', 'Nein'];
  const canAnswer = !readOnly && !busy && decision.trim().length > 0 && !(a.needs_version && isVersionOnly(a) && !milestone.trim());

  const preview: AskWritePlan = planAskWrites(
    a,
    { action: 'answered', decision: decision || '…', by, milestone: milestone || undefined, noRequeue },
    null,
    new Date().toISOString().slice(0, 10),
  );

  async function submit(input: AskAnswerInput) {
    setBusy(true);
    try {
      const r = await api.answerAsk(mapId, a.id, input);
      const head = `${STATUS_LABEL[r.ask.status] ?? r.ask.status}${r.ask.answeredBy ? ` (${r.ask.answeredBy})` : ''}`;
      setResult({
        ok: r.ok,
        lines: [head, ...r.ask.writes.map((w) => `${w.done ? '✓' : w.error ? '✗' : '…'} ${w.kind} ${w.target} — ${w.detail}${w.error ? ` (${w.error})` : ''}`)],
      });
    } catch (e) {
      const notFound = e instanceof api.ApiError && (e.code === 'ASK_NOT_FOUND' || e.status === 404);
      setResult({
        ok: false,
        lines: [
          notFound
            ? 'Diese Frage ist seit dem letzten Push nicht mehr offen — anderswo beantwortet (Terminal-Runde), Ticket zu, oder Knoten von Hand entparkt. Nichts geschrieben.'
            : e instanceof Error
              ? e.message
              : 'failed',
        ],
      });
    } finally {
      setBusy(false);
    }
  }

  const dim = a.moot || a.stale;
  const unb: React.ReactNode[] = [];
  if (a.unblocks.node_id) {
    const nid = a.unblocks.node_id;
    unb.push(
      <button
        key="node"
        onClick={() => {
          selectNode(nid);
          setActiveView('mindmap');
        }}
        style={{ background: 'none', border: 'none', padding: 0, color: '#2563eb', cursor: 'pointer', fontSize: 12 }}
      >
        Knoten {a.unblocks.node_title ? `„${a.unblocks.node_title.slice(0, 40)}“` : nid.slice(0, 8)}
        {a.unblocks.node_status ? ` (${a.unblocks.node_status})` : ''}
      </button>,
    );
  }
  if (a.unblocks.claimed_by) unb.push(<span key="claim">geclaimt von {a.unblocks.claimed_by}</span>);
  if (a.unblocks.worker) unb.push(<span key="worker">Worker {a.unblocks.worker}</span>);
  if (a.unblocks.pr) unb.push(<span key="pr">PR {a.unblocks.pr}{a.unblocks.pr_state ? ` ${a.unblocks.pr_state}` : ''}</span>);

  return (
    <section
      style={{
        border: `1px solid ${dim ? '#e2e8f0' : '#cbd5e1'}`,
        borderRadius: 8,
        padding: '12px 14px',
        marginBottom: 10,
        background: dim ? '#f8fafc' : '#fff',
        opacity: dim ? 0.75 : 1,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 13 }}>
        {a.url ? (
          <a href={a.url} target="_blank" rel="noreferrer" style={{ fontWeight: 700, color: '#1d4ed8' }}>{ref(a)}</a>
        ) : (
          <b>{ref(a)}</b>
        )}
        <span style={{ fontWeight: 600 }}>{title(a)}</span>
        <span style={{ color: '#64748b' }}>
          {a.answerer}
          {a.priority ? ` · ${a.priority}` : ''}
          {a.idle_hours != null ? ` · idle ${a.idle_hours}h` : ''}
          {` · ${HINT_LABEL[a.hint] ?? a.hint}`}
        </span>
        {a.moot && <Tag color="#64748b">hinfällig — PR {a.unblocks.pr_state}</Tag>}
        {a.stale && <Tag color="#64748b">Ticket geschlossen</Tag>}
        {a.needs_version && <Tag color="#b45309">NEEDS-VERSION</Tag>}
      </div>
      <div style={{ marginTop: 6, fontSize: 14, whiteSpace: 'pre-wrap' }}>
        <span style={{ color: '#64748b', fontSize: 12 }}>Frage ({a.question_author ?? '?'}): </span>
        {a.question}
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: '#64748b', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
        {unb.length > 0 && <span>hängt dran:</span>}
        {unb}
        <button
          onClick={() => setMore((v) => !v)}
          style={{ background: 'none', border: '1px solid #cbd5e1', borderRadius: 4, padding: '1px 8px', color: '#334155', cursor: 'pointer', fontSize: 12 }}
        >
          {more ? 'Weniger' : 'Mehr…'}
        </button>
      </div>
      {more && <AskDetails ask={a} row={row} node={node} />}

      {result ? (
        <div style={{ marginTop: 10, fontSize: 12, color: result.ok ? '#047857' : '#b91c1c', whiteSpace: 'pre-wrap' }}>
          {result.lines.length ? result.lines.join('\n') : 'notiert'}
        </div>
      ) : readOnly ? null : (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            {options.map((o) => (
              <Chip key={o} active={decision === o} onClick={() => setDecision(decision === o ? '' : o)}>
                {o}
              </Chip>
            ))}
          </div>
          <textarea
            value={decision}
            onChange={(e) => setDecision(e.target.value)}
            placeholder="Entscheid (Freitext oder Option oben)…"
            rows={2}
            style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, padding: 6, border: '1px solid #cbd5e1', borderRadius: 6 }}
          />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 6, fontSize: 12, color: '#475569' }}>
            {a.needs_version && (
              <label>
                Milestone{' '}
                <input
                  value={milestone}
                  onChange={(e) => setMilestone(e.target.value)}
                  placeholder="V1.5"
                  style={{ fontSize: 12, padding: '2px 6px', border: '1px solid #cbd5e1', borderRadius: 4, width: 90 }}
                />
              </label>
            )}
            {a.unblocks.node_id && (
              <label>
                <input type="checkbox" checked={noRequeue} onChange={(e) => setNoRequeue(e.target.checked)} /> kein Requeue (Status bleibt)
              </label>
            )}
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: '#64748b' }}>
            <b>Diese Antwort schreibt:</b>
            <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
              {preview.skip && <li>{preview.skip}</li>}
              {preview.github && (
                <li>
                  Kommentar auf #{preview.github.ticket}: «Entscheid ({by}, heute): {decision || '…'}»
                  {preview.github.milestone ? ` · Milestone ${preview.github.milestone}, NEEDS-VERSION weg` : ''}
                </li>
              )}
              {preview.node && (
                <li>
                  Knoten {preview.node.nodeId.slice(0, 8)}: Entscheid in die Beschreibung, blockedReason weg, Tag blocked weg; {preview.node.why}
                </li>
              )}
              {preview.worker && <li>Notiz an Worker {preview.worker.worker} — liefert der nächste Tick</li>}
              {!preview.skip && !preview.github && !preview.node && !preview.worker && <li>nur die Ledger-Zeile (kein Ticket, kein Knoten, kein Worker)</li>}
            </ul>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              disabled={!canAnswer}
              style={btn('primary', !canAnswer)}
              onClick={() => submit({ action: 'answered', decision: decision.trim(), by, milestone: milestone.trim() || undefined, noRequeue })}
            >
              Antworten
            </button>
            <button disabled={busy} style={btn('plain', busy)} onClick={() => submit({ action: 'later', by })}>
              Später
            </button>
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <select value={delegateTo} onChange={(e) => setDelegateTo(e.target.value as 'Rita' | 'Susi' | 'Dana')} style={{ fontSize: 12 }}>
                <option>Rita</option>
                <option>Susi</option>
                <option>Dana</option>
              </select>
              <button disabled={busy} style={btn('plain', busy)} onClick={() => submit({ action: 'delegate', by, delegateTo })}>
                Delegieren
              </button>
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

function GoneCard({ ask: a, at, onDismiss }: { ask: Ask; at: string; onDismiss: () => void }) {
  return (
    <section style={{ border: '1px dashed #cbd5e1', borderRadius: 8, padding: '8px 14px', marginBottom: 10, background: '#f8fafc', fontSize: 13, color: '#475569' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        {a.url ? (
          <a href={a.url} target="_blank" rel="noreferrer" style={{ fontWeight: 700, color: '#1d4ed8' }}>{ref(a)}</a>
        ) : (
          <b>{ref(a)}</b>
        )}
        <span style={{ fontWeight: 600 }}>{title(a)}</span>
        <span>· seit dem Push um {fmtTime(at)} nicht mehr offen — anderswo beantwortet (Terminal-Runde), Ticket zu, oder Knoten von Hand entparkt. Hier ist nichts mehr zu tun.</span>
        <button onClick={onDismiss} style={{ marginLeft: 'auto', fontSize: 12, padding: '1px 8px', border: '1px solid #cbd5e1', borderRadius: 4, background: '#fff', color: '#334155', cursor: 'pointer' }}>
          Ausblenden
        </button>
      </div>
    </section>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  'tick:decision': 'Orchestrator (Tick)',
  'tick:map': 'Knoten (blockedReason)',
  'mindblown:live': 'Knoten (blockedReason)',
  'rollup:prompt': 'Worker-Dialog (PROMPT-BLOCKED)',
  'pending-notes': 'Heartbeat-Backlog',
  'github:human': 'GitHub «Warum nicht jetzt gefixt»',
  'github:needs-version': 'GitHub NEEDS-VERSION',
};

function AskDetails({ ask: a, row, node }: { ask: Ask; row: AskRow; node: Node | null | 'loading' | 'error' }) {
  const dl: [string, React.ReactNode][] = [];
  if (a.url) dl.push(['Ticket', <a key="u" href={a.url} target="_blank" rel="noreferrer" style={{ color: '#1d4ed8' }}>{a.url}</a>]);
  if (a.requirement) dl.push(['Requirement', a.requirement]);
  if (a.labels && a.labels.length > 0) dl.push(['Labels', a.labels.join(', ')]);
  if (a.milestone) dl.push(['Milestone', a.milestone]);
  if (a.answerers && a.answerers.length > 1) dl.push(['Beteiligte', a.answerers.join(', ')]);
  dl.push(['Quellen', a.sources.map((s) => SOURCE_LABEL[s] ?? s).join(' · ')]);
  dl.push(['Gesehen', `seit ${fmtTime(row.firstSeenAt)}, zuletzt gepusht ${fmtTime(row.pushedAt)}`]);
  if (a.unblocks.pr) dl.push(['PR', `${a.unblocks.pr}${a.unblocks.pr_state ? ` (${a.unblocks.pr_state})` : ''}`]);
  const qs = (a.questions ?? []).filter((q) => q.text.trim() !== a.question.trim());
  return (
    <div style={{ marginTop: 8, padding: '8px 10px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 12 }}>
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 10px' }}>
        {dl.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt style={{ color: '#64748b' }}>{k}</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{v}</dd>
          </React.Fragment>
        ))}
      </dl>
      {qs.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ color: '#64748b' }}>Dieselbe Frage, andere Wortlaute:</div>
          {qs.map((q, i) => (
            <div key={i} style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
              <span style={{ color: '#64748b' }}>{SOURCE_LABEL[q.source] ?? q.source}{q.author ? ` (${q.author})` : ''}: </span>
              {q.text}
            </div>
          ))}
        </div>
      )}
      {a.unblocks.node_id && (
        <div style={{ marginTop: 8 }}>
          <div style={{ color: '#64748b' }}>Knoten</div>
          {node === 'loading' && <Muted>lädt…</Muted>}
          {node === 'error' && <Muted>Knoten nicht ladbar (gelöscht oder keine Berechtigung)</Muted>}
          {node && node !== 'loading' && node !== 'error' && (
            <div style={{ marginTop: 2 }}>
              <div><b>{node.text}</b> · Status {node.status ?? '—'}{node.claimedBySession ? ` · geclaimt von ${node.claimedBySession}` : ''}{node.tags.length ? ` · Tags ${node.tags.join(', ')}` : ''}</div>
              {node.blockedReason && <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}><span style={{ color: '#64748b' }}>blockedReason: </span>{node.blockedReason}</div>}
              {proseMirrorToPlainText(node.description) && (
                <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>
                  <span style={{ color: '#64748b' }}>Beschreibung: </span>
                  {proseMirrorToPlainText(node.description)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, border: `1px solid ${color}`, color }}>{children}</span>
  );
}
