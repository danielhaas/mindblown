/**
 * "Needs you" at the top of a ticket's detail view (#610) — the desktop
 * PropertyPanel and the phone's node sheet, opened from a Kanban card.
 *
 * Whatever puts the "Needs you" / "Blocked" / "Needs brief" badge on the
 * card (kanban.ts `nodeWaits`, the badge's own rules) is shown here with
 * the action that resolves it, so nobody has to hunt for the ticket on the
 * Fleet tab:
 *   - waiting for approval → the Fleet tab's ApprovalRow (#494);
 *   - an open question on the ticket → the Questions card's AskCard, the
 *     same answer_ask path (#401);
 *   - a manual blocker → the reason and Unblock;
 *   - no brief → a field whose text becomes the description (#580);
 *   - any other hold → the reason, and where it is resolved.
 * Nothing waiting → nothing rendered.
 *
 * The server rules are the Fleet tab's: approve / reject only for a
 * trusted editor in a signed-in session (#494, #606) — the row says
 * `canApprove`. The card's badge follows through the usual `node:updated`
 * / `asks:updated` broadcasts; the phone, which has no socket, re-reads
 * the node through `onRefresh`.
 */
import React, { useEffect, useState } from 'react';
import { blockerAskNodeId, briefAskNodeId, derivedAskNodeId } from '@mindblown/core';
import type { AskRow, Node, NodeMap, PendingApproval, StatusDef } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import { ApprovalRow } from './ApprovalsView.js';
import { AskCard, answererName, rowKey, type AnswerResult } from './AsksView.js';
import { nodeWaits, nothingWaits } from './kanban.js';

export interface NeedsYouProps {
  mapId: string;
  /** The ticket; `description` / `externalLinks` undefined = not loaded (no brief check). */
  node: Node;
  /** The map's nodes, for a hold an open parent carries. */
  nodes: Node[] | NodeMap;
  workflow: StatusDef[];
  mobile?: boolean;
  /** Clear the blocker (clear_blocker). Resolves true when it went through. */
  onUnblock: () => Promise<boolean>;
  /** Save the brief as the description. Resolves true when it went through. */
  onSaveBrief: (text: string) => Promise<boolean>;
  /** Re-read the node after an approval decision — the phone has no `node:updated`. */
  onRefresh?: () => void;
  /** Open another node (the parent that holds this one). */
  onOpenNode?: (id: string) => void;
  /** Go to where the rest is resolved (the Fleet tab). */
  onOpenFleet?: () => void;
}

/** An open question on this ticket — not the blocker / brief rows, which get their own buttons here. */
export function isQuestionFor(row: AskRow, nodeId: string): boolean {
  if (row.status !== 'open') return false;
  const id = row.ask.id;
  if (blockerAskNodeId(id) !== null || briefAskNodeId(id) !== null) return false;
  return row.ask.unblocks.node_id === nodeId || derivedAskNodeId(id) === nodeId;
}

