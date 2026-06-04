/**
 * Triage review panel (#94 Phase 1 + #95 Phase 2).
 *
 * Three sub-views (Pending / Skipped / Placed) showing AI triage
 * decisions for the current map. Operator actions per row:
 *
 *   - Confirm    — mark the row reviewed, keep the auto decision.
 *   - Override   — pick a different parent via the node-picker modal,
 *                  optionally change decision (skip / uncertain).
 *   - Re-classify — re-run the LLM against the current map context.
 *
 * Phase 2 (#95) adds:
 *
 *   - Bulk-action toolbar at the top of each sub-view: checkbox column,
 *     select-all, and "Confirm All Selected" / "Override All Selected"
 *     / "Re-classify All Selected" buttons. Each calls the matching
 *     bulk-* API; the response carries per-item results so the operator
 *     sees per-row outcomes when (for example) one row was deleted
 *     between submit and execute.
 *   - Confidence-range slider (0-100) above the list — server-side
 *     filter via the GET endpoint's minConfidence/maxConfidence.
 *   - issue-state filter (open / closed / all).
 *   - time-window filter (24h / 7d / 30d / all). Default 7d — most
 *     common operator triage cadence per the spec.
 *
 * Lives alongside BlockedPanel / SprintPanel — same right-docked
 * 420px width, same close-button pattern. The map header's
 * TriageIndicator button toggles it.
 *
 * Frontend tests are deferred until `@mindblown/mindmap` has a test
 * runner (see #78 follow-ups). Every interactive element carries a
 * `data-testid` so a future pass can target them without re-writing
 * the markup.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMindmapStore } from './store.js';
import {
  ApiError,
  bulkConfirmTriageDecisions,
  bulkOverrideTriageDecisions,
  bulkReclassifyTriageDecisions,
  confirmTriageDecision,
  listTriageDecisions,
  overrideTriageDecision,
  reclassifyTriageDecision,
  type BulkTriageItem,
  type TriageDecision,
  type TriageDecisionKind,
} from './api.js';
import { NodePickerModal } from './NodePickerModal.js';

const PANEL_WIDTH = 420;
type IssueStateFilter = 'all' | 'open' | 'closed';
type TimeWindowFilter = 'all' | '24h' | '7d' | '30d';

// Map the time-window dropdown to an ISO `since` value. `all` returns
// null so we don't send the param. We compute on every render of the
// effect (cheap, < 1 µs); keeps the dropdown values reactive.
function timeWindowToSince(w: TimeWindowFilter): string | null {
  if (w === 'all') return null;
  const ms =
    w === '24h' ? 24 * 60 * 60 * 1000 : w === '7d' ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms).toISOString();
}

// Count successful items + collect first per-item error from a
// bulk-response so we can show a single inline banner without
// hijacking the whole panel with a modal.
function summarizeBulk(results: BulkTriageItem[]): { ok: number; err: number; firstError: string | null } {
  let ok = 0;
  let err = 0;
  let firstError: string | null = null;
  for (const r of results) {
    if ('error' in r) {
      err++;
      if (!firstError) firstError = `${r.id.slice(0, 8)}…: ${r.error.message}`;
    } else {
      ok++;
    }
  }
  return { ok, err, firstError };
}

type SubView = 'pending' | 'placed' | 'skipped';

export function TriagePanel({
  mapId,
  onClose,
}: {
  mapId: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<SubView>('pending');
  const [decisions, setDecisions] = useState<TriageDecision[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busyDecisionId, setBusyDecisionId] = useState<string | null>(null);
  const [pickerForDecision, setPickerForDecision] = useState<TriageDecision | null>(null);
  // Two picker modes:
  //   - 'single' → single-item Place/Move (existing Phase 1 flow).
  //   - 'bulk'   → "Override All Selected" — applies the picked parent
  //     to every checked decisionId via bulkOverrideTriageDecisions.
  // `pickerForDecision` is null in bulk mode (the panel uses
  // `bulkPickerOpen` instead).
  const [bulkPickerOpen, setBulkPickerOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  // Selection state — checked decision ids in the current view. Reset
  // on view-switch and after every bulk action.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // Bulk-in-flight indicator so the toolbar can show a counter.
  const [bulkBusy, setBulkBusy] = useState<null | { kind: 'confirm' | 'override' | 'reclassify'; total: number }>(null);

  // Phase 2 filter state — slider + dropdowns above the list.
  const [minConfidence, setMinConfidence] = useState(0);
  const [maxConfidence, setMaxConfidence] = useState(100);
  const [issueStateFilter, setIssueStateFilter] = useState<IssueStateFilter>('all');
  const [timeWindow, setTimeWindow] = useState<TimeWindowFilter>('7d');

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  // Clear selection when the view changes or after a bulk action.
  // Clearing on filter-change isn't necessary — filtered-out rows just
  // stay selected silently and the next bulk action operates on the
  // intersection of selected ∩ currently-shown.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [view]);

  // Phase 3 follow-up (#102 item 7): listen for triage:updated WS events
  // broadcast by the server when any operator (this one or another tab /
  // user with edit perms) mutates a triage row. We bump `refreshTick` to
  // trigger the data-fetch effect — same path the user's own actions
  // already drive, so we don't need a merge-into-local-state code path.
  // The handler ignores events for other maps as defense-in-depth; the
  // server already scopes broadcasts to the room, but a stale ws
  // connection sticking around across map switches could deliver a
  // foreign event.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        mapId?: string;
        decisionIds?: string[];
      } | undefined;
      if (!detail || detail.mapId !== mapId) return;
      // Refresh-only: we don't try to surgically update the row in
      // local state. The triage list is small (capped at 200) and the
      // refetch is cheap; correctness > savings.
      setRefreshTick((t) => t + 1);
    };
    window.addEventListener('ws:triage', handler);
    return () => window.removeEventListener('ws:triage', handler);
  }, [mapId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Server-side filter for the active sub-view + Phase 2 filters.
    //   Pending  = unreviewed
    //   Placed   = decision=place AND reviewed
    //   Skipped  = decision=skip AND reviewed
    // Confidence/issueState/since are sent as separate query params
    // (server clamps to valid ranges, silently ignores malformed).
    const since = timeWindowToSince(timeWindow);
    const filters = {
      ...(view === 'pending'
        ? { reviewed: false }
        : view === 'placed'
          ? { decision: 'place' as TriageDecisionKind, reviewed: true }
          : { decision: 'skip' as TriageDecisionKind, reviewed: true }),
      limit: 200,
      minConfidence,
      maxConfidence,
      ...(issueStateFilter !== 'all' ? { issueState: issueStateFilter } : {}),
      ...(since ? { since } : {}),
    };
    listTriageDecisions(mapId, filters)
      .then((res) => {
        if (cancelled) return;
        setDecisions(res.decisions);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof ApiError ? err.message : 'Failed to load triage decisions';
        setError(msg);
        setDecisions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mapId, view, refreshTick, minConfidence, maxConfidence, issueStateFilter, timeWindow]);

  const handleConfirm = useCallback(
    async (decision: TriageDecision) => {
      setBusyDecisionId(decision.id);
      try {
        await confirmTriageDecision(mapId, decision);
        refresh();
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'Confirm failed';
        setError(msg);
      } finally {
        setBusyDecisionId(null);
      }
    },
    [mapId, refresh],
  );

  const handleReclassify = useCallback(
    async (decision: TriageDecision) => {
      setBusyDecisionId(decision.id);
      try {
        await reclassifyTriageDecision(mapId, decision.id);
        refresh();
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'Re-classify failed';
        setError(msg);
      } finally {
        setBusyDecisionId(null);
      }
    },
    [mapId, refresh],
  );

  const handleSkipOrUncertain = useCallback(
    async (decision: TriageDecision, newDecision: 'skip' | 'uncertain') => {
      setBusyDecisionId(decision.id);
      try {
        await overrideTriageDecision(mapId, decision.id, {
          decision: newDecision,
          reason: decision.reason,
        });
        refresh();
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'Override failed';
        setError(msg);
      } finally {
        setBusyDecisionId(null);
      }
    },
    [mapId, refresh],
  );

  const handlePickParent = useCallback(
    async (parentNodeId: string) => {
      const decision = pickerForDecision;
      if (!decision) return;
      setPickerForDecision(null);
      setBusyDecisionId(decision.id);
      try {
        await overrideTriageDecision(mapId, decision.id, {
          decision: 'place',
          parentNodeId,
          reason: decision.reason,
        });
        refresh();
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'Place failed';
        setError(msg);
      } finally {
        setBusyDecisionId(null);
      }
    },
    [mapId, pickerForDecision, refresh],
  );

  // ── Bulk handlers (#95 Phase 2) ───────────────────────────────
  //
  // All three share the same shape: pull the selected ids, hit the
  // bulk endpoint, summarize results into an info/error banner, clear
  // the selection, and refresh. We pass the array of ids — the server
  // handles per-item idempotency, so a deleted-mid-batch row shows up
  // as a per-item error in the banner instead of failing the batch.
  const selectedArray = useMemo(() => Array.from(selectedIds), [selectedIds]);
  // Phase 3 follow-up (#102 item 6): `selectedDecisions` is the
  // intersection of `selectedIds` with the rows currently rendered (the
  // filter set may have changed since the operator ticked the checkboxes).
  // We intentionally do NOT clear `selectedIds` when the filter changes —
  // this lets the operator narrow the view, tick more rows, then broaden
  // again to confirm all of them. The trade-off is that the toolbar's
  // `selectedCount` may briefly exceed `visibleCount` (e.g. 30 / 12) when
  // a filter hides some ticked rows; the toolbar renders both numbers so
  // the operator can see the discrepancy.
  const selectedDecisions = useMemo(
    () => decisions.filter((d) => selectedIds.has(d.id)),
    [decisions, selectedIds],
  );

  const finishBulk = useCallback((results: BulkTriageItem[], label: string) => {
    const { ok, err, firstError } = summarizeBulk(results);
    if (err > 0) {
      setError(
        `${label}: ${ok} ok / ${err} failed${firstError ? ` — ${firstError}` : ''}`,
      );
      setInfo(null);
    } else {
      setInfo(`${label}: ${ok} ok`);
      setError(null);
    }
    setSelectedIds(new Set());
    refresh();
  }, [refresh]);

  const handleBulkConfirm = useCallback(async () => {
    if (selectedArray.length === 0) return;
    setBulkBusy({ kind: 'confirm', total: selectedArray.length });
    try {
      const res = await bulkConfirmTriageDecisions(mapId, selectedArray);
      finishBulk(res.results, `Confirm ${selectedArray.length}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Bulk confirm failed';
      setError(msg);
    } finally {
      setBulkBusy(null);
    }
  }, [mapId, selectedArray, finishBulk]);

  const handleBulkReclassify = useCallback(async () => {
    if (selectedArray.length === 0) return;
    setBulkBusy({ kind: 'reclassify', total: selectedArray.length });
    try {
      const res = await bulkReclassifyTriageDecisions(mapId, selectedArray);
      finishBulk(res.results, `Re-classify ${selectedArray.length}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Bulk reclassify failed';
      setError(msg);
    } finally {
      setBulkBusy(null);
    }
  }, [mapId, selectedArray, finishBulk]);

  const handleBulkOverridePickParent = useCallback(
    async (parentNodeId: string) => {
      setBulkPickerOpen(false);
      if (selectedArray.length === 0) return;
      setBulkBusy({ kind: 'override', total: selectedArray.length });
      try {
        const res = await bulkOverrideTriageDecisions(mapId, selectedArray, parentNodeId);
        finishBulk(res.results, `Override ${selectedArray.length}`);
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'Bulk override failed';
        setError(msg);
      } finally {
        setBulkBusy(null);
      }
    },
    [mapId, selectedArray, finishBulk],
  );

  // "Override All Selected" is only valid when every selected row is a
  // place decision (spec: "only valid for `place` decisions — gated
  // client-side"). The button is disabled otherwise; the server also
  // rejects per-item.
  const canBulkOverride =
    selectedDecisions.length > 0 &&
    selectedDecisions.every((d) => d.decision === 'place');

  // Select-all behavior — toggle between (select all visible) and
  // (clear).
  const allSelected =
    decisions.length > 0 && decisions.every((d) => selectedIds.has(d.id));
  const someSelected = selectedIds.size > 0 && !allSelected;
  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(decisions.map((d) => d.id)));
    }
  }, [allSelected, decisions]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div
      data-testid="triage-panel"
      style={{
        width: PANEL_WIDTH,
        height: '100%',
        borderLeft: '1px solid #e2e8f0',
        background: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid #e2e8f0',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 16 }}>🧭</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', flex: 1 }}>
          Triage
        </span>
        <button
          data-testid="triage-panel-close"
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '4px',
            color: '#94a3b8',
            fontSize: 16,
            fontFamily: 'inherit',
            lineHeight: 1,
          }}
          title="Close"
        >
          x
        </button>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          borderBottom: '1px solid #e2e8f0',
          background: '#f8fafc',
        }}
      >
        <TabButton
          testId="triage-tab-pending"
          active={view === 'pending'}
          onClick={() => setView('pending')}
        >
          Pending review
        </TabButton>
        <TabButton
          testId="triage-tab-placed"
          active={view === 'placed'}
          onClick={() => setView('placed')}
        >
          Placed
        </TabButton>
        <TabButton
          testId="triage-tab-skipped"
          active={view === 'skipped'}
          onClick={() => setView('skipped')}
        >
          Skipped
        </TabButton>
      </div>

      {/* Filter row (#95 Phase 2) — confidence slider + state + window */}
      <FilterBar
        minConfidence={minConfidence}
        maxConfidence={maxConfidence}
        onMinChange={setMinConfidence}
        onMaxChange={setMaxConfidence}
        issueState={issueStateFilter}
        onIssueStateChange={setIssueStateFilter}
        timeWindow={timeWindow}
        onTimeWindowChange={setTimeWindow}
      />

      {/* Bulk-action toolbar (#95 Phase 2) — select-all + actions */}
      <BulkToolbar
        view={view}
        totalVisible={decisions.length}
        selectedCount={selectedIds.size}
        allSelected={allSelected}
        someSelected={someSelected}
        onToggleSelectAll={toggleSelectAll}
        canBulkOverride={canBulkOverride}
        bulkBusy={bulkBusy}
        onBulkConfirm={handleBulkConfirm}
        onBulkOverride={() => setBulkPickerOpen(true)}
        onBulkReclassify={handleBulkReclassify}
      />

      {/* Info banner (bulk success) */}
      {info && !error && (
        <div
          data-testid="triage-info"
          style={{
            padding: '8px 16px',
            background: '#dcfce7',
            color: '#166534',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ flex: 1 }}>{info}</span>
          <button
            onClick={() => setInfo(null)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#166534',
              fontFamily: 'inherit',
              fontSize: 12,
            }}
          >
            x
          </button>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div
          data-testid="triage-error"
          style={{
            padding: '8px 16px',
            background: '#fee2e2',
            color: '#991b1b',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ flex: 1 }}>{error}</span>
          <button
            onClick={() => setError(null)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#991b1b',
              fontFamily: 'inherit',
              fontSize: 12,
            }}
          >
            x
          </button>
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto' }} data-testid="triage-body">
        {loading ? (
          <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
            Loading…
          </div>
        ) : decisions.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
            {view === 'pending'
              ? 'Nothing to review. 🎉'
              : view === 'placed'
                ? 'No placed decisions yet.'
                : 'No skipped issues yet.'}
          </div>
        ) : (
          decisions.map((d) => (
            <TriageCard
              key={d.id}
              decision={d}
              view={view}
              busy={busyDecisionId === d.id}
              selected={selectedIds.has(d.id)}
              onToggleSelect={() => toggleSelect(d.id)}
              onConfirm={() => handleConfirm(d)}
              onPlace={() => setPickerForDecision(d)}
              onReclassify={() => handleReclassify(d)}
              onSkip={() => handleSkipOrUncertain(d, 'skip')}
              onUncertain={() => handleSkipOrUncertain(d, 'uncertain')}
            />
          ))
        )}
      </div>

      {/* Footer hint */}
      <div
        style={{
          padding: '10px 16px',
          borderTop: '1px solid #f1f5f9',
          fontSize: 10,
          color: '#94a3b8',
          background: '#f8fafc',
        }}
      >
        Pending = unreviewed AI decisions. Confirm to accept, Override
        to reparent, Re-classify to re-run. Check rows + use the
        toolbar for bulk actions.
      </div>

      {/* Single-item node picker modal */}
      {pickerForDecision && (
        <NodePickerModal
          title={`Pick a parent for "${pickerForDecision.issueTitle}"`}
          excludeNodeIds={pickerForDecision.placedNodeId ? [pickerForDecision.placedNodeId] : []}
          onPick={handlePickParent}
          onClose={() => setPickerForDecision(null)}
        />
      )}

      {/* Bulk-override node picker modal */}
      {bulkPickerOpen && (
        <NodePickerModal
          title={`Pick a parent for ${selectedArray.length} decision${selectedArray.length === 1 ? '' : 's'}`}
          // Exclude every selected row's placedNodeId — picking one of
          // them would self-loop and be rejected per-item with
          // SELF_LOOP_BLOCKED. Better to disable up front.
          excludeNodeIds={selectedDecisions
            .map((d) => d.placedNodeId)
            .filter((x): x is string => typeof x === 'string')}
          onPick={handleBulkOverridePickParent}
          onClose={() => setBulkPickerOpen(false)}
        />
      )}
    </div>
  );
}

