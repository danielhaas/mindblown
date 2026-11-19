/**
 * Note to the agent (claude-fleet#92): while a fleet worker holds the claim
 * on a ticket — its agent is coding, or the PR is open before the merge — a
 * person can write the agent a note instead of stopping it. The note is a
 * comment of kind 'fleet-note'; the worker polls for them about once a
 * minute, stops its agent, keeps the branch and continues with the note in
 * the brief, then marks the note picked up.
 *
 * Shown only while the fleet reports a phase for the ticket (= a claim is
 * held) and the viewer may edit the map. The detail panel gets the box and
 * the notes with "sent / picked up at HH:MM"; the Kanban card a Note button.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import * as api from './api.js';
import type { Comment } from './api.js';
import { useMindmapStore } from './store.js';
import { useCanEditMap } from './useCanEditMap.js';
import type { CardPhase } from './useTicketPhases.js';

export function noteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** "sent 10:02" / "picked up at 10:03" — the note's delivery state. */
export function noteStatus(c: Pick<Comment, 'createdAt' | 'deliveredAt'>): string {
  return c.deliveredAt ? `picked up at ${noteTime(c.deliveredAt)}` : `sent ${noteTime(c.createdAt)}`;
}

interface Props {
  mapId: string;
  nodeId: string;
  /** The ticket's fleet phase (useTicketPhases); a phase = a worker holds the claim. */
  phase: CardPhase | null | undefined;
}

export function NoteToAgentSection(props: Props) {
  if (!props.phase) return null;
  return <NoteBox mapId={props.mapId} nodeId={props.nodeId} />;
}

function NoteBox({ mapId, nodeId }: { mapId: string; nodeId: string }) {
  const canEdit = useCanEditMap();
  const [notes, setNotes] = useState<Comment[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upsert = useCallback((c: Comment) => {
    if (c.kind !== 'fleet-note') return;
    setNotes((prev) => (prev.some((n) => n.id === c.id) ? prev.map((n) => (n.id === c.id ? { ...n, ...c, userName: c.userName ?? n.userName } : n)) : [...prev, c]));
  }, []);

  useEffect(() => {
    if (!canEdit) return;
    let alive = true;
    api
      .fetchComments(mapId, nodeId, 'fleet-note')
      .then((rows) => alive && setNotes(rows.filter((c) => c.kind === 'fleet-note')))
      .catch(() => {});
    // The worker's "picked up" arrives as comment:updated.
    const onWs = (e: Event) => {
      const msg = (e as CustomEvent).detail;
      if (msg?.nodeId !== nodeId || !msg.comment) return;
      if (msg.type === 'comment:created' || msg.type === 'comment:updated') upsert(msg.comment);
    };
    window.addEventListener('ws:comment', onWs);
    return () => {
      alive = false;
      window.removeEventListener('ws:comment', onWs);
    };
  }, [mapId, nodeId, canEdit, upsert]);

  if (!canEdit) return null;

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setError(null);
    try {
      upsert(await api.createComment(mapId, nodeId, t, 'fleet-note'));
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the note');
    } finally {
      setSending(false);
    }
  };

  return (
    <div data-testid="note-to-agent" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Note to the agent
      </div>
      {notes.map((n) => (
        <div key={n.id} data-testid="note-to-agent-item" style={noteStyle}>
          <div style={{ fontSize: 10, color: '#6d28d9', marginBottom: 2 }}>
            {n.userName ?? 'You'} · <span data-testid="note-to-agent-status">{noteStatus(n)}</span>
          </div>
          <div style={{ fontSize: 12, color: '#334155', whiteSpace: 'pre-wrap' }}>{n.text}</div>
        </div>
      ))}
      <textarea
        data-testid="note-to-agent-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        rows={2}
        placeholder="Tell the agent what to change — it continues on its branch with your note"
        style={{ padding: '6px 8px', border: '1px solid #ddd6fe', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', resize: 'vertical' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" data-testid="note-to-agent-send" disabled={!text.trim() || sending} onClick={send} style={sendStyle}>
          {sending ? 'Sending…' : 'Send to agent'}
        </button>
        {error && <span style={{ fontSize: 11, color: '#b91c1c' }}>{error}</span>}
      </div>
    </div>
  );
}

const noteStyle: CSSProperties = { padding: '6px 8px', background: '#f5f3ff', border: '1px solid #ede9fe', borderRadius: 6 };
const sendStyle: CSSProperties = {
  alignSelf: 'flex-start',
  fontSize: 11,
  fontWeight: 600,
  padding: '4px 10px',
  borderRadius: 4,
  border: '1px solid #c4b5fd',
  background: '#ede9fe',
  color: '#5b21b6',
  cursor: 'pointer',
};

const buttonStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  padding: '1px 6px',
  borderRadius: 4,
  border: '1px solid #c4b5fd',
  background: '#f5f3ff',
  color: '#5b21b6',
  cursor: 'pointer',
  lineHeight: 1.4,
};

/** The Kanban card's Note button — asks for the text and posts the note. */
export function NoteToAgentButton(props: { nodeId: string; phase: CardPhase | null | undefined; style?: CSSProperties }) {
  // Most cards have no claim: return before the hooks below.
  if (!props.phase) return null;
  return <CardNote {...props} />;
}

function CardNote({ nodeId, style }: { nodeId: string; style?: CSSProperties }) {
  const canEdit = useCanEditMap();
  const mapId = useMindmapStore((s) => s.currentMapId);
  const [sentAt, setSentAt] = useState<string | null>(null);
  if (!canEdit || !mapId) return null;
  return (
    <button
      type="button"
      data-testid="note-to-agent-card"
      title={sentAt ? `Note sent ${noteTime(sentAt)} — open the ticket to see when the agent picks it up` : 'Write the fleet agent a note — it continues on its branch with it'}
      style={{ ...buttonStyle, ...style }}
      onClick={async (e) => {
        // Inside a clickable card: the note must not also open it.
        e.stopPropagation();
        const text = window.prompt('Note to the agent working this ticket:\n\nIt continues on its branch with your note added to the brief.', '');
        if (!text?.trim()) return;
        try {
          const c = await api.createComment(mapId, nodeId, text.trim(), 'fleet-note');
          setSentAt(c.createdAt);
        } catch (err) {
          window.alert(err instanceof Error ? err.message : 'Could not send the note');
        }
      }}
    >
      {sentAt ? 'Note sent' : 'Note'}
    </button>
  );
}
