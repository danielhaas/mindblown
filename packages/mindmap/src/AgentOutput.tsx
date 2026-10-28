/**
 * The fleet agent's last output for a ticket (#585): the last lines of the
 * worker's live view, as its last status push carried them. The worker
 * pushes about every 2 minutes, so the lines can be that old; the header
 * says when they were reported, and Refresh asks again right away.
 *
 * Shown while an agent runs on the ticket (set up, coding, fixing — the
 * worker sends a tail only then) and the viewer may edit the map: the
 * lines carry the agent's commands, paths and error snippets, and the
 * server's tail route needs edit too.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import * as api from './api.js';
import { useCanEditMap } from './useCanEditMap.js';
import { useMindmapStore } from './store.js';
import type { CardPhase } from './useTicketPhases.js';

/** Same pace as the phase chip's poll; the worker itself reports every ~2 min. */
const REFRESH_MS = 60_000;

const boxStyle: CSSProperties = {
  margin: 0,
  maxHeight: 260,
  overflow: 'auto',
  padding: '6px 8px',
  background: '#0f172a',
  color: '#e2e8f0',
  borderRadius: 6,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10.5,
  lineHeight: 1.45,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const refreshStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  padding: '1px 6px',
  borderRadius: 4,
  border: '1px solid #cbd5e1',
  background: '#f8fafc',
  color: '#334155',
  cursor: 'pointer',
};

interface Props {
  nodeId: string;
  /** The ticket's fleet phase (useTicketPhases); nothing without a running agent. */
  phase: Pick<CardPhase, 'agentRunning'> | null | undefined;
}

export function AgentOutput(props: Props) {
  if (!props.phase?.agentRunning) return null;
  return <Tail {...props} />;
}

function Tail({ nodeId }: Props) {
  const canEdit = useCanEditMap();
  const mapId = useMindmapStore((s) => s.currentMapId);
  const [tail, setTail] = useState<api.TicketTail | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const boxRef = useRef<HTMLPreElement>(null);

  const load = useCallback(() => {
    if (!mapId || !canEdit) return;
    setLoading(true);
    api
      .fetchTicketTail(mapId, nodeId)
      .then((r) => {
        setTail(r.tail);
        setFailed(false);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, [mapId, nodeId, canEdit]);

  useEffect(() => {
    setTail(undefined);
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // The newest line is what one looks for: keep the box scrolled to the end.
  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [tail]);

  if (!canEdit) return null;
  const at = tail ? new Date(tail.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null;
  return (
    <div data-testid="agent-output" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#64748b' }}>
        <span style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Agent output</span>
        <span style={{ flex: 1 }} title="The worker reports about every 2 minutes">
          {at ? `as of ${at} · ${tail!.host}` : ''}
        </span>
        <button type="button" data-testid="agent-output-refresh" onClick={load} disabled={loading} style={refreshStyle}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {failed ? (
        <div style={{ fontSize: 11, color: '#b91c1c' }}>Could not load the agent output.</div>
      ) : tail === undefined ? null : tail === null || tail.lines.length === 0 ? (
        <div style={{ fontSize: 11, color: '#94a3b8' }}>No output reported yet — the worker sends it about every 2 minutes.</div>
      ) : (
        <pre ref={boxRef} data-testid="agent-output-lines" style={boxStyle}>
          {tail.lines.join('\n')}
        </pre>
      )}
    </div>
  );
}
