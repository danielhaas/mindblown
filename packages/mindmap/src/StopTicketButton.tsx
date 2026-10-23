/**
 * Stop for a ticket a fleet worker is running right now (#549).
 *
 * Stop writes a blocker — "Stopped by <name>: <reason>" — and nothing else.
 * The worker reads the ticket about once a minute while its agent runs and
 * stops the agent when a blocker appears (claude-fleet#92): the claim is
 * released, the partial work is discarded, the blocker stays. Clearing the
 * blocker requeues the ticket with the description as it is then — so
 * Stop → edit the description → Unblock is how a running ticket changes
 * course. A fix run on an open PR just stops; the PR stays open.
 * MCP agents do the same with `flag_blocker`.
 *
 * Shown only while the fleet reports an agent on the ticket and the viewer
 * may edit the map; after the click, "Stopping…" until the worker lets go.
 */
import { useState, type CSSProperties } from 'react';
import { stopBlockerReason } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import { useCanEditMap } from './useCanEditMap.js';
import type { CardPhase } from './useTicketPhases.js';

const PROMPT =
  'Stop this ticket?\n\n' +
  'The fleet worker stops its agent within about a minute. ' +
  'If it was coding the ticket, the partial work is discarded; to run it again, edit the description and clear the blocker. ' +
  'If it was fixing an open PR, the fix stops and the PR stays open.\n\n' +
  'Reason (optional):';

/** Confirm and ask for a reason; the blocker text to write, or null when cancelled. Mobile uses it too. */
export function promptStop(user: { name?: string | null; email?: string | null } | null): string | null {
  const reason = window.prompt(PROMPT, '');
  return reason === null ? null : stopBlockerReason(user?.name || user?.email || '', reason);
}

const buttonStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  padding: '1px 6px',
  borderRadius: 4,
  border: '1px solid #fca5a5',
  background: '#fef2f2',
  color: '#b91c1c',
  cursor: 'pointer',
  lineHeight: 1.4,
};

const pendingStyle: CSSProperties = { fontSize: 10, fontWeight: 600, color: '#b91c1c' };

interface Props {
  nodeId: string;
  /** The ticket's fleet phase (useTicketPhases); no button without a running agent. */
  phase: Pick<CardPhase, 'agentRunning'> | null | undefined;
  style?: CSSProperties;
}

export function StopTicketButton(props: Props) {
  // Most cards have no agent: return before the hooks below, so a board of
  // 200 cards doesn't mount 200 member lookups.
  if (!props.phase?.agentRunning) return null;
  return <RunningStop {...props} />;
}

function RunningStop({ nodeId, style }: Props) {
  const canEdit = useCanEditMap();
  const blockedReason = useMindmapStore((s) => s.nodes[nodeId]?.blockedReason ?? null);
  const user = useMindmapStore((s) => s.user);
  const stopFleetTicket = useMindmapStore((s) => s.stopFleetTicket);
  const [busy, setBusy] = useState(false);

  if (!canEdit) return null;
  if ((blockedReason ?? '').trim() || busy) {
    return (
      <span data-testid="stop-ticket-pending" title={blockedReason ?? undefined} style={{ ...pendingStyle, ...style }}>
        Stopping…
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="stop-ticket"
      title="Stop the fleet worker's agent on this ticket"
      style={{ ...buttonStyle, ...style }}
      onClick={async (e) => {
        // Inside a clickable card: Stop must not also select or open it.
        e.stopPropagation();
        const blocker = promptStop(user);
        if (blocker === null) return;
        setBusy(true);
        await stopFleetTicket(nodeId, blocker);
        setBusy(false);
      }}
    >
      Stop
    </button>
  );
}
