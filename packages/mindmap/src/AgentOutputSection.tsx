/**
 * Agent output (#585): the last lines of the fleet worker's live view for
 * a ticket an agent runs on right now — what `tmux attach -t fleet` shows,
 * without a terminal.
 *
 * The worker sends the tail with its rollup about every 2 min; the
 * regular fleet reads leave it out, so this asks its own route (edit on
 * the map — the lines carry commands, paths and error snippets). Loaded
 * once when the ticket opens; Refresh asks again.
 *
 * Shown only while the fleet reports an agent on the ticket and the viewer
 * may edit the map.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentOutput } from '@mindblown/core';
import * as api from './api.js';
import { useCanEditMap } from './useCanEditMap.js';
import type { CardPhase } from './useTicketPhases.js';

interface Props {
  mapId: string;
  nodeId: string;
  /** The ticket's fleet phase (useTicketPhases); nothing without a running agent. */
  phase: Pick<CardPhase, 'agentRunning'> | null | undefined;
}

export function AgentOutputSection(props: Props) {
  if (!props.phase?.agentRunning) return null;
  return <Output mapId={props.mapId} nodeId={props.nodeId} />;
}

function formatReportTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function Output({ mapId, nodeId }: { mapId: string; nodeId: string }) {
  const canEdit = useCanEditMap();
  const [output, setOutput] = useState<AgentOutput | null>(null);
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const pre = useRef<HTMLPreElement>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setState('loading');
    api
      .fetchAgentOutput(mapId, nodeId)
      .then((res) => {
        if (cancelled) return;
        setOutput(res.output);
        setState('loaded');
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [mapId, nodeId]);

  useEffect(() => {
    setOutput(null);
    if (!canEdit) return;
    return load();
  }, [canEdit, load]);

  // The newest line is the interesting one: start at the bottom.
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [output]);

  if (!canEdit) return null;

  return (
    <div data-testid="agent-output" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Agent output
        </span>
        {output && (
          <span style={{ fontSize: 11, color: '#94a3b8' }} title={`${output.at} · ${output.host}`}>
            as of {formatReportTime(output.at)}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="agent-output-refresh"
          onClick={() => load()}
          disabled={state === 'loading'}
          style={{
            fontSize: 11,
            padding: '1px 8px',
            borderRadius: 4,
            border: '1px solid #cbd5e1',
            background: '#ffffff',
            color: '#475569',
            cursor: state === 'loading' ? 'default' : 'pointer',
          }}
        >
          {state === 'loading' ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {state === 'failed' && <div style={{ fontSize: 12, color: '#94a3b8' }}>Output unavailable</div>}
      {state === 'loaded' && !output && (
        <div style={{ fontSize: 12, color: '#94a3b8' }}>No output reported yet — the worker sends it about every 2 minutes.</div>
      )}
      {output && (
        <pre
          ref={pre}
          style={{
            margin: 0,
            maxHeight: 280,
            overflow: 'auto',
            padding: 8,
            borderRadius: 6,
            background: '#0f172a',
            color: '#e2e8f0',
            fontSize: 11,
            lineHeight: 1.4,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {output.lines.join('\n')}
        </pre>
      )}
    </div>
  );
}
