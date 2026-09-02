/**
 * Cockpit cards for steering and watching the Leidang pull fleet.
 *
 * DispatchCard — the three map knobs the fleet obeys (cap / gate / policy)
 * with explicit Apply per knob: every write reaches the satellites within
 * ~2 min, so nothing saves on-change. Under each knob the last write from
 * the change_events audit ("who put us on hold on Friday?").
 *
 * FleetCard — what MindBlown itself knows about the fleet: the claims it
 * holds and the queue depth behind the gate. Worker states (parked,
 * limit-parked, prompt-blocked) live on the satellites and are NOT here;
 * that is the fleet-status push (separate PR).
 *
 * Gate and phase are a human's decision by design (Leidang Layer 5): the
 * orchestrator writes cap and policy autonomously, never the gate. This
 * card is where that human decision happens.
 *
 * `LeidangCards` is the entry point: it loads the audit trail once and
 * hands it to both cards.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Version } from '@mindblown/core';
import { dispatchQueueSnapshot, DISPATCH_POLICY_KEYS } from '@mindblown/core';
import type { DispatchQueueSnapshot, DispatchState } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { ChangeEvent } from './api.js';
import { Card, Link } from './DigestView.js';
import { FleetTelemetry } from './FleetTelemetry.js';
import {
  KNOB_LABEL,
  STALE_CLAIM_HOURS,
  GATE_BUGS_ONLY,
  PRESETS,
  applyPreset,
  claimRows,
  effectivePolicy,
  formatAge,
  formatKnobValue,
  gateChips,
  isKnownPolicyKey,
  lastKnobWrites,
  lastNonZeroCap,
  mixBugsRatio,
  movePolicyKey,
  newestKnobWrite,
  normalizePolicy,
  policyKeyLabel,
  setMixBugs,
  shortSession,
  toggleGateEntry,
  togglePolicyKey,
  versionGateEntry,
  versionGateOptions,
} from './dispatch.js';
import type { KnobField, KnobWrite, PresetId } from './dispatch.js';

const AUDIT_LIMIT = 100;
const CLAIM_PREVIEW = 8;
/** Bug share the mix control starts at when first enabled — the middle of
 *  the 30–50 % band the control exists for; every value 0–100 is settable. */
const DEFAULT_MIX_RATIO = 40;
/** Separator for value signatures — cannot occur in a version id or policy key. */
const SIG_SEP = '|';

const STATE_WORD: Record<DispatchState, { label: string; color: string; bg: string; hint: string }> = {
  hold: { label: 'Hold', color: '#475569', bg: '#e2e8f0', hint: 'Cap is 0 — no ticket is handed out.' },
  full: { label: 'Full', color: '#9a3412', bg: '#ffedd5', hint: 'Every cap slot holds a claim. Check for stale claims before raising the cap.' },
  empty: { label: 'Empty', color: '#991b1b', bg: '#fee2e2', hint: 'Cap is open but nothing grantable is inside the gate — phase-change signal, a fail-closed gate, or briefs missing.' },
  running: { label: 'Running', color: '#166534', bg: '#dcfce7', hint: 'Tickets are being handed out inside the gate.' },
};

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

type Writes = Partial<Record<KnobField, KnobWrite>>;

interface KnobState {
  cap: number;
  gate: string[];
  policy: string[];
  /** Per-knob value signatures — change only when THAT knob's value changes,
   *  not when the map row is re-sent or another knob moves. */
  gateSig: string;
  policySig: string;
  /** All three together — the audit trail is re-read whenever any knob moved. */
  signature: string;
}

function useKnobState(): KnobState | null {
  const currentMap = useMindmapStore((s) => s.currentMap);
  return useMemo(() => {
    if (!currentMap) return null;
    const cap = currentMap.maxActiveClaims ?? 0;
    const gate = currentMap.dispatchGate ?? [];
    const policy = currentMap.dispatchPolicy ?? [];
    const gateSig = gate.join(SIG_SEP);
    const policySig = policy.join(SIG_SEP);
    return { cap, gate, policy, gateSig, policySig, signature: [String(cap), gateSig, policySig].join(SIG_SEP + SIG_SEP) };
  }, [currentMap]);
}

