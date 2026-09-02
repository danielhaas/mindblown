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
 * "Start → N" values for the same map — see PR #356 review round 1).
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
 *
 * Start/Stop/Apply deliberately do NOT depend on that fetch succeeding —
 * see the `hasWorkflow`/`snapshot` split below (round 2 review: a failed
 * node fetch used to take the buttons down with it).
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
  // of a fresh cancellation closure per call site.
  //
  // The setup body MUST also set `current = true`, not just the initial
  // `useRef(true)`: in dev, <StrictMode> (main.tsx, mobile branch
  // included) runs setup → cleanup → setup on mount. `useRef` survives
  // that simulated remount, so with only a cleanup here the ref would be
  // flipped to `false` by the first (discarded) cleanup and NEVER flipped
  // back — every guarded setState below goes permanently dead and the tab
  // is stuck on "Loading…" for the rest of the session (round 2 review).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [snapshotNodes, setSnapshotNodes] = useState<Node[] | null>(null);
  const [nodesError, setNodesError] = useState<string | null>(null);
  const [events, setEvents] = useState<ChangeEvent[]>([]);
  const [members, setMembers] = useState<MapMember[]>([]);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [capDraft, setCapDraft] = useState<string>(String(map.maxActiveClaims));
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // This view's own un-omitted node fetch, for the snapshot ONLY — see the
  // file-level comment on why it cannot reuse MobileViewer's stripped
  // `detail.nodes`. Deliberately NOT re-run from `write()` below: a cap
  // write changes `cap`, which arrives from the PARENT's refresh
  // (`onChanged()` → the `map` prop), not from the node set, which the
  // write leaves unchanged — re-downloading the heaviest payload in the
  // app after every Start/Stop/Apply would pay for a snapshot input that
  // never moved (round 2 review). Runs on mount and on the manual ↻ below.
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

  const loadMembers = useCallback(() => {
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

  useEffect(() => loadNodes(), [loadNodes]);
  useEffect(() => loadAudit(), [loadAudit]);
  useEffect(() => loadMembers(), [loadMembers]);

  // Reset the fine-tune draft only when the SAVED cap changes underneath —
  // our own write echoing back through onChanged(), or someone else's.
  useEffect(() => setCapDraft(String(map.maxActiveClaims)), [map.maxActiveClaims]);

  const writes = useMemo(() => lastKnobWrites(events, members), [events, members]);
  // Null when the audit window came back FULL without ever seeing a
  // non-zero cap (truncated) OR when the audit fetch itself failed
  // (`auditError` set — pass `null` events, not `[]`: an errored fetch is
  // not the same as a fetch that succeeded and came back empty). Either
  // way the Start button disables rather than guessing (see `startCap`'s
  // doc comment in dispatch.ts; round 2 review closed the fetch-failure
  // gap).
  const startCapValue = useMemo(
    () => startCap(auditError ? null : events, { limit: AUDIT_LIMIT }),
    [events, auditError],
  );

  // Buttons + header read `cap`/`gate` from the PARENT's `map` prop, NOT
  // from this view's own `fetchMap` response above — even though that
  // response carries a self-consistent `{ map, nodes }` pair. `onChanged`
  // (called after every write, in `write()` below) keeps the parent's
  // `map` at least as fresh, and sourcing cap/gate/header from ONE place
  // means there is only ever one idea of "the current cap" on screen
  // instead of mixing two differently-timed server snapshots. The own
  // fetch above exists purely to get an un-omitted NODE LIST for the
  // snapshot math (see the file-level comment) — its `map` half is
  // intentionally discarded (round 2 review).
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

  const write = async (action: 'start' | 'stop' | 'apply', maxActiveClaims: number) => {
    setBusyAction(action);
    setSaveError(null);
    try {
      await api.updateMap(mapId, { maxActiveClaims });
      onChanged();
      loadAudit();
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
  // Start/Stop/Apply need only `cap` (from the parent `map`, above) — NOT
  // `snapshot`. A failed or still-loading node fetch degrades the pill
  // and counts below to an "Unknown"/"Loading…" state, but must never
  // take the one function this tab exists for — "stop the fleet from my
  // phone" — down with it.
  const state = snapshot ? STATE_WORD[snapshot.state] : null;
  const last = writes.maxActiveClaims;

  return (
    <div className="mb-body">
      <div className="mb-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="mb-card-title">Fleet</div>
          <button
            className="mb-view-refresh"
            style={{ fontSize: 16, padding: '0 4px', minHeight: 32 }}
            aria-label="Reload queue snapshot"
            title="Reload the queue snapshot (node list) — cap/gate follow the map automatically"
            onClick={() => loadNodes()}
          >
            ↻
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          {state ? (
            <span className="mb-status-pill" style={{ background: state.bg, color: state.color }} title={state.hint}>
              {state.label}
            </span>
          ) : (
            <span
              className="mb-status-pill mb-status-pill-empty"
              title={nodesError ? `Queue snapshot unavailable (${nodesError}) — Start/Stop still work.` : 'Loading the queue snapshot…'}
            >
              {nodesError ? 'Unknown' : 'Loading…'}
            </span>
          )}
          {snapshot ? (
            <>
              <span style={{ fontSize: 14, color: '#334155' }}>
                <strong>{snapshot.activeClaims}</strong> active / cap <strong>{cap}</strong>
              </span>
              <span style={{ fontSize: 13, color: '#64748b' }}>
                · <strong>{snapshot.inGate}</strong> grantable in gate
              </span>
            </>
          ) : (
            <span style={{ fontSize: 14, color: '#334155' }}>
              cap <strong>{cap}</strong>
            </span>
          )}
        </div>
        {nodesError && (
          <div style={{ fontSize: 11, color: '#b45309', marginTop: 4 }}>
            Queue snapshot unavailable ({nodesError}) — active/grantable counts are unknown, but Start/Stop below still write the cap.
          </div>
        )}

        {saveError && <div className="mb-error" style={{ marginTop: 10 }}>{saveError}</div>}

        <div style={{ marginTop: 14 }}>
          {cap === 0 ? (
            <button
              className="mb-btn-primary"
              style={{ width: '100%' }}
              disabled={busy || startCapValue === null}
              title={
                startCapValue !== null
                  ? `Cap → ${startCapValue}: satellites follow within ~2 min`
                  : auditError
                    ? 'Audit trail unavailable — type a cap below.'
                    : 'Audit trail truncated before any non-zero cap — type a cap below.'
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
            Audit trail unavailable ({auditError}) — the "last write" line is missing and Start disables until it recovers; Stop and the number input still work.
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