// ── Filter bar (#95 Phase 2) ──────────────────────────────────────

function FilterBar({
  minConfidence,
  maxConfidence,
  onMinChange,
  onMaxChange,
  issueState,
  onIssueStateChange,
  timeWindow,
  onTimeWindowChange,
}: {
  minConfidence: number;
  maxConfidence: number;
  onMinChange: (n: number) => void;
  onMaxChange: (n: number) => void;
  issueState: IssueStateFilter;
  onIssueStateChange: (s: IssueStateFilter) => void;
  timeWindow: TimeWindowFilter;
  onTimeWindowChange: (w: TimeWindowFilter) => void;
}) {
  return (
    <div
      data-testid="triage-filterbar"
      style={{
        padding: '8px 12px',
        borderBottom: '1px solid #e2e8f0',
        background: '#f8fafc',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, color: '#64748b', minWidth: 70 }}>
          Confidence
        </span>
        <input
          data-testid="triage-filter-min-confidence"
          type="range"
          min={0}
          max={100}
          value={minConfidence}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            // Clamp: min can't exceed max.
            onMinChange(Math.min(n, maxConfidence));
          }}
          style={{ flex: 1 }}
        />
        <input
          data-testid="triage-filter-max-confidence"
          type="range"
          min={0}
          max={100}
          value={maxConfidence}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            onMaxChange(Math.max(n, minConfidence));
          }}
          style={{ flex: 1 }}
        />
        <span
          style={{ fontSize: 10, color: '#64748b', minWidth: 48, textAlign: 'right' }}
          data-testid="triage-filter-confidence-label"
        >
          {minConfidence}–{maxConfidence}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, color: '#64748b', minWidth: 70 }}>State</span>
        <select
          data-testid="triage-filter-issue-state"
          value={issueState}
          onChange={(e) => onIssueStateChange(e.target.value as IssueStateFilter)}
          style={{
            flex: 1,
            fontSize: 11,
            padding: '2px 4px',
            border: '1px solid #e2e8f0',
            borderRadius: 4,
            background: '#fff',
            fontFamily: 'inherit',
          }}
        >
          <option value="all">All</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
        </select>
        <span style={{ fontSize: 10, color: '#64748b', minWidth: 40 }}>Window</span>
        <select
          data-testid="triage-filter-time-window"
          value={timeWindow}
          onChange={(e) => onTimeWindowChange(e.target.value as TimeWindowFilter)}
          style={{
            flex: 1,
            fontSize: 11,
            padding: '2px 4px',
            border: '1px solid #e2e8f0',
            borderRadius: 4,
            background: '#fff',
            fontFamily: 'inherit',
          }}
        >
          <option value="24h">24 h</option>
          <option value="7d">7 d</option>
          <option value="30d">30 d</option>
          <option value="all">All</option>
        </select>
      </div>
    </div>
  );
}

