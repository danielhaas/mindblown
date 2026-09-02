/**
 * Fleet tab — the phone's Leidang cockpit. The desktop Dispatch card
 * (`DispatchCards.tsx`) is a PM/operator-lens control; on mobile there is
 * no lens (`FleetView.tsx`'s own comment: the lens is a filter, not a
 * permission — the phone IS the operator's control surface), so this tab
 * always writes.
 *
 * Minimum viable control is the cap: a one-click Start/Stop that writes
 * `maxActiveClaims` immediately via `api.updateMap`, same semantics as the
 * desktop card's Start/Stop buttons (see `DispatchCards.tsx`). Gate and
 * policy are shown read-only (chips) — steering those stays a desktop/PM
 * action for now, per the ticket scope.
 *
 * `dispatchQueueSnapshot` (queue math) and the audit-trail helpers
 * (`STATE_WORD`, `AUDIT_LIMIT`, `startCap`, `lastKnobWrites`, `formatAge`,
 * `formatKnobValue`) come from `dispatch.ts` — the same helpers
 * `DispatchCards.tsx` uses, so the two surfaces never drift (a duplicated
 * `AUDIT_LIMIT` here used to make desktop and phone offer different
 * "Start → N" values for the same map — see PR #356 review).
 *
 * IMPORTANT: `MobileViewer.tsx` loads the map with `?omit=description,
 * externalLinks` to keep list/kanban/etc. light. `dispatchQueueSnapshot`'s
 * `hasBrief` predicate reads exactly those two fields (core's
 * `hasBrief(node)` does `node.externalLinks.some(...)`), so the stripped
 * payload either throws (`undefined.some`) or, with a naive null-guard,
 * makes every gated ticket look brief-less — the pill would read "Empty"
 * forever while the server keeps granting tickets. This view therefore
 * fetches its OWN un-omitted `fetchMap` for the snapshot instead of taking
 * `nodes` as a prop; the other mobile views keep the light payload.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MindMap, Node, Version } from '@mindblown/core';
import { dispatchQueueSnapshot } from '@mindblown/core';
import type { ChangeEvent, MapMember } from '../api.js';
import * as api from '../api.js';
import {
  AUDIT_LIMIT,
  STATE_WORD,
  formatAge,
  formatKnobValue,
  lastKnobWrites,
  startCap,
} from '../dispatch.js';

interface Props {
  mapId: string;
  map: MindMap;
  versions: Version[];
  /** Called after a successful write so the caller reloads the map detail —
   *  the header ("4 active / cap 9") must show the server value, not an
   *  optimistic guess. */
  onChanged: () => void;
}

type BusyAction = 'start' | 'stop' | 'apply' | null;

