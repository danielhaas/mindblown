/**
 * Ticket intake (#387): describe work in prose, get back a draft ticket
 * that fits this plan plus up to three questions, answer, edit, accept.
 * One modal = one intake session; accepted tickets stay in the session
 * so the next one can depend on them. Nothing is written before Accept.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { IntakeDraft, IntakeQuestion } from './api.js';
import {
  editsFromDraft,
  toAcceptPayload,
  answersToMessage,
  parseTags,
  type DraftEdits,
} from './intakeDraft.js';

interface Props {
  mapId: string;
  parentId: string;
  parentText: string;
  onClose: () => void;
}

interface LogEntry {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

export function TicketIntakeModal({ mapId, parentId, parentText, onClose }: Props) {
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
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptedCount, setAcceptedCount] = useState(0);

  const loadMap = useMindmapStore((s) => s.loadMap);
  const versions = useMindmapStore((s) => s.versions);
  const phases = useMindmapStore((s) => s.currentMap?.phases ?? []);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [log, draft, questions]);

  const applyTurn = useCallback((r: api.IntakeTurnResponse) => {
    setIntakeId(r.intakeId);
    setRepoConnected(r.repoConnected);
    setCreateIssue((prev) => (prev === null ? r.repoConnected : prev));
    if (r.text) setLog((l) => [...l, { role: 'assistant', text: r.text }]);
    if (r.draft) {
      setDraft(r.draft);
      setEdits(editsFromDraft(r.draft));
      setTagsRaw(r.draft.tags.join(', '));
    }
    setQuestions(r.questions);
    setAnswers({});
    if (r.stepLimit && !r.draft) {
      setLog((l) => [
        ...l,
        { role: 'system', text: 'The model ran out of steps before drafting. Try a shorter or clearer description.' },
      ]);
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
        const r = await api.aiIntake(mapId, trimmed, { intakeId, parentHintId: parentId });
        applyTurn(r);
        setInput('');
      } catch (err: any) {
        if (err?.code === 'INTAKE_EXPIRED') {
          setIntakeId(null);
          setError('The session expired. Your message was not sent — send it again to start a new one.');
        } else {
          setError(err?.message || 'The AI request failed');
        }
      } finally {
        setLoading(false);
      }
    },
    [mapId, intakeId, parentId, loading, applyTurn],
  );

  const sendAnswers = useCallback(() => {
    const msg = answersToMessage(questions, answers);
    const extra = input.trim();
    const combined = [msg, extra].filter((s) => s.length > 0).join('\n\n');
    if (!combined) return;
    void send(combined);
  }, [questions, answers, input, send]);

  const accept = useCallback(async () => {
    if (!draft || !edits || accepting) return;
    setAccepting(true);
    setError(null);
    try {
      const payload = toAcceptPayload(draft, { ...edits, tags: parseTags(tagsRaw) });
      const r = await api.aiIntakeAccept(mapId, payload, {
        intakeId,
        createIssue: createIssue === true,
      });
      await loadMap(mapId);
      setAcceptedCount((n) => n + 1);
      const parts = [`Created «${r.node.text}»`];
      if (r.issue) parts.push(`filed issue #${r.issue.number}`);
      if (r.issueError) parts.push(r.issueError);
      if (r.dependencyErrors?.length) parts.push(`dependency errors: ${r.dependencyErrors.join('; ')}`);
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
  }, [draft, edits, accepting, tagsRaw, mapId, intakeId, createIssue, loadMap]);

  const hasQuestions = questions.length > 0;
  const started = log.length > 0;

  return (
    <>
      <div style={backdropStyle} onClick={onClose} />
      <div style={modalStyle}>
        <div style={headerStyle}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, color: '#0f172a' }}>Ticket intake</div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
              Under: {parentText}
              {acceptedCount > 0 ? ` · ${acceptedCount} created this session` : ''}
            </div>
          </div>
          <button onClick={onClose} style={closeBtnStyle} aria-label="Close">
            &times;
          </button>
        </div>

        <div style={bodyStyle}>
          {!started && (
            <div style={{ marginBottom: 8, fontSize: 12, color: '#475569' }}>
              Describe the ticket in a sentence or two. The model checks for duplicates, proposes where it
              belongs, drafts title, description and acceptance criteria, estimates it from this map&apos;s
              history and asks up to three questions. Nothing is created until you accept.
            </div>
          )}

          {log.map((e, i) => (
            <div key={i} style={e.role === 'user' ? userLineStyle : e.role === 'assistant' ? aiLineStyle : sysLineStyle}>
              {e.text}
            </div>
          ))}

          {draft && edits && (
            <div style={cardStyle}>
              <div style={cardTitleStyle}>Draft</div>
              {draft.duplicates.length > 0 && (
                <div style={warnStyle}>
                  <strong>Possibly already covered:</strong>
                  {draft.duplicates.map((d) => (
                    <div key={d.nodeId}>
                      «{d.text}» — {d.reason}
                    </div>
                  ))}
                </div>
              )}
              <label style={labelStyle}>Title</label>
              <input
                type="text"
                value={edits.title}
                onChange={(e) => setEdits({ ...edits, title: e.target.value })}
                style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', fontWeight: 500 }}
              />
              <label style={labelStyle}>Description</label>
              <textarea
                value={edits.description}
                onChange={(e) => setEdits({ ...edits, description: e.target.value })}
                style={{ ...textareaStyle, minHeight: 180, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
              />
              <div style={{ fontSize: 12, color: '#475569', margin: '8px 0 4px' }}>
                <strong>Parent:</strong> {draft.parentText}
                {draft.parentReason ? <span style={{ color: '#64748b' }}> — {draft.parentReason}</span> : null}
              </div>
              <div style={rowStyle}>
                <div style={fieldStyle}>
                  <label style={labelStyle}>Priority</label>
                  <select
                    value={edits.priority ?? ''}
                    onChange={(e) =>
                      setEdits({ ...edits, priority: (e.target.value || null) as DraftEdits['priority'] })
                    }
                    style={selectStyle}
                  >
                    <option value="">—</option>
                    {(['P0', 'P1', 'P2', 'P3'] as const).map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={fieldStyle}>
                  <label style={labelStyle}>Version</label>
                  <select
                    value={edits.versionId ?? ''}
                    onChange={(e) => setEdits({ ...edits, versionId: e.target.value || null })}
                    style={selectStyle}
                  >
                    <option value="">—</option>
                    {versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={fieldStyle}>
                  <label style={labelStyle}>Phase</label>
                  <select
                    value={edits.phaseId ?? ''}
                    onChange={(e) => setEdits({ ...edits, phaseId: e.target.value || null })}
                    style={selectStyle}
                  >
                    <option value="">—</option>
                    {phases.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ ...fieldStyle, flex: 2 }}>
                  <label style={labelStyle}>Tags</label>
                  <input
                    type="text"
                    value={tagsRaw}
                    onChange={(e) => setTagsRaw(e.target.value)}
                    placeholder="comma-separated"
                    style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
                  />
                </div>
              </div>

              {draft.estimate ? (
                <label style={checkRowStyle}>
                  <input
                    type="checkbox"
                    checked={edits.keepEstimate}
                    onChange={(e) => setEdits({ ...edits, keepEstimate: e.target.checked })}
                  />
                  <span>
                    Write estimate <strong>{draft.estimate.estimate} {draft.estimate.effortUnit}</strong>{' '}
                    <span style={{ color: confidenceColor(draft.estimate.confidence) }}>
                      ({draft.estimate.confidence} confidence, {draft.estimate.samplesUsed} samples)
                    </span>
                    {draft.estimate.notes ? <span style={{ color: '#64748b' }}> — {draft.estimate.notes}</span> : null}
                    {draft.estimate.confidence === 'low' ? (
                      <span style={{ color: '#64748b' }}> · suggestion only, tick to write it</span>
                    ) : null}
                  </span>
                </label>
              ) : (
                <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 8 }}>No estimate (estimator unavailable)</div>
              )}

              {draft.dependencies.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div style={labelStyle}>Depends on (finish-to-start)</div>
                  {draft.dependencies.map((d) => {
                    const kept = edits.keptDependencies.includes(d.nodeId);
                    return (
                      <label key={d.nodeId} style={checkRowStyle}>
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
                        <span>
                          «{d.text}» <span style={{ color: '#64748b' }}>— {d.reason}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {hasQuestions && (
            <div style={{ ...cardStyle, borderColor: '#bfdbfe', background: '#eff6ff' }}>
              <div style={cardTitleStyle}>Questions</div>
              {questions.map((q, i) => (
                <div key={q.id} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 13, color: '#0f172a' }}>
                    {i + 1}. {q.question}
                    {q.why ? <span style={{ color: '#64748b', fontSize: 12 }}> — {q.why}</span> : null}
                  </div>
                  {q.options.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                      {q.options.map((o) => (
                        <button
                          key={o}
                          type="button"
                          onClick={() => setAnswers({ ...answers, [q.id]: o })}
                          style={answers[q.id] === o ? chipActiveStyle : chipStyle}
                        >
                          {o}
                        </button>
                      ))}
                    </div>
                  )}
                  <input
                    type="text"
                    value={answers[q.id] ?? ''}
                    onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                    placeholder={q.options.length > 0 ? 'or type an answer' : 'your answer'}
                    style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', marginTop: 4, fontSize: 12 }}
                  />
                </div>
              ))}
            </div>
          )}

          {error && <div style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>{error}</div>}
          <div ref={logEndRef} />
        </div>

        <div style={composerStyle}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (hasQuestions) sendAnswers();
                else void send(input);
              }
            }}
            placeholder={
              !started
                ? 'e.g. when a PR is merged the linked issue should close, but only if no other PR is still open for it…'
                : hasQuestions
                  ? 'Anything else for the model (optional)'
                  : draft
                    ? 'Change something ("make it P1", "put it under Sync") — or describe the next ticket'
                    : 'Describe the next ticket'
            }
            style={{ ...textareaStyle, minHeight: started ? 56 : 120 }}
            autoFocus
            disabled={loading}
          />
        </div>

        <div style={footerStyle}>
          {repoConnected && draft && (
            <label style={{ ...checkRowStyle, marginTop: 0 }}>
              <input
                type="checkbox"
                checked={createIssue === true}
                onChange={(e) => setCreateIssue(e.target.checked)}
              />
              <span>Also file the issue on the connected repo</span>
            </label>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={secondaryBtnStyle}>
            {acceptedCount > 0 ? 'Done' : 'Cancel'}
          </button>
          {hasQuestions ? (
            <button
              onClick={sendAnswers}
              disabled={loading || (!Object.values(answers).some((a) => a.trim()) && !input.trim())}
              style={secondaryBtnStyle}
            >
              {loading ? 'Thinking…' : 'Send answers'}
            </button>
          ) : (
            <button
              onClick={() => void send(input)}
              disabled={loading || !input.trim()}
              style={draft ? secondaryBtnStyle : primaryBtnStyle}
            >
              {loading ? 'Thinking…' : draft ? 'Send' : 'Draft ticket'}
            </button>
          )}
          {draft && edits && (
            <button
              onClick={accept}
              disabled={accepting || loading || !edits.title.trim()}
              style={primaryBtnStyle}
              title="Creates the node exactly as shown on the card"
            >
              {accepting ? 'Creating…' : 'Accept'}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function confidenceColor(c: 'low' | 'medium' | 'high'): string {
  return c === 'high' ? '#15803d' : c === 'medium' ? '#b45309' : '#94a3b8';
}

// ── Styles ──────────────────────────────────────────────────────

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.3)',
  zIndex: 2000,
};

const modalStyle: React.CSSProperties = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: 2001,
  background: '#fff',
  borderRadius: 12,
  boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
  width: 'min(760px, 96vw)',
  maxHeight: '90vh',
  display: 'flex',
  flexDirection: 'column',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  padding: '16px 20px 12px',
  borderBottom: '1px solid #e2e8f0',
};

const bodyStyle: React.CSSProperties = {
  padding: '12px 20px',
  overflowY: 'auto',
  flex: 1,
  minHeight: 120,
};

const composerStyle: React.CSSProperties = {
  padding: '8px 20px',
  borderTop: '1px solid #e2e8f0',
};

const footerStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  padding: '10px 20px 12px',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  border: '1px solid #cbd5e1',
  borderRadius: 6,
  fontSize: 13,
  fontFamily: 'inherit',
  resize: 'vertical',
  outline: 'none',
  background: '#fff',
  boxSizing: 'border-box',
};

const inputStyle: React.CSSProperties = {
  padding: '6px 8px',
  border: '1px solid #cbd5e1',
  borderRadius: 6,
  fontSize: 13,
  outline: 'none',
  background: '#fff',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  width: '100%',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontWeight: 600,
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: 0.3,
  margin: '8px 0 3px',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  flexWrap: 'wrap',
};

const fieldStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 110,
};

const cardStyle: React.CSSProperties = {
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  padding: '10px 14px 12px',
  margin: '8px 0',
  background: '#fafafa',
};

const cardTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#0f172a',
  marginBottom: 2,
};

const warnStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#9a3412',
  background: '#fff7ed',
  border: '1px solid #fed7aa',
  borderRadius: 6,
  padding: '6px 8px',
  margin: '6px 0',
};

const checkRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 6,
  fontSize: 12,
  color: '#0f172a',
  marginTop: 8,
  cursor: 'pointer',
};

const userLineStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#0f172a',
  background: '#f1f5f9',
  borderRadius: 8,
  padding: '6px 10px',
  margin: '6px 0',
  whiteSpace: 'pre-wrap',
};

const aiLineStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#1e293b',
  padding: '4px 2px',
  margin: '4px 0',
  whiteSpace: 'pre-wrap',
};

const sysLineStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#15803d',
  padding: '4px 2px',
  margin: '4px 0',
};

const chipStyle: React.CSSProperties = {
  padding: '3px 10px',
  borderRadius: 999,
  border: '1px solid #cbd5e1',
  background: '#fff',
  fontSize: 12,
  color: '#334155',
  cursor: 'pointer',
};

const chipActiveStyle: React.CSSProperties = {
  ...chipStyle,
  background: '#3b82f6',
  borderColor: '#3b82f6',
  color: '#fff',
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '7px 16px',
  background: '#3b82f6',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '7px 16px',
  background: '#f1f5f9',
  color: '#475569',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  fontSize: 13,
  cursor: 'pointer',
};

const closeBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  fontSize: 20,
  color: '#94a3b8',
  cursor: 'pointer',
  padding: '0 4px',
  lineHeight: 1,
};
