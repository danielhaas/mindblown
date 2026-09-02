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
 * (`STATE_WORD`, `startCap`, `lastKnobWrites`, `formatAge`,
 * `formatKnobValue`) come from `dispatch.ts` — the same helpers
 * `DispatchCards.tsx` uses, so the two surfaces never drift.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MindMap, Version } from '@mindblown/core';
import { dispatchQueueSnapshot } from '@mindblown/core';
import type { NodeWithComputed, ChangeEvent, MapMember } from '../api.js';
import * as api from '../api.js';
import {
  STATE_WORD,
  formatAge,
  formatKnobValue,
  lastKnobWrites,
  startCap,
} from '../dispatch.js';

const AUDIT_LIMIT = 40;

interface Props {
  mapId: string;
  map: MindMap;
  nodes: NodeWithComputed[];
  versions: Version[];
  /** Called after a successful write so the caller reloads the map detail —
   *  the header ("4 active / cap 9") must show the server value, not an
   *  optimistic guess. */
  onChanged: () => void;
}

export function MobileFleetView({ mapId, map, nodes, versions, onChanged }: Props) {
  const [events, setEvents] = useState<ChangeEvent[]>([]);
  const [members, setMembers] = useState<MapMember[]>([]);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [capDraft, setCapDraft] = useState<string>(String(map.maxActiveClaims));
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadAudit = useCallback(() => {
    let cancelled = false;
    api
      .fetchChangeHistory(mapId, { eventType: 'map.field_changed', limit: AUDIT_LIMIT })
      .then((r) => {
        if (!cancelled) {
          setEvents(r.events);
          setAuditError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setAuditError(e instanceof Error ? e.message : 'unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [mapId]);

  useEffect(() => loadAudit(), [loadAudit]);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchMapMembers(mapId)
      .then((r) => {
        if (!cancelled) setMembers(r.members);
      })
      .catch(() => {
        // "last write" falls back to "API key / system" without names —
        // not worth failing the tab over.
      });
    return () => {
      cancelled = true;
    };
  }, [mapId]);

  // Reset the fine-tune draft only when the SAVED cap changes underneath —
  // our own write echoing back through onChanged(), or someone else's.
  useEffect(() => setCapDraft(String(map.maxActiveClaims)), [map.maxActiveClaims]);

  const writes = useMemo(() => lastKnobWrites(events, members), [events, members]);
  const startCapValue = useMemo(() => startCap(events), [events]);

  const cap = map.maxActiveClaims;
  const snapshot = useMemo(
    () =>
      map.statusWorkflow
        ? dispatchQueueSnapshot(nodes, { workflow: map.statusWorkflow, cap, gate: map.dispatchGate })
        : null,
    [nodes, map.statusWorkflow, cap, map.dispatchGate],
  );

  if (!map.statusWorkflow || !snapshot) {
    return (
      <div className="mb-body">
        <div className="mb-card">
          <div className="mb-card-title">Fleet</div>
          <div className="mb-card-meta">This map has no status workflow — there is no pull queue to steer.</div>
        </div>
      </div>
    );
  }

  const write = async (maxActiveClaims: number) => {
    setBusy(true);
    setSaveError(null);
    try {
      await api.updateMap(mapId, { maxActiveClaims });
      onChanged();
      loadAudit();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed — the value shown is what the server still has.');
    } finally {
      setBusy(false);
    }
  };

  const capNumber = Number(capDraft);
  const capValid = Number.isInteger(capNumber) && capNumber >= 0;
  const capDirty = capValid && capNumber !== cap;
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
              disabled={busy}
              title={`Cap → ${startCapValue}: satellites follow within ~2 min`}
              onClick={() => void write(startCapValue)}
            >
              {busy ? 'Starting…' : `Start → ${startCapValue}`}
            </button>
          ) : (
            <button
              className="mb-btn-secondary"
              style={{ width: '100%' }}
              disabled={busy}
              title="Cap → 0: the fleet drains, in-flight tickets finish"
              onClick={() => void write(0)}
            >
              {busy ? 'Stopping…' : 'Stop'}
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
            onClick={() => void write(capNumber)}
          >
            {busy ? 'Saving…' : 'Apply'}
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