export function MobileFleetView({ mapId, map, versions, onChanged }: Props) {
  // Guards every async setState below against a tab switch mid-flight —
  // one flag shared by all three loaders (nodes, audit, members) instead
  // of a fresh cancellation closure per call site (a manual reload call
  // used to drop its own closure's guard; see PR #356 review).
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // This view's own un-omitted node fetch — see the file-level comment on
  // why it cannot reuse MobileViewer's stripped `detail.nodes`.
  const [snapshotNodes, setSnapshotNodes] = useState<Node[] | null>(null);
  const [nodesError, setNodesError] = useState<string | null>(null);
  const [events, setEvents] = useState<ChangeEvent[]>([]);
  const [members, setMembers] = useState<MapMember[]>([]);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [capDraft, setCapDraft] = useState<string>(String(map.maxActiveClaims));
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadNodes = useCallback(() => {
    api
      .fetchMap(mapId) // no `omit` — the snapshot needs description + externalLinks
      .then((d) => {
        if (mountedRef.current) {
          setSnapshotNodes(d.nodes);
          setNodesError(null);
        }
      })
      .catch((e: unknown) => {
        if (mountedRef.current) setNodesError(e instanceof Error ? e.message : 'unavailable');
      });
  }, [mapId]);

  const loadAudit = useCallback(() => {
    api
      .fetchChangeHistory(mapId, { eventType: 'map.field_changed', limit: AUDIT_LIMIT })
      .then((r) => {
        if (mountedRef.current) {
          setEvents(r.events);
          setAuditError(null);
        }
      })
      .catch((e: unknown) => {
        if (mountedRef.current) setAuditError(e instanceof Error ? e.message : 'unavailable');
      });
  }, [mapId]);

  useEffect(() => loadNodes(), [loadNodes]);
  useEffect(() => loadAudit(), [loadAudit]);

  useEffect(() => {
    api
      .fetchMapMembers(mapId)
      .then((r) => {
        if (mountedRef.current) setMembers(r.members);
      })
      .catch(() => {
        // "last write" falls back to "API key / system" without names —
        // not worth failing the tab over.
      });
  }, [mapId]);

  // Reset the fine-tune draft only when the SAVED cap changes underneath —
  // our own write echoing back through onChanged(), or someone else's.
  useEffect(() => setCapDraft(String(map.maxActiveClaims)), [map.maxActiveClaims]);

  const writes = useMemo(() => lastKnobWrites(events, members), [events, members]);
  // Null only when the audit window came back FULL without ever seeing a
  // non-zero cap — truncated, not "always on hold" (see `startCap`'s doc
  // comment in dispatch.ts).
  const startCapValue = useMemo(() => startCap(events, { limit: AUDIT_LIMIT }), [events]);

  const cap = map.maxActiveClaims;
  // `statusWorkflow` is a non-optional StatusDef[]; `.length === 0` is the
  // real "no workflow" check (an empty array is truthy) — same shape as
  // FleetView.tsx's desktop guard.
  const hasWorkflow = map.statusWorkflow.length > 0;
  const snapshot = useMemo(
    () =>
      hasWorkflow && snapshotNodes
        ? dispatchQueueSnapshot(snapshotNodes, { workflow: map.statusWorkflow, cap, gate: map.dispatchGate })
        : null,
    [hasWorkflow, snapshotNodes, map.statusWorkflow, cap, map.dispatchGate],
  );

  if (!hasWorkflow) {
    return (
      <div className="mb-body">
        <div className="mb-card">
          <div className="mb-card-title">Fleet</div>
          <div className="mb-card-meta">This map has no status workflow — there is no pull queue to steer.</div>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="mb-body">
        <div className="mb-card">
          <div className="mb-card-title">Fleet</div>
          {nodesError ? (
            <div className="mb-error">Could not load the queue ({nodesError}).</div>
          ) : (
            <div className="mb-card-meta">Loading fleet…</div>
          )}
        </div>
      </div>
    );
  }

  const write = async (action: 'start' | 'stop' | 'apply', maxActiveClaims: number) => {
    setBusyAction(action);
    setSaveError(null);
    try {
      await api.updateMap(mapId, { maxActiveClaims });
      onChanged();
      loadAudit();
      loadNodes();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed — the value shown is what the server still has.');
    } finally {
      setBusyAction(null);
    }
  };

  const capNumber = Number(capDraft);
  // capDraft.trim() !== '' guards Number('') === 0 — an emptied input must
  // be neither valid nor dirty, or clearing the box on a phone's numeric
  // keypad silently arms an Apply that writes maxActiveClaims: 0 (a full
  // fleet stop) the instant the field is empty.
  const capValid = capDraft.trim() !== '' && Number.isInteger(capNumber) && capNumber >= 0;
  const capDirty = capValid && capNumber !== cap;
  const busy = busyAction !== null;
  const state = STATE_WORD[snapshot.state];
  const last = writes.maxActiveClaims;

  return (
    <div className="mb-body">
      <div className="mb-card">
        <div className="mb-card-title">Fleet</div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          <span className="mb-status-pill" style={{ background: state.bg, color: state.color }} title={state.hint}>
            {state.label}
          </span>
          <span style={{ fontSize: 14, color: '#334155' }}>
            <strong>{snapshot.activeClaims}</strong> active / cap <strong>{cap}</strong>
          </span>
          <span style={{ fontSize: 13, color: '#64748b' }}>
            · <strong>{snapshot.inGate}</strong> grantable in gate
          </span>
        </div>

        {saveError && <div className="mb-error" style={{ marginTop: 10 }}>{saveError}</div>}

        <div style={{ marginTop: 14 }}>
          {cap === 0 ? (
            <button
              className="mb-btn-primary"
              style={{ width: '100%' }}
              disabled={busy || startCapValue === null}
              title={
                startCapValue === null
                  ? 'Audit trail truncated before any non-zero cap — type a cap below.'
                  : `Cap → ${startCapValue}: satellites follow within ~2 min`
              }
              onClick={() => startCapValue !== null && void write('start', startCapValue)}
            >
              {busyAction === 'start' ? 'Starting…' : startCapValue === null ? 'Start' : `Start → ${startCapValue}`}
            </button>
          ) : (
            <button
              className="mb-btn-secondary"
              style={{ width: '100%' }}
              disabled={busy}
              title="Cap → 0: the fleet drains, in-flight tickets finish"
              onClick={() => void write('stop', 0)}
            >
              {busyAction === 'stop' ? 'Stopping…' : 'Stop'}
            </button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <input
            type="number"
            min={0}
            max={99}
            value={capDraft}
            onChange={(e) => setCapDraft(e.target.value)}
            style={{ width: 72, fontSize: 16, padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: 8 }}
            aria-label="Claim cap"
          />
          <button
            className="mb-btn-secondary"
            style={{ flex: 1 }}
            disabled={!capDirty || busy}
            onClick={() => void write('apply', capNumber)}
          >
            {busyAction === 'apply' ? 'Saving…' : 'Apply'}
          </button>
        </div>
        {!capValid && <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>whole number ≥ 0</div>}

        <div style={{ fontSize: 12, color: '#64748b', marginTop: 12 }}>
          {last
            ? <>last: {formatKnobValue('maxActiveClaims', last.oldValue, versions)} → {formatKnobValue('maxActiveClaims', last.newValue, versions)} · {last.actor ?? 'API key / system'} · {formatAge(last.at, new Date())} ago</>
            : 'No knob write in the audit yet.'}
        </div>
        {auditError && (
          <div style={{ fontSize: 11, color: '#b45309', marginTop: 6 }}>
            Audit trail unavailable ({auditError}) — the "last write" line is missing, the buttons still work.
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 14 }}>
          <span className="mb-status-pill mb-status-pill-empty">Gate: {formatKnobValue('dispatchGate', map.dispatchGate, versions)}</span>
          <span className="mb-status-pill mb-status-pill-empty">Policy: {formatKnobValue('dispatchPolicy', map.dispatchPolicy, versions)}</span>
        </div>
      </div>
    </div>
  );
}