// ── Bulk-action toolbar (#95 Phase 2) ─────────────────────────────

function BulkToolbar({
  view,
  totalVisible,
  selectedCount,
  allSelected,
  someSelected,
  onToggleSelectAll,
  canBulkOverride,
  bulkBusy,
  onBulkConfirm,
  onBulkOverride,
  onBulkReclassify,
}: {
  view: SubView;
  totalVisible: number;
  selectedCount: number;
  allSelected: boolean;
  someSelected: boolean;
  onToggleSelectAll: () => void;
  canBulkOverride: boolean;
  bulkBusy: null | { kind: 'confirm' | 'override' | 'reclassify'; total: number };
  onBulkConfirm: () => void;
  onBulkOverride: () => void;
  onBulkReclassify: () => void;
}) {
  const noSelection = selectedCount === 0;
  const busy = bulkBusy != null;
  return (
    <div
      data-testid="triage-bulk-toolbar"
      style={{
        padding: '6px 10px',
        borderBottom: '1px solid #e2e8f0',
        background: '#f1f5f9',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
      }}
    >
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 11,
          color: '#475569',
          cursor: totalVisible === 0 ? 'not-allowed' : 'pointer',
        }}
      >
        <input
          data-testid="triage-bulk-select-all"
          type="checkbox"
          // Tri-state visual: indeterminate when some-but-not-all are
          // selected; React doesn't have a JSX prop for `indeterminate`
          // so we set it via a ref callback.
          ref={(el) => {
            if (el) el.indeterminate = someSelected;
          }}
          checked={allSelected}
          disabled={totalVisible === 0 || busy}
          onChange={onToggleSelectAll}
        />
        <span data-testid="triage-bulk-selected-count">
          {selectedCount} selected / {totalVisible} visible
        </span>
        {selectedCount > totalVisible && (
          // Phase 3 follow-up (#102 item 6): a hidden-from-view selection
          // means the operator filtered after ticking, and some checked
          // rows are no longer rendered. The bulk action still operates
          // on the full selection set — call that out so the operator
          // isn't surprised when "Confirm All" affects more rows than
          // appear in the list.
          <span
            data-testid="triage-bulk-offscreen-hint"
            title={`${selectedCount - totalVisible} selected row(s) are hidden by the current filter — bulk actions will still operate on them.`}
            style={{
              fontSize: 10,
              color: '#b45309',
              fontWeight: 600,
              marginLeft: 4,
            }}
          >
            ({selectedCount - totalVisible} hidden)
          </span>
        )}
      </label>
      <div style={{ flex: 1 }} />
      {view === 'pending' && (
        <ActionBtn
          testId="triage-bulk-confirm"
          label={
            bulkBusy?.kind === 'confirm' ? `Confirming ${bulkBusy.total}…` : 'Confirm All'
          }
          kind="primary"
          disabled={noSelection || busy}
          onClick={onBulkConfirm}
        />
      )}
      <ActionBtn
        testId="triage-bulk-override"
        label={
          bulkBusy?.kind === 'override' ? `Moving ${bulkBusy.total}…` : 'Override All'
        }
        kind="default"
        disabled={noSelection || !canBulkOverride || busy}
        onClick={onBulkOverride}
      />
      <ActionBtn
        testId="triage-bulk-reclassify"
        label={
          bulkBusy?.kind === 'reclassify'
            ? `Re-classifying ${bulkBusy.total}…`
            : 'Re-classify All'
        }
        kind="ghost"
        disabled={noSelection || busy}
        onClick={onBulkReclassify}
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      style={{
        flex: 1,
        padding: '10px 12px',
        border: 'none',
        background: active ? '#fff' : 'transparent',
        borderBottom: active ? '2px solid #3b82f6' : '2px solid transparent',
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: 600,
        color: active ? '#1e293b' : '#64748b',
        fontFamily: 'inherit',
        transition: 'all 0.1s',
      }}
    >
      {children}
    </button>
  );
}