export function NeedsYouSection(props: NeedsYouProps) {
  const { mapId, node, nodes, workflow, mobile = false } = props;
  const asksRev = useMindmapStore((s) => s.asksRev);
  const viewRole = useMindmapStore((s) => s.viewRole);
  const user = useMindmapStore((s) => s.user);
  const readOnly = viewRole === 'stakeholder';
  const waits = nodeWaits(node, nodes, workflow);

  // ── Open questions: the asks inbox, this ticket's rows ──
  const [asks, setAsks] = useState<AskRow[]>([]);
  const [results, setResults] = useState<Record<string, AnswerResult>>({});
  useEffect(() => {
    let live = true;
    // An older server or no access: no questions, the rest of the section stands.
    api.fetchAsks({ mapId }, { status: 'open' }).then(
      (r) => live && setAsks(r.items.filter((x) => isQuestionFor(x, node.id))),
      () => live && setAsks([]),
    );
    return () => {
      live = false;
    };
  }, [mapId, node.id, asksRev]);
  // An answered row stays where it was clicked, with what was written —
  // the refetch after asks:updated no longer lists it as open.
  const [answered, setAnswered] = useState<Record<string, AskRow>>({});
  const questions = [...asks, ...Object.values(answered).filter((r) => !asks.some((a) => rowKey(a) === rowKey(r)))];

  // ── Approval: the Fleet tab's row for this ticket ──
  const [approval, setApproval] = useState<PendingApproval | null | 'loading'>(null);
  const [approvalPoll, setApprovalPoll] = useState(0);
  const [decided, setDecided] = useState<string | null>(null);
  useEffect(() => {
    if (!waits.approval) {
      setApproval(null);
      return;
    }
    let live = true;
    setApproval((a) => a ?? 'loading');
    api.fetchApprovals({ mapId }).then(
      (r) => live && setApproval(r.items.find((x) => x.nodeId === node.id) ?? null),
      () => live && setApproval(null),
    );
    return () => {
      live = false;
    };
  }, [mapId, node.id, waits.approval, asksRev, approvalPoll, node.approval?.at]);

  if (nothingWaits(waits) && questions.length === 0 && decided === null) return null;

  const by = answererName(user);
  return (
    <div data-testid="needs-you" style={box(mobile)}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Needs you</div>

      {decided && (
        <div data-testid="needs-you-decided" style={{ fontSize: 13, color: '#166534', marginTop: 6, overflowWrap: 'anywhere' }}>
          {decided}
        </div>
      )}

      {waits.approval && !decided && (
        <div data-testid="needs-you-approval" style={{ marginTop: 4 }}>
          <Label>Waiting for approval — the fleet runs it only after a yes</Label>
          {approval === 'loading' ? (
            <Muted>Loading…</Muted>
          ) : approval ? (
            <ApprovalRow
              row={approval}
              project={null}
              readOnly={readOnly || !approval.canApprove}
              mobile={mobile}
              onDone={(line) => {
                setDecided(line);
                props.onRefresh?.();
              }}
              onStale={() => setApprovalPoll((t) => t + 1)}
            />
          ) : (
            <Muted>Not in this map's approval list for you — decide it on the Fleet tab.</Muted>
          )}
        </div>
      )}

      {questions.map((r) => (
        <div key={rowKey(r)} data-testid="needs-you-question" style={{ marginTop: 8 }}>
          <AskCard
            row={r}
            mapId={mapId}
            scope={null}
            by={by}
            readOnly={readOnly}
            result={results[rowKey(r)] ?? null}
            onResult={(id, res) => {
              setResults((m) => ({ ...m, [id]: res }));
              setAnswered((m) => ({ ...m, [id]: r }));
            }}
          />
        </div>
      ))}

      {waits.blocked !== null && <BlockedRow reason={waits.blocked} readOnly={readOnly} onUnblock={props.onUnblock} />}

      {waits.brief && <BriefRow readOnly={readOnly} mobile={mobile} onSave={props.onSaveBrief} />}

      {waits.other && (
        <div data-testid="needs-you-other" style={{ marginTop: 8 }}>
          <div style={{ fontSize: 13, color: '#78350f', overflowWrap: 'anywhere' }}>{waits.other.detail}</div>
          {waits.other.heldBy && props.onOpenNode ? (
            <button type="button" style={linkBtn} onClick={() => props.onOpenNode!(waits.other!.heldBy!.id)}>
              Open “{waits.other.heldBy.text}” — it is resolved there
            </button>
          ) : questions.length === 0 && props.onOpenFleet ? (
            <button type="button" style={linkBtn} onClick={props.onOpenFleet}>
              Resolve it on the Fleet tab (Your steps)
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function BlockedRow({ reason, readOnly, onUnblock }: { reason: string; readOnly: boolean; onUnblock: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div data-testid="needs-you-blocked" style={{ marginTop: 8 }}>
      <Label>Blocked</Label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 160px', minWidth: 0, fontSize: 13, color: '#b91c1c', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {reason || 'Marked blocked (tag or status), no reason given'}
        </div>
        {!readOnly && (
          <button
            type="button"
            data-testid="needs-you-unblock"
            disabled={busy}
            style={btn('primary', busy)}
            title="Clears the reason and the blocked tag and puts the ticket back in the queue"
            onClick={async () => {
              setBusy(true);
              await onUnblock();
              setBusy(false);
            }}
          >
            {busy ? 'Unblocking…' : 'Unblock'}
          </button>
        )}
      </div>
    </div>
  );
}

function BriefRow({ readOnly, mobile, onSave }: { readOnly: boolean; mobile: boolean; onSave: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div data-testid="needs-you-brief" style={{ marginTop: 8 }}>
      <Label>Needs a brief — the fleet will not take it without one</Label>
      {readOnly ? (
        <Muted>No description, no linked issue and a short title.</Muted>
      ) : (
        <>
          <textarea
            data-testid="needs-you-brief-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            rows={mobile ? 4 : 3}
            placeholder="Write the brief — what is to be done…"
            aria-label="Brief"
            style={field}
          />
          <div style={{ marginTop: 6 }}>
            <button
              type="button"
              data-testid="needs-you-brief-save"
              disabled={busy || !text.trim()}
              style={btn('primary', busy || !text.trim())}
              onClick={async () => {
                setBusy(true);
                if (await onSave(text.trim())) setText('');
                setBusy(false);
              }}
            >
              Save as description
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, fontWeight: 600, color: '#92400e', marginBottom: 2 }}>{children}</div>;
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: '#64748b' }}>{children}</div>;
}

const box = (mobile: boolean): React.CSSProperties => ({
  background: '#fffbeb',
  border: '1px solid #fcd34d',
  borderRadius: 8,
  padding: mobile ? '10px 12px' : '10px 12px',
  minWidth: 0,
  maxWidth: '100%',
  boxSizing: 'border-box',
  overflowWrap: 'anywhere',
});

const field: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  fontSize: 13,
  padding: 6,
  border: '1px solid #cbd5e1',
  borderRadius: 6,
  fontFamily: 'inherit',
};

const linkBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  marginTop: 4,
  color: '#2563eb',
  cursor: 'pointer',
  fontSize: 12,
  textAlign: 'left',
};

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