/** Both cards, sharing ONE audit fetch + member load. */
export function LeidangCards({ readOnly = false }: { readOnly?: boolean }) {
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const members = useMindmapStore((s) => s.members);
  const loadMembers = useMindmapStore((s) => s.loadMembers);
  const knobs = useKnobState();
  const [events, setEvents] = useState<ChangeEvent[]>([]);
  const [auditError, setAuditError] = useState<string | null>(null);
  const signature = knobs?.signature ?? '';

  useEffect(() => {
    if (!currentMapId) return;
    let cancelled = false;
    api
      .fetchChangeHistory(currentMapId, { eventType: 'map.field_changed', limit: AUDIT_LIMIT })
      .then((r) => {
        if (cancelled) return;
        setEvents(r.events);
        setAuditError(null);
      })
      .catch((e: unknown) => !cancelled && setAuditError(e instanceof Error ? e.message : 'unavailable'));
    return () => {
      cancelled = true;
    };
    // Re-read after our own apply and after a map:updated from someone
    // else — the row explaining the new value is new too.
  }, [currentMapId, signature]);

  useEffect(() => {
    if (currentMapId) void loadMembers();
  }, [currentMapId, loadMembers]);

  const writes = useMemo(() => lastKnobWrites(events, members), [events, members]);
  if (!knobs) return null;
  return (
    <>
      <DispatchCard knobs={knobs} writes={writes} events={events} auditError={auditError} readOnly={readOnly} />
      <FleetCard knobs={knobs} writes={writes} />
    </>
  );
}

const KNOB_HINT: Record<KnobField, string> = {
  maxActiveClaims: 'Fleet-wide claim cap = CI capacity, not a phase. 0 = hold: satellites park, nothing is handed out.',
  dispatchGate: 'AND-filter. version: matches the ticket\'s effective version (own or inherited from its branch). A ticket outside the gate is invisible to the fleet, not deprioritised.',
  dispatchPolicy: 'Ordered sort keys for what is left inside the gate. Empty = default (bugs › priority › age). The bug-share control adds one mix:bugs=N entry that weaves bugs into the stream at a fixed percentage.',
};