function TriageCard({
  decision,
  view,
  busy,
  selected,
  onToggleSelect,
  onConfirm,
  onPlace,
  onReclassify,
  onSkip,
  onUncertain,
}: {
  decision: TriageDecision;
  view: SubView;
  busy: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onConfirm: () => void;
  onPlace: () => void;
  onReclassify: () => void;
  onSkip: () => void;
  onUncertain: () => void;
}) {
  const selectNode = useMindmapStore((s) => s.selectNode);
  const setFocusNode = useMindmapStore((s) => s.setFocusNode);
  const issueUrl = useMemo(() => buildIssueUrl(decision.externalId), [decision.externalId]);
  const colors = decisionColors(decision.decision);

  const jumpToPlacedNode = () => {
    if (!decision.placedNodeId) return;
    selectNode(decision.placedNodeId);
    setFocusNode(decision.placedNodeId);
  };

  // The set of available actions depends on the current decision.
  //   - pending view, decision=place (low-confidence): Confirm (which
  //     requires picking a parent — wire to Override instead),
  //     Override, Re-classify, Skip.
  //   - pending view, decision=skip: Confirm (mark reviewed), Override
  //     (Place), Re-classify, Uncertain.
  //   - pending view, decision=uncertain: Override (Place), Skip,
  //     Re-classify.
  //   - placed view: jump to node, Override (move), Re-classify.
  //   - skipped view: Override (Place), Re-classify.
  const canConfirm =
    view === 'pending' && (decision.decision !== 'place' || decision.placedNodeId != null);

  return (
    <div
      data-testid="triage-card"
      data-decision-id={decision.id}
      style={{
        padding: 12,
        borderBottom: '1px solid #f1f5f9',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        background: selected ? '#eff6ff' : 'transparent',
      }}
    >
      {/* Title row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <input
          data-testid="triage-card-select"
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          disabled={busy}
          style={{ marginTop: 2 }}
          aria-label={`Select ${decision.issueTitle}`}
        />
        <span style={{ fontSize: 12, fontWeight: 600, color: '#1e293b', flex: 1 }}>
          {decision.issueTitle}
        </span>
        <span
          data-testid="triage-card-decision"
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 10,
            background: colors.bg,
            color: colors.fg,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            whiteSpace: 'nowrap',
          }}
        >
          {decision.decision}
        </span>
      </div>

      {/* External link + meta */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
        <a
          href={issueUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="triage-card-issue-link"
          style={{ color: '#3b82f6', textDecoration: 'none' }}
        >
          {decision.externalId}
        </a>
        <span style={{ color: '#cbd5e1' }}>•</span>
        <span style={{ color: '#64748b' }} data-testid="triage-card-decided-by">
          {decision.decidedBy === 'auto' ? 'Claude' : 'Operator'}
        </span>
        <span style={{ color: '#cbd5e1' }}>•</span>
        <span style={{ color: '#94a3b8', fontSize: 10 }}>
          {formatTimeAgo(decision.decidedAt)}
        </span>
      </div>

      {/* Confidence bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, color: '#64748b', minWidth: 50 }}>
          Confidence
        </span>
        <div
          style={{
            flex: 1,
            height: 6,
            borderRadius: 3,
            background: '#e2e8f0',
            overflow: 'hidden',
          }}
        >
          <div
            data-testid="triage-card-confidence"
            style={{
              width: `${Math.max(0, Math.min(100, decision.confidence))}%`,
              height: '100%',
              background: confidenceColor(decision.confidence),
              transition: 'width 0.2s',
            }}
          />
        </div>
        <span style={{ fontSize: 10, color: '#64748b', minWidth: 28, textAlign: 'right' }}>
          {decision.confidence}
        </span>
      </div>

      {/* Reason */}
      <div
        data-testid="triage-card-reason"
        style={{
          fontSize: 11,
          color: '#475569',
          lineHeight: 1.4,
          padding: 8,
          background: '#f8fafc',
          borderRadius: 4,
          border: '1px solid #f1f5f9',
        }}
      >
        {decision.reason}
      </div>

      {/* Placed-node link (placed view only) */}
      {view === 'placed' && decision.placedNodeId && (
        <button
          data-testid="triage-card-jump-to-node"
          onClick={jumpToPlacedNode}
          style={{
            background: 'none',
            border: '1px dashed #cbd5e1',
            borderRadius: 4,
            padding: '4px 8px',
            cursor: 'pointer',
            color: '#475569',
            fontSize: 11,
            fontFamily: 'inherit',
            textAlign: 'left',
          }}
        >
          → Jump to placed node
        </button>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {canConfirm && (
          <ActionBtn
            testId="triage-card-confirm"
            label="Confirm"
            kind="primary"
            disabled={busy}
            onClick={onConfirm}
          />
        )}
        <ActionBtn
          testId="triage-card-override-place"
          label={decision.placedNodeId ? 'Move…' : 'Place…'}
          kind="default"
          disabled={busy}
          onClick={onPlace}
        />
        {decision.decision !== 'skip' && (
          <ActionBtn
            testId="triage-card-skip"
            label="Skip"
            kind="default"
            disabled={busy}
            onClick={onSkip}
          />
        )}
        {decision.decision !== 'uncertain' && view === 'pending' && (
          <ActionBtn
            testId="triage-card-uncertain"
            label="Defer"
            kind="default"
            disabled={busy}
            onClick={onUncertain}
          />
        )}
        <ActionBtn
          testId="triage-card-reclassify"
          label={busy ? '…' : 'Re-classify'}
          kind="ghost"
          disabled={busy}
          onClick={onReclassify}
        />
      </div>
    </div>
  );
}

function ActionBtn({
  label,
  kind,
  disabled,
  onClick,
  testId,
}: {
  label: string;
  kind: 'primary' | 'default' | 'ghost';
  disabled?: boolean;
  onClick: () => void;
  testId: string;
}) {
  const styles =
    kind === 'primary'
      ? { background: '#3b82f6', color: '#fff', border: '1px solid #3b82f6' }
      : kind === 'ghost'
        ? { background: 'transparent', color: '#64748b', border: '1px solid transparent' }
        : { background: '#fff', color: '#475569', border: '1px solid #e2e8f0' };
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      style={{
        ...styles,
        padding: '4px 10px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontFamily: 'inherit',
        transition: 'all 0.1s',
      }}
    >
      {label}
    </button>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

function decisionColors(decision: TriageDecisionKind): { bg: string; fg: string } {
  switch (decision) {
    case 'place':
      return { bg: '#dcfce7', fg: '#166534' };
    case 'skip':
      return { bg: '#fef3c7', fg: '#854d0e' };
    case 'uncertain':
    default:
      return { bg: '#e2e8f0', fg: '#475569' };
  }
}

function confidenceColor(c: number): string {
  if (c >= 75) return '#10b981';
  if (c >= 50) return '#3b82f6';
  if (c >= 25) return '#f59e0b';
  return '#ef4444';
}

function buildIssueUrl(externalId: string): string {
  const idx = externalId.lastIndexOf('#');
  if (idx < 0) return '#';
  const ownerRepo = externalId.slice(0, idx);
  const number = externalId.slice(idx + 1);
  return `https://github.com/${ownerRepo}/issues/${number}`;
}

function formatTimeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const deltaMs = Date.now() - t;
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
