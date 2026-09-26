/**
 * Ticket intake on the phone (#387): same server loop as the desktop
 * modal, laid out as a tall bottom sheet. The mobile tree has no zustand
 * store, so versions and phases come in as props and the created node
 * goes back through `onCreated` for the viewer's local patch.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MindMap, Node, Version } from '@mindblown/core';
import * as api from '../api.js';
import type { IntakeDraft, IntakeQuestion, NodeWithComputed } from '../api.js';
import {
  editsFromDraft,
  toAcceptPayload,
  answersToMessage,
  parseTags,
  type DraftEdits,
} from '../intakeDraft.js';

interface Props {
  map: MindMap;
  nodes: NodeWithComputed[];
  versions: Version[];
  onClose: () => void;
  onCreated: (created: Node) => void;
}

interface LogEntry {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

export function MobileTicketIntakeSheet({ map, nodes, versions, onClose, onCreated }: Props) {
  const root = nodes.find((n) => n.id === map.rootNodeId);
  const [intakeId, setIntakeId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [draft, setDraft] = useState<IntakeDraft | null>(null);
  const [edits, setEdits] = useState<DraftEdits | null>(null);
  const [tagsRaw, setTagsRaw] = useState('');
  const [questions, setQuestions] = useState<IntakeQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [repoConnected, setRepoConnected] = useState(false);
  const [createIssue, setCreateIssue] = useState<boolean | null>(null);
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptedCount, setAcceptedCount] = useState(0);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [log, draft, questions]);

  const applyTurn = useCallback((r: api.IntakeTurnResponse) => {
    setIntakeId(r.intakeId);
    setRepoConnected(r.repoConnected);
    setCreateIssue((prev) => (prev === null ? r.repoConnected : prev));
    if (r.provider) setModelLabel(r.provider.model);
    if (r.text) setLog((l) => [...l, { role: 'assistant', text: r.text }]);
    if (r.draft) {
      setDraft(r.draft);
      setEdits(editsFromDraft(r.draft));
      setTagsRaw(r.draft.tags.join(', '));
    }
    setQuestions(r.questions);
    setAnswers({});
    if (r.stepLimit && !r.draft) {
      setLog((l) => [...l, { role: 'system', text: 'The model ran out of steps before drafting. Try a shorter description.' }]);
    }
  }, []);

  const send = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed || loading) return;
      setLoading(true);
      setError(null);
      setLog((l) => [...l, { role: 'user', text: trimmed }]);
      try {
        const r = await api.aiIntake(map.id, trimmed, { intakeId, parentHintId: map.rootNodeId });
        applyTurn(r);
        setInput('');
      } catch (err: any) {
        if (err?.code === 'INTAKE_EXPIRED') {
          setIntakeId(null);
          setError('The session expired. Send it again to start a new one.');
        } else {
          setError(err?.message || 'The AI request failed');
        }
      } finally {
        setLoading(false);
      }
    },
    [map.id, map.rootNodeId, intakeId, loading, applyTurn],
  );

  const sendAnswers = useCallback(() => {
    const combined = [answersToMessage(questions, answers), input.trim()].filter((s) => s.length > 0).join('\n\n');
    if (combined) void send(combined);
  }, [questions, answers, input, send]);

  const accept = useCallback(async () => {
    if (!draft || !edits || accepting) return;
    setAccepting(true);
    setError(null);
    try {
      const payload = toAcceptPayload(draft, { ...edits, tags: parseTags(tagsRaw) });
      const r = await api.aiIntakeAccept(map.id, payload, { intakeId, createIssue: createIssue === true });
      onCreated(r.node);
      setAcceptedCount((n) => n + 1);
      const parts = [`Created «${r.node.text}»`];
      if (r.issue) {
        const a = r.issue.author;
        parts.push(`issue #${r.issue.number}${a?.as === 'user' ? ` as ${a.login}` : a?.as === 'binding' ? ' as the repo binding' : ''}`);
        if (a?.fallbackReason) parts.push(a.fallbackReason);
      }
      if (r.issueError) parts.push(r.issueError);
      setLog((l) => [...l, { role: 'system', text: parts.join(' — ') }]);
      setDraft(null);
      setEdits(null);
      setQuestions([]);
      setAnswers({});
    } catch (err: any) {
      setError(err?.message || 'Could not create the node');
    } finally {
      setAccepting(false);
    }
  }, [draft, edits, accepting, tagsRaw, map.id, intakeId, createIssue, onCreated]);

  const hasQuestions = questions.length > 0;
  const started = log.length > 0;
  const phases = map.phases ?? [];

  return (
    <>
      <div className="mb-sheet-backdrop" onClick={onClose} />
      <div className="mb-sheet mb-sheet-tall" role="dialog" aria-modal="true">
        <div className="mb-sheet-header">
          <span style={{ flex: 1 }}>
            Ticket intake
            <span style={{ fontWeight: 400, color: '#64748b', fontSize: 12, marginLeft: 8 }}>
              {root?.text ?? map.name}
              {modelLabel ? ` · ${modelLabel}` : ''}
              {acceptedCount > 0 ? ` · ${acceptedCount} created` : ''}
            </span>
          </span>
          <button className="mb-link" onClick={onClose}>
            {acceptedCount > 0 ? 'Done' : 'Cancel'}
          </button>
        </div>

        <div className="mb-sheet-body" style={{ padding: '4px 16px 12px', flex: 1 }}>
          {!started && (
            <div style={{ fontSize: 13, color: '#475569', marginBottom: 8 }}>
              Describe the ticket in a sentence or two. The AI checks for duplicates, picks where it belongs,
              drafts it and asks up to three questions. Nothing is created until you accept.
            </div>
          )}

          {log.map((e, i) => (
            <div key={i} style={e.role === 'user' ? userLine : e.role === 'assistant' ? aiLine : sysLine}>
              {e.text}
            </div>
          ))}

          {draft && edits && (
            <div style={card}>
              {draft.duplicates.length > 0 && (
                <div style={warn}>
                  <strong>Possibly already covered:</strong>
                  {draft.duplicates.map((d) => (
                    <div key={d.nodeId}>«{d.text}» — {d.reason}</div>
                  ))}
                </div>
              )}
              <div className="mb-detail-label">Title</div>
              <input
                type="text"
                className="mb-input"
                value={edits.title}
                onChange={(e) => setEdits({ ...edits, title: e.target.value })}
              />
              <div className="mb-detail-label" style={{ marginTop: 10 }}>Description</div>
              <textarea
                className="mb-textarea"
                style={{ minHeight: 160, fontSize: 13, fontFamily: 'ui-monospace, monospace' }}
                value={edits.description}
                onChange={(e) => setEdits({ ...edits, description: e.target.value })}
              />
              <div style={{ fontSize: 12, color: '#475569', marginTop: 8 }}>
                <strong>Under:</strong> {draft.parentText}
                {draft.parentReason ? <span style={{ color: '#64748b' }}> — {draft.parentReason}</span> : null}
              </div>

              <div className="mb-detail-label" style={{ marginTop: 10 }}>Priority</div>
              <div className="mb-edit-pill-row">
                {(['P0', 'P1', 'P2', 'P3'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="mb-status-pill mb-status-pill-tappable"
                    aria-pressed={edits.priority === p}
                    onClick={() => setEdits({ ...edits, priority: edits.priority === p ? null : p })}
                  >
                    {p}
                  </button>
                ))}
              </div>

              {versions.length > 0 && (
                <>
                  <div className="mb-detail-label" style={{ marginTop: 10 }}>Version</div>
                  <select
                    className="mb-select"
                    value={edits.versionId ?? ''}
                    onChange={(e) => setEdits({ ...edits, versionId: e.target.value || null })}
                  >
                    <option value="">—</option>
                    {versions.map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </>
              )}
              {phases.length > 0 && (
                <>
                  <div className="mb-detail-label" style={{ marginTop: 10 }}>Phase</div>
                  <select
                    className="mb-select"
                    value={edits.phaseId ?? ''}
                    onChange={(e) => setEdits({ ...edits, phaseId: e.target.value || null })}
                  >
                    <option value="">—</option>
                    {phases.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </>
              )}
              <div className="mb-detail-label" style={{ marginTop: 10 }}>Tags</div>
              <input
                type="text"
                className="mb-input"
                value={tagsRaw}
                placeholder="comma-separated"
                onChange={(e) => setTagsRaw(e.target.value)}
              />

              {draft.estimate ? (
                <label style={checkRow}>
                  <input
                    type="checkbox"
                    checked={edits.keepEstimate}
                    onChange={(e) => setEdits({ ...edits, keepEstimate: e.target.checked })}
                  />
                  <span>
                    Write estimate <strong>{draft.estimate.estimate} {draft.estimate.effortUnit}</strong>{' '}
                    <span style={{ color: '#64748b' }}>
                      ({draft.estimate.confidence} confidence, {draft.estimate.samplesUsed} samples)
                      {draft.estimate.confidence === 'low' ? ' · suggestion only' : ''}
                    </span>
                  </span>
                </label>
              ) : null}

              {draft.dependencies.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div className="mb-detail-label">Depends on</div>
                  {draft.dependencies.map((d) => {
                    const kept = edits.keptDependencies.includes(d.nodeId);
                    return (
                      <label key={d.nodeId} style={checkRow}>
                        <input
                          type="checkbox"
                          checked={kept}
                          onChange={(e) =>
                            setEdits({
                              ...edits,
                              keptDependencies: e.target.checked
                                ? [...edits.keptDependencies, d.nodeId]
                                : edits.keptDependencies.filter((id) => id !== d.nodeId),
                            })
                          }
                        />
                        <span>«{d.text}» <span style={{ color: '#64748b' }}>— {d.reason}</span></span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {hasQuestions && (
            <div style={{ ...card, borderColor: '#bfdbfe', background: '#eff6ff' }}>
              {questions.map((q, i) => (
                <div key={q.id} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 14 }}>
                    {i + 1}. {q.question}
                    {q.why ? <span style={{ color: '#64748b', fontSize: 12 }}> — {q.why}</span> : null}
                  </div>
                  {q.options.length > 0 && (
                    <div className="mb-edit-pill-row" style={{ marginTop: 6 }}>
                      {q.options.map((o) => (
                        <button
                          key={o}
                          type="button"
                          className="mb-status-pill mb-status-pill-tappable"
                          aria-pressed={answers[q.id] === o}
                          onClick={() => setAnswers({ ...answers, [q.id]: o })}
                        >
                          {o}
                        </button>
                      ))}
                    </div>
                  )}
                  <input
                    type="text"
                    className="mb-input"
                    style={{ marginTop: 6 }}
                    value={answers[q.id] ?? ''}
                    placeholder={q.options.length > 0 ? 'or type an answer' : 'your answer'}
                    onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                  />
                </div>
              ))}
            </div>
          )}

          {error && <div className="mb-error">{error}</div>}
          <div ref={endRef} />
        </div>

        <div style={{ padding: '8px 16px calc(12px + env(safe-area-inset-bottom))', borderTop: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            className="mb-textarea"
            style={{ minHeight: started ? 56 : 100 }}
            value={input}
            disabled={loading}
            placeholder={
              !started
                ? 'e.g. the unread badge on the chat should not count my own messages…'
                : hasQuestions
                  ? 'Anything else (optional)'
                  : draft
                    ? 'Change something, or describe the next ticket'
                    : 'Describe the next ticket'
            }
            onChange={(e) => setInput(e.target.value)}
          />
          {repoConnected && draft && (
            <label style={{ ...checkRow, marginTop: 0 }}>
              <input type="checkbox" checked={createIssue === true} onChange={(e) => setCreateIssue(e.target.checked)} />
              <span>Also file the issue on the connected repo</span>
            </label>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            {hasQuestions ? (
              <button
                className="mb-btn-secondary"
                style={{ flex: 1 }}
                disabled={loading || (!Object.values(answers).some((a) => a.trim()) && !input.trim())}
                onClick={sendAnswers}
              >
                {loading ? 'Thinking…' : 'Send answers'}
              </button>
            ) : (
              <button
                className={draft ? 'mb-btn-secondary' : 'mb-btn-primary'}
                style={{ flex: 1 }}
                disabled={loading || !input.trim()}
                onClick={() => void send(input)}
              >
                {loading ? 'Thinking…' : draft ? 'Send' : 'Draft ticket'}
              </button>
            )}
            {draft && edits && (
              <button
                className="mb-btn-primary"
                style={{ flex: 1 }}
                disabled={accepting || loading || !edits.title.trim()}
                onClick={() => void accept()}
              >
                {accepting ? 'Creating…' : 'Accept'}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

const card: React.CSSProperties = {
  border: '1px solid #e2e8f0',
  borderRadius: 10,
  padding: '10px 12px 12px',
  margin: '8px 0',
  background: '#fafafa',
};

const warn: React.CSSProperties = {
  fontSize: 12,
  color: '#9a3412',
  background: '#fff7ed',
  border: '1px solid #fed7aa',
  borderRadius: 8,
  padding: '6px 8px',
  marginBottom: 8,
};

const checkRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  fontSize: 13,
  marginTop: 10,
};

const userLine: React.CSSProperties = {
  fontSize: 14,
  background: '#f1f5f9',
  borderRadius: 10,
  padding: '8px 10px',
  margin: '6px 0',
  whiteSpace: 'pre-wrap',
};

const aiLine: React.CSSProperties = {
  fontSize: 14,
  color: '#1e293b',
  padding: '4px 2px',
  margin: '4px 0',
  whiteSpace: 'pre-wrap',
};

const sysLine: React.CSSProperties = {
  fontSize: 13,
  color: '#15803d',
  padding: '4px 2px',
  margin: '4px 0',
};