function DispatchCard({ knobs, writes, events, auditError, readOnly }: { knobs: KnobState; writes: Writes; events: ChangeEvent[]; auditError: string | null; readOnly: boolean }) {
  const currentMap = useMindmapStore((s) => s.currentMap);
  const nodes = useMindmapStore((s) => s.nodes);
  const versions = useMindmapStore((s) => s.versions);
  const updateMapSettings = useMindmapStore((s) => s.updateMapSettings);
  const { cap, gate, policy, gateSig, policySig } = knobs;

  // Drafts: edited locally, written on Apply. Each draft resets only when
  // ITS saved value changes underneath (our own write echoing back, or
  // somebody else's) — keyed on that knob's value signature, so neither an
  // unrelated map:updated (rename) nor the orchestrator's ~2-min cap tick
  // wipes a half-edited gate. A changed value still wins: the card never
  // shows a stale draft as if it were live.
  const [capDraft, setCapDraft] = useState<string>(String(cap));
  const [gateDraft, setGateDraft] = useState<string[]>(gate);
  const [policyDraft, setPolicyDraft] = useState<string[]>(policy);
  const [busy, setBusy] = useState<KnobField | 'preset' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [presetVersion, setPresetVersion] = useState<string>('');
  const [pendingPreset, setPendingPreset] = useState<PresetId | null>(null);

  useEffect(() => setCapDraft(String(cap)), [cap]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- gateSig is `gate` by value
  useEffect(() => setGateDraft(gate), [gateSig]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- policySig is `policy` by value
  useEffect(() => setPolicyDraft(policy), [policySig]);

  const workflow = currentMap?.statusWorkflow;
  const snapshot: DispatchQueueSnapshot | null = useMemo(() => {
    if (!workflow) return null;
    return dispatchQueueSnapshot(Object.values(nodes), { workflow, cap, gate });
  }, [nodes, workflow, cap, gate]);

  // What the DRAFT gate would leave grantable — shown while editing so a
  // fail-closed typo is visible before it goes live.
  const draftInGate = useMemo(() => {
    if (!workflow || sameList(gateDraft, gate)) return null;
    return dispatchQueueSnapshot(Object.values(nodes), { workflow, cap, gate: gateDraft }).inGate;
  }, [nodes, workflow, cap, gate, gateDraft]);

  const versionOptions = useMemo(() => versionGateOptions(versions), [versions]);
  const suggestedCap = useMemo(() => lastNonZeroCap(events), [events]);

  if (!currentMap || !snapshot) return null;

  const mixRatio = mixBugsRatio(policyDraft);
  const unknownPolicyKeys = normalizePolicy(policyDraft).filter((k) => !isKnownPolicyKey(k));
  const capNumber = Number(capDraft);
  const capValid = Number.isInteger(capNumber) && capNumber >= 0;
  const capDirty = capValid && capNumber !== cap;
  const gateDirty = !sameList(gateDraft, gate);
  const policyDirty = !sameList(normalizePolicy(policyDraft), normalizePolicy(policy));
  const busyAny = busy !== null;
  const state = STATE_WORD[snapshot.state];

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
      <span title={state.hint} style={{ ...pill, background: state.bg, color: state.color }}>{state.label}</span>
      <span style={{ fontSize: 13, color: '#334155' }}>
        <strong>{snapshot.activeClaims}</strong> active / cap <strong>{cap}</strong>
      </span>
      <span style={{ fontSize: 12, color: '#64748b' }}>
        · <strong>{snapshot.inGate}</strong> grantable in gate
      </span>
    </div>
  );
  const accent = snapshot.state === 'empty' ? '#fecaca' : snapshot.state === 'full' ? '#fed7aa' : undefined;

  // Developer lens: the same facts, none of the levers. Saved values only —
  // no drafts, no Apply, no presets. Steering stays a PM/operator action.
  if (readOnly) {
    return (
      <Card title="Dispatch — Leidang pull queue" accent={accent}>
        {header}
        <KnobRow field="maxActiveClaims" write={writes.maxActiveClaims} versions={versions} hint={KNOB_HINT.maxActiveClaims}>
          <div style={row}>
            <span style={{ fontSize: 13, color: '#334155' }}>
              <strong>{cap}</strong>
              {cap === 0 && <span style={{ color: '#64748b' }}> — hold: satellites park, nothing is handed out</span>}
            </span>
          </div>
        </KnobRow>
        <KnobRow field="dispatchGate" write={writes.dispatchGate} versions={versions} hint={KNOB_HINT.dispatchGate}>
          <div style={{ ...row, flexWrap: 'wrap' }}>
            {gate.length === 0 && <span style={{ fontSize: 12, color: '#64748b' }}>open — no fence</span>}
            {gateChips(gate, versions).map((c) => (
              <span key={c.raw} title={c.warning ?? c.detail ?? undefined} style={{ ...chip, ...(c.warning ? chipWarn : {}) }}>
                {c.label}
                {c.detail && <span style={{ color: '#64748b', marginLeft: 4 }}>({c.detail})</span>}
              </span>
            ))}
          </div>
        </KnobRow>
        <KnobRow field="dispatchPolicy" write={writes.dispatchPolicy} versions={versions} hint={KNOB_HINT.dispatchPolicy}>
          <div style={{ ...row, flexWrap: 'wrap' }}>
            {normalizePolicy(policy).map((k, i) => (
              <span key={k} style={{ ...chip, ...(isKnownPolicyKey(k) ? {} : chipWarn) }}>
                <span style={{ color: '#94a3b8', marginRight: 4 }}>{i + 1}.</span>
                {policyKeyLabel(k)}
              </span>
            ))}
            {policy.length === 0 && (
              <span style={{ fontSize: 12, color: '#64748b' }}>default: {effectivePolicy([]).map(policyKeyLabel).join(' › ')}</span>
            )}
          </div>
        </KnobRow>
        <div style={{ fontSize: 12, color: '#64748b', marginTop: 12, paddingTop: 10, borderTop: '1px solid #f1f5f9' }}>
          Read-only in the Developer lens — steering happens in the PM or All lens.
        </div>
        {auditError && <div style={{ fontSize: 11, color: '#b45309', marginTop: 8 }}>Audit trail unavailable ({auditError}) — the "last write" lines are missing.</div>}
      </Card>
    );
  }

  const save = async (field: KnobField | 'preset', fields: Parameters<typeof updateMapSettings>[0]) => {
    setBusy(field);
    setSaveError(null);
    const ok = await updateMapSettings(fields);
    setBusy(null);
    if (!ok) setSaveError('Save failed — the value shown is what the server still has.');
    return ok;
  };

  const runPreset = async (id: PresetId) => {
    const result = applyPreset(id, presetVersion || null);
    if (!result) return;
    const ok = await save('preset', { dispatchGate: result.gate, dispatchPolicy: result.policy });
    if (ok) setPendingPreset(null);
  };

  return (
    <Card title="Dispatch — Leidang pull queue" accent={accent}>
      {/* Header: state word + the cap ratio, both from SAVED values */}
      {header}
      {snapshot.state === 'empty' && (
        <div style={warnBox}>
          {snapshot.unknownGateEntries.length > 0
            ? <>The gate contains an entry the server cannot read (<code>{snapshot.unknownGateEntries.join(', ')}</code>) — it matches nothing. Remove it below.</>
            : snapshot.needsBrief > 0
              ? <>{snapshot.needsBrief} tickets are inside the gate but have no brief (no description, no linked issue) — the pull refuses them. Write briefs, or nothing moves.</>
              : snapshot.pullable > 0
                ? <>{snapshot.pullable} tickets are pullable on the map, none inside the gate. Either the phase is done (switch the gate) or the work is unversioned (see Fleet).</>
                : <>Nothing is pullable on the whole map — every todo ticket is claimed, blocked, or waiting on a predecessor.</>}
        </div>
      )}
      {saveError && <div style={{ ...warnBox, marginBottom: 8 }}>{saveError}</div>}

      {/* ── Cap ── */}
      <KnobRow
        field="maxActiveClaims"
        write={writes.maxActiveClaims}
        versions={versions}
        hint={KNOB_HINT.maxActiveClaims}
      >
        <div style={row}>
          <input
            type="number"
            min={0}
            max={99}
            value={capDraft}
            onChange={(e) => setCapDraft(e.target.value)}
            style={{ ...input, width: 64 }}
            aria-label="Claim cap"
          />
          {cap === 0 ? (
            <button
              style={btn}
              disabled={busyAny || suggestedCap === null}
              title={suggestedCap === null ? 'No earlier non-zero cap in the audit — type one.' : `Back to the last cap the audit saw (${suggestedCap})`}
              onClick={() => suggestedCap !== null && setCapDraft(String(suggestedCap))}
            >
              Lift hold{suggestedCap !== null ? ` → ${suggestedCap}` : ''}
            </button>
          ) : (
            <button style={btn} disabled={busyAny} onClick={() => setCapDraft('0')} title="Set the cap to 0 — the fleet drains and parks.">
              Hold
            </button>
          )}
          <ApplyButton dirty={capDirty} busy={busy === 'maxActiveClaims'} locked={busyAny} onClick={() => save('maxActiveClaims', { maxActiveClaims: capNumber })} />
          {!capValid && <span style={{ fontSize: 12, color: '#b91c1c' }}>whole number ≥ 0</span>}
        </div>
      </KnobRow>

      {/* ── Gate ── */}
      <KnobRow
        field="dispatchGate"
        write={writes.dispatchGate}
        versions={versions}
        hint={KNOB_HINT.dispatchGate}
      >
        <div style={{ ...row, flexWrap: 'wrap' }}>
          {gateDraft.length === 0 && <span style={{ fontSize: 12, color: '#64748b' }}>open — no fence</span>}
          {gateChips(gateDraft, versions).map((c) => (
            <span key={c.raw} title={c.warning ?? c.detail ?? undefined} style={{ ...chip, ...(c.warning ? chipWarn : {}) }}>
              {c.label}
              {c.detail && <span style={{ color: '#64748b', marginLeft: 4 }}>({c.detail})</span>}
              <button style={chipX} aria-label={`Remove ${c.label} from gate`} onClick={() => setGateDraft(toggleGateEntry(gateDraft, c.raw))}>×</button>
            </span>
          ))}
        </div>
        <div style={row}>
          <select
            value=""
            onChange={(e) => e.target.value && setGateDraft(toggleGateEntry(gateDraft, versionGateEntry(e.target.value)))}
            style={{ ...input, width: 220 }}
            aria-label="Add version to gate"
          >
            <option value="">+ version…</option>
            {versionOptions.map((v) => (
              <option key={v.id} value={v.id} disabled={gateDraft.includes(versionGateEntry(v.id))}>
                {v.name} ({v.status}{v.targetDate ? ` · ${v.targetDate}` : ''})
              </option>
            ))}
          </select>
          <label
            title='Matches tickets tagged "bug" or "type:bug" (case-insensitive) — GitHub-mirrored labels arrive as "type:bug".'
            style={{ fontSize: 12, color: '#334155', display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
          >
            <input type="checkbox" checked={gateDraft.includes(GATE_BUGS_ONLY)} onChange={() => setGateDraft(toggleGateEntry(gateDraft, GATE_BUGS_ONLY))} />
            Bugs only
          </label>
          <ApplyButton dirty={gateDirty} busy={busy === 'dispatchGate'} locked={busyAny} onClick={() => save('dispatchGate', { dispatchGate: gateDraft })} />
          {draftInGate !== null && (
            <span style={{ fontSize: 12, color: draftInGate === 0 ? '#b91c1c' : '#64748b' }}>
              with this gate: {draftInGate} grantable
            </span>
          )}
        </div>
      </KnobRow>

      {/* ── Policy ── */}
      <KnobRow
        field="dispatchPolicy"
        write={writes.dispatchPolicy}
        versions={versions}
        hint={KNOB_HINT.dispatchPolicy}
      >
        <div style={{ ...row, flexWrap: 'wrap' }}>
          {normalizePolicy(policyDraft).map((k, i, arr) => {
            const known = isKnownPolicyKey(k);
            return (
              <span
                key={k}
                title={known ? undefined : 'This build cannot read this entry — it is kept and written on Apply; the server treats keys it does not know as inert.'}
                style={{ ...chip, ...(known ? {} : chipWarn) }}
              >
                <span style={{ color: known ? '#94a3b8' : '#b91c1c', marginRight: 4 }}>{i + 1}.</span>
                {policyKeyLabel(k)}
                <button style={chipX} aria-label={`Move ${k} earlier`} disabled={i === 0} onClick={() => setPolicyDraft(movePolicyKey(arr, k, -1))}>↑</button>
                <button style={chipX} aria-label={`Move ${k} later`} disabled={i === arr.length - 1} onClick={() => setPolicyDraft(movePolicyKey(arr, k, 1))}>↓</button>
                <button style={chipX} aria-label={`Remove ${k}`} onClick={() => setPolicyDraft(togglePolicyKey(arr, k))}>×</button>
              </span>
            );
          })}
          {DISPATCH_POLICY_KEYS.filter((k) => !policyDraft.includes(k)).map((k) => (
            <button key={k} style={{ ...chip, ...chipGhost }} onClick={() => setPolicyDraft(togglePolicyKey(policyDraft, k))} aria-label={`Add ${k}`}>
              + {policyKeyLabel(k)}
            </button>
          ))}
          <ApplyButton dirty={policyDirty} busy={busy === 'dispatchPolicy'} locked={busyAny} onClick={() => save('dispatchPolicy', { dispatchPolicy: normalizePolicy(policyDraft) })} />
        </div>
        {unknownPolicyKeys.length > 0 && (
          <div style={{ fontSize: 12, color: '#b45309' }}>
            <code>{unknownPolicyKeys.join(', ')}</code>: unknown to this build — kept and written on Apply (a newer server may read them; in the sort here they are inert). Remove the chip if it is a typo.
          </div>
        )}
        {/* Mix control — writes/removes the ONE parametric entry mix:bugs=<N>.
            Applied via the same policy Apply above, so the write lands in the
            map.field_changed audit like every other knob change. */}
        <div style={{ ...row, flexWrap: 'wrap' }}>
          <label
            title="Splits the queue into bugs and non-bugs, sorts each by the other policy keys, then weaves them deterministically at N:(100−N). 0 = off-pattern (bugs run in the stream normally), 100 = all bugs first. When one class runs dry the other fills every slot."
            style={{ fontSize: 12, color: '#334155', display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
          >
            <input
              type="checkbox"
              checked={mixRatio !== null}
              onChange={() => setPolicyDraft(setMixBugs(policyDraft, mixRatio === null ? DEFAULT_MIX_RATIO : null))}
            />
            Steer bug share
          </label>
          {mixRatio !== null && (
            <>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={mixRatio}
                onChange={(e) => setPolicyDraft(setMixBugs(policyDraft, Number(e.target.value)))}
                aria-label="Bug share percent (slider)"
              />
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={mixRatio}
                onChange={(e) => {
                  if (e.target.value === '') return; // half-typed — keep the draft
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setPolicyDraft(setMixBugs(policyDraft, v));
                }}
                style={{ ...input, width: 64 }}
                aria-label="Bug share percent"
              />
              <span style={{ fontSize: 12, color: '#64748b' }}>
                % bugs{mixRatio === 0 ? ' — 0 = no fixed pattern, bugs run in the stream normally' : mixRatio === 100 ? ' — all bugs first, then the rest' : ''}
              </span>
            </>
          )}
        </div>
        {policyDraft.length === 0 && (
          <div style={{ fontSize: 12, color: '#64748b' }}>Sorting by default: {effectivePolicy([]).map(policyKeyLabel).join(' › ')}</div>
        )}
      </KnobRow>

      {/* ── Presets ── */}
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #f1f5f9' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
          Phase presets <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— set gate + policy, never the cap</span>
        </div>
        <div style={{ ...row, flexWrap: 'wrap' }}>
          {PRESETS.map((p) => (
            <button key={p.id} style={btn} title={p.hint} disabled={busyAny} onClick={() => setPendingPreset(pendingPreset === p.id ? null : p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        {pendingPreset && (() => {
          const preset = PRESETS.find((p) => p.id === pendingPreset)!;
          const next = applyPreset(pendingPreset, presetVersion || null);
          return (
            <div style={{ marginTop: 8, padding: '8px 10px', background: '#f8fafc', borderRadius: 8, fontSize: 12, color: '#334155' }}>
              <div style={{ marginBottom: 6 }}>{preset.hint}</div>
              {preset.needsVersion && (
                <div style={{ ...row, marginBottom: 6 }}>
                  <select value={presetVersion} onChange={(e) => setPresetVersion(e.target.value)} style={{ ...input, width: 240 }} aria-label="Preset version">
                    <option value="">pick the version…</option>
                    {versionOptions.map((v) => (
                      <option key={v.id} value={v.id}>{v.name} ({v.status}{v.targetDate ? ` · ${v.targetDate}` : ''})</option>
                    ))}
                  </select>
                </div>
              )}
              {next && (
                <div style={{ lineHeight: 1.7 }}>
                  <div>Gate: <s style={{ color: '#94a3b8' }}>{formatKnobValue('dispatchGate', gate, versions)}</s> → <strong>{formatKnobValue('dispatchGate', next.gate, versions)}</strong></div>
                  <div>Policy: <s style={{ color: '#94a3b8' }}>{formatKnobValue('dispatchPolicy', policy, versions)}</s> → <strong>{formatKnobValue('dispatchPolicy', next.policy, versions)}</strong></div>
                  {mixBugsRatio(policy) !== null && mixBugsRatio(next.policy) === null && (
                    <div style={{ color: '#b45309' }}>Presets replace the whole policy — the current bug-share mix (Mix: {mixBugsRatio(policy)} % Bugs) is removed. Re-enable it after applying if you still want it.</div>
                  )}
                  <div style={{ marginTop: 6 }}>
                    <button style={{ ...btn, ...btnPrimary }} disabled={busyAny} onClick={() => runPreset(pendingPreset)}>
                      {busy === 'preset' ? 'Applying…' : `Apply ${preset.label}`}
                    </button>
                    <button style={{ ...btn, marginLeft: 6 }} onClick={() => setPendingPreset(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>
      {auditError && <div style={{ fontSize: 11, color: '#b45309', marginTop: 8 }}>Audit trail unavailable ({auditError}) — the "last write" lines are missing, the knobs still work.</div>}
    </Card>
  );
}

function FleetCard({ knobs, writes }: { knobs: KnobState; writes: Writes }) {
  const currentMap = useMindmapStore((s) => s.currentMap);
  const nodes = useMindmapStore((s) => s.nodes);
  const versions = useMindmapStore((s) => s.versions);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const [showAllClaims, setShowAllClaims] = useState(false);
  const { cap, gate } = knobs;

  // Per render on purpose: ages and the stale flag must not freeze until
  // the next node change. Claims are a handful of rows; the scan is cheap.
  const now = new Date();
  const claims = claimRows(nodes, now);
  const workflow = currentMap?.statusWorkflow;
  const snapshot = useMemo(
    () => (workflow ? dispatchQueueSnapshot(Object.values(nodes), { workflow, cap, gate }) : null),
    [nodes, workflow, cap, gate],
  );
  if (!currentMap || !snapshot) return null;

  const stale = claims.filter((c) => c.stale).length;
  const last = newestKnobWrite(writes);
  const gateHasVersion = gate.some((g) => g.startsWith('version:'));

  return (
    <Card title="Fleet" accent={stale > 0 ? '#fed7aa' : undefined}>
      <FleetTelemetry />
      <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.6 }}>
        <div>
          Claims: <strong>{claims.length}</strong>
          {stale > 0 && (
            <span style={{ color: '#9a3412' }}> — <strong>{stale}</strong> older than {STALE_CLAIM_HOURS} h (sweeper threshold; the worker is probably gone)</span>
          )}
        </div>
        {claims.length > 0 && (
          <ul style={{ margin: '4px 0 8px', paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
            {(showAllClaims ? claims : claims.slice(0, CLAIM_PREVIEW)).map((c) => (
              <li key={c.node.id} style={{ color: c.stale ? '#9a3412' : undefined }}>
                <Link onClick={() => selectNode(c.node.id)}>{c.node.text}</Link>
                <span style={{ color: '#64748b' }}> — <span title={c.session}>{shortSession(c.session)}</span> · {formatAge(c.node.claimedAt, now)}</span>
              </li>
            ))}
            {claims.length > CLAIM_PREVIEW && (
              <li><Link onClick={() => setShowAllClaims((v) => !v)}>{showAllClaims ? `Show ${CLAIM_PREVIEW} only` : `Show all ${claims.length}`}</Link></li>
            )}
          </ul>
        )}

        <div style={{ marginTop: 4 }}>
          Queue behind the gate: <strong>{snapshot.inGate}</strong> grantable
          {(snapshot.inGate > 0 || snapshot.needsBrief > 0) && (
            <span style={{ color: '#64748b' }}>
              {' '}— {snapshot.needsBrief} without a brief{snapshot.needsBrief > 0 ? ' (refused until one exists)' : ''}, {snapshot.unestimated} unestimated
            </span>
          )}
        </div>
        {currentMap.profilePolicy && (
          <div style={{ color: '#64748b', fontSize: 12 }}>
            Profile routing is on: P0 and big tickets go to heavy workers only. This count is fleet-wide — a fleet without a heavy worker sees fewer.
          </div>
        )}
        {gateHasVersion && snapshot.unversionedOutsideGate > 0 && (
          <div style={{ color: '#b45309' }}>
            <strong>{snapshot.unversionedOutsideGate}</strong> pullable tickets have no version and are invisible to this gate — version them in or out.
          </div>
        )}
        {snapshot.unknownGateEntries.length > 0 && (
          <div style={{ color: '#b91c1c' }}>Gate has an unreadable entry — the queue is empty until it is removed (see Dispatch).</div>
        )}

        <div style={{ color: '#64748b', fontSize: 12, marginTop: 8 }}>
          {last
            ? <>Last knob write: {KNOB_LABEL[last.field]} {formatKnobValue(last.field, last.oldValue, versions)} → {formatKnobValue(last.field, last.newValue, versions)} · {last.actor ?? 'API key / system'} · {formatAge(last.at, now)} ago</>
            : <>No knob write in the audit yet — the trail starts with the first write after this feature shipped.</>}
        </div>
      </div>
    </Card>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────

function KnobRow({ field, write, versions, hint, children }: { field: KnobField; write: KnobWrite | undefined; versions: Version[]; hint: string; children: React.ReactNode }) {
  const now = new Date();
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#334155', minWidth: 48 }} title={hint}>{KNOB_LABEL[field]}</span>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>
          {write
            ? <>last: {formatKnobValue(field, write.oldValue, versions)} → {formatKnobValue(field, write.newValue, versions)} · {write.actor ?? 'API key / system'} · {formatAge(write.at, now)} ago</>
            : 'no write on record'}
        </span>
      </div>
      {children}
    </div>
  );
}

/** `locked` = another knob is saving: two parallel applies would race
 *  their optimistic rollbacks against each other in the store. */
function ApplyButton({ dirty, busy, locked, onClick }: { dirty: boolean; busy: boolean; locked: boolean; onClick: () => void }) {
  return (
    <button style={{ ...btn, ...(dirty ? btnPrimary : {}) }} disabled={!dirty || locked} onClick={onClick} title={dirty ? 'Write to the map — the fleet follows within ~2 min' : 'Nothing changed'}>
      {busy ? 'Saving…' : 'Apply'}
    </button>
  );
}

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 };
const pill: React.CSSProperties = { padding: '2px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700, letterSpacing: 0.3 };
const chip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 2, padding: '2px 4px 2px 8px', borderRadius: 999, background: '#eef2ff', color: '#3730a3', fontSize: 12, border: '1px solid #c7d2fe' };
const chipWarn: React.CSSProperties = { background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' };
const chipGhost: React.CSSProperties = { background: 'transparent', color: '#64748b', border: '1px dashed #cbd5e1', cursor: 'pointer', padding: '2px 8px', fontFamily: 'inherit' };
const chipX: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 12, padding: '0 3px', lineHeight: 1, fontFamily: 'inherit' };
const input: React.CSSProperties = { fontSize: 12, padding: '3px 6px', border: '1px solid #cbd5e1', borderRadius: 6, fontFamily: 'inherit', background: '#fff' };
const btn: React.CSSProperties = { fontSize: 12, padding: '3px 10px', border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', color: '#334155', cursor: 'pointer', fontFamily: 'inherit' };
const btnPrimary: React.CSSProperties = { background: '#4f46e5', border: '1px solid #4f46e5', color: '#fff' };
const warnBox: React.CSSProperties = { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', borderRadius: 8, padding: '6px 10px', fontSize: 12, marginBottom: 6 };
