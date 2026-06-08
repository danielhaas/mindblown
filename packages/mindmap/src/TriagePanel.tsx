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
  importOrphanIssue,
  listNotInMindBlown,
  listTriageDecisions,
  overrideTriageDecision,
  reclassifyTriageDecision,
  runDriftAuditForMap,
  skipOrphanIssue,
  type BulkTriageItem,
  type DriftAuditRunResponse,
  type NotInMindBlownBucket,
  type NotInMindBlownItem,
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

type SubView = 'pending' | 'placed' | 'skipped' | 'not-in-mindblown';

// Sub-filter inside the "Not in MindBlown" tab. 'all' shows every bucket;
// the others narrow to a single bucket using the server's `bucket` param.
type NotInMindBlownFilter = 'all' | NotInMindBlownBucket;

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

  // ── Not-in-MindBlown tab state (#140) ─────────────────────────
  // Lives outside the main `decisions` state because the items have a
  // different shape (no Phase 2 triage-row fields like reviewed/
  // confidence on orphans). The decision-row buckets (skipped/pending-
  // skipped/uncertain) still carry a triageDecisionId so per-card
  // actions can reuse override/reclassify/confirm against the existing
  // server routes; orphans render a smaller action set.
  const [notInMindBlownItems, setNotInMindBlownItems] = useState<NotInMindBlownItem[]>([]);
  const [notInMindBlownFilter, setNotInMindBlownFilter] = useState<NotInMindBlownFilter>('all');
  const [orphansAvailable, setOrphansAvailable] = useState(true);
  const [orphansError, setOrphansError] = useState<string | null>(null);
  // True orphan count for this map — used to size the drift-audit
  // slider correctly. Comes from the server's pre-pagination count
  // (server > 2026-06-08); pre-2026-06-08 servers omit the field and
  // we fall back to counting the visible items.
  const [orphanTotal, setOrphanTotal] = useState<number | null>(null);
  // Picker mode tracks which not-in-mindblown card opened the modal so
  // the pick handler knows whether to call /override (decision-row
  // buckets) or to create+attach a node from scratch (orphan bucket).
  // Reuses NodePickerModal; cleared after pick or cancel.
  const [notInMindBlownPickerItem, setNotInMindBlownPickerItem] =
    useState<NotInMindBlownItem | null>(null);

  // Drift-audit trigger (manual companion to the daily sweep). The
  // modal opens with a slider defaulted to the current orphan count;
  // operator drops it for a sample run, leaves it for "do them all".
  // `driftBusy` blocks repeat clicks; `driftResult` shows the post-run
  // summary in the panel until the operator dismisses it.
  const [driftModalOpen, setDriftModalOpen] = useState(false);
  const [driftBusy, setDriftBusy] = useState(false);
  const [driftError, setDriftError] = useState<string | null>(null);
  const [driftResult, setDriftResult] = useState<DriftAuditRunResponse | null>(null);

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  // Run the drift audit with the operator-chosen max. On success we
  // close the modal, surface the summary in a dismissible banner, and
  // refresh the not-in-mindblown list so the orphans-just-processed
  // disappear from the orphan bucket and show up as Placed / Pending
  // skipped / Skipped depending on what Claude decided.
  const runDriftAudit = useCallback(
    async (max: number | undefined) => {
      setDriftBusy(true);
      setDriftError(null);
      try {
        const res = await runDriftAuditForMap(mapId, { max });
        setDriftResult(res);
        setDriftModalOpen(false);
        // Pull the not-in-mindblown list fresh so the operator sees
        // immediate movement out of the orphan bucket. The main triage
        // list (Pending tab) will also have new rows; refreshTick
        // covers both.
        setRefreshTick((t) => t + 1);
      } catch (err: unknown) {
        const msg =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Drift audit failed';
        setDriftError(msg);
      } finally {
        setDriftBusy(false);
      }
    },
    [mapId],
  );

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
    // The not-in-mindblown view has its own data source — let its own
    // effect handle the fetch. Skip the legacy decision-list path here
    // so we don't wastefully hit GET /triage-decisions when the
    // operator is looking at the unified view.
    if (view === 'not-in-mindblown') return;
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

  // Not-in-MindBlown data fetch (#140). Runs on view-switch into the new
  // tab, sub-filter change, or refresh tick (after an action like
  // import / mark-as-skip). We send `bucket=all` when the sub-filter is
  // 'all' so the server returns every bucket; otherwise we narrow with
  // the server-side filter. The time-window filter still applies to the
  // decision-row buckets (orphans don't carry a decidedAt — they're
  // included regardless of the time-window setting).
  useEffect(() => {
    if (view !== 'not-in-mindblown') return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    // No `since` here — the time-window filter doesn't apply to this
    // tab (the FilterBar is hidden for it). Orphans don't carry a
    // decidedAt, so a since-filter would silently exclude them and
    // confuse the operator.
    const bucketParam: NotInMindBlownFilter | 'orphans' =
      notInMindBlownFilter === 'orphan' ? 'orphans' : notInMindBlownFilter;
    listNotInMindBlown(mapId, {
      bucket: bucketParam,
      limit: 200,
    })
      .then((res) => {
        if (cancelled) return;
        setNotInMindBlownItems(res.items);
        setOrphansAvailable(res.orphansAvailable);
        setOrphansError(res.orphansError);
        // Prefer the server-supplied per-bucket count. Fall back to
        // null so the trigger banner can fall through to counting
        // visible items (legacy server compatibility).
        setOrphanTotal(res.counts ? res.counts.orphan : null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof ApiError ? err.message : 'Failed to load unified view';
        setError(msg);
        setNotInMindBlownItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mapId, view, refreshTick, notInMindBlownFilter]);

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

  // ── Not-in-MindBlown action handlers (#140) ───────────────────
  //
  // Decision-row buckets (skipped/pending-skipped/uncertain) reuse the
  // existing override/reclassify/confirm routes — the per-card actions
  // dispatch by `triageDecisionId`. Orphans hit the new orphan-import /
  // orphan-skip routes since no decision row exists yet.
  const handleNotInMindBlownPickParent = useCallback(
    async (parentNodeId: string) => {
      const item = notInMindBlownPickerItem;
      if (!item) return;
      setNotInMindBlownPickerItem(null);
      setBusyDecisionId(item.triageDecisionId ?? item.externalId);
      try {
        if (item.kind === 'orphan') {
          await importOrphanIssue(mapId, {
            externalId: item.externalId,
            issueTitle: item.issueTitle,
            issueState: item.issueState,
            parentNodeId,
            reason: 'Operator imported from "Not in MindBlown" view',
          });
        } else if (item.triageDecisionId) {
          await overrideTriageDecision(mapId, item.triageDecisionId, {
            decision: 'place',
            parentNodeId,
            reason: item.reason,
          });
        }
        refresh();
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'Import failed';
        setError(msg);
      } finally {
        setBusyDecisionId(null);
      }
    },
    [mapId, notInMindBlownPickerItem, refresh],
  );

  const handleOrphanSkip = useCallback(
    async (item: NotInMindBlownItem) => {
      if (item.kind !== 'orphan') return;
      setBusyDecisionId(item.externalId);
      try {
        await skipOrphanIssue(mapId, {
          externalId: item.externalId,
          issueTitle: item.issueTitle,
          issueState: item.issueState,
          reason: 'Operator marked orphan as skip from "Not in MindBlown" view',
        });
        refresh();
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'Mark as skip failed';
        setError(msg);
      } finally {
        setBusyDecisionId(null);
      }
    },
    [mapId, refresh],
  );

  const handleNotInMindBlownReclassify = useCallback(
    async (item: NotInMindBlownItem) => {
      if (!item.triageDecisionId) return;
      setBusyDecisionId(item.triageDecisionId);
      try {
        await reclassifyTriageDecision(mapId, item.triageDecisionId);
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

  const handleNotInMindBlownConfirmSkip = useCallback(
    async (item: NotInMindBlownItem) => {
      if (!item.triageDecisionId) return;
      setBusyDecisionId(item.triageDecisionId);
      try {
        // Reconstruct a minimal TriageDecision-shape so confirmTriageDecision
        // can hit the dedicated /confirm route (which takes only the id).
        await confirmTriageDecision(mapId, {
          id: item.triageDecisionId,
        } as TriageDecision);
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
        <TabButton
          testId="triage-tab-not-in-mindblown"
          active={view === 'not-in-mindblown'}
          onClick={() => setView('not-in-mindblown')}
        >
          Not in MindBlown
        </TabButton>
      </div>

      {/* Filter row (#95 Phase 2) — confidence slider + state + window.
          Hidden on the "Not in MindBlown" tab: confidence/state filters
          don't apply to orphans (no decision row), and the time window
          would silently exclude orphans (no decided_at). That view has
          its own sub-filter pills instead. */}
      {view !== 'not-in-mindblown' && (
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
      )}

      {/* Bulk-action toolbar (#95 Phase 2) — select-all + actions.
          Hidden on the unified "Not in MindBlown" tab (#140); that view
          has its own per-card actions and no selection model. */}
      {view !== 'not-in-mindblown' && (
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
      )}

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
        {view === 'not-in-mindblown' ? (
          <NotInMindBlownView
            loading={loading}
            items={notInMindBlownItems}
            filter={notInMindBlownFilter}
            onFilterChange={setNotInMindBlownFilter}
            orphansAvailable={orphansAvailable}
            orphansError={orphansError}
            busyKey={busyDecisionId}
            onImport={(item) => setNotInMindBlownPickerItem(item)}
            onOrphanSkip={handleOrphanSkip}
            onReclassify={handleNotInMindBlownReclassify}
            onConfirmSkip={handleNotInMindBlownConfirmSkip}
            orphanCount={
              orphanTotal ??
              notInMindBlownItems.filter((i) => i.kind === 'orphan').length
            }
            driftBusy={driftBusy}
            driftResult={driftResult}
            driftError={driftError}
            onOpenDriftAudit={() => {
              setDriftError(null);
              setDriftModalOpen(true);
            }}
            onDismissDriftResult={() => setDriftResult(null)}
            onDismissDriftError={() => setDriftError(null)}
          />
        ) : loading ? (
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
              view={view as 'pending' | 'placed' | 'skipped'}
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
          // Pre-select the LLM's suggested parent when the operator
          // opens Override on a place decision. The suggestion column
          // is set on every auto-triage call (high- and low-confidence
          // alike), so the operator confirms with one click instead of
          // re-deriving the suggestion from the `reason` text. If the
          // suggested node was deleted, NodePickerModal silently drops
          // the pre-selection and opens unselected — the "(no longer
          // exists)" badge on the card surfaces that to the operator.
          initialSelectedNodeId={pickerForDecision.suggestedParentNodeId}
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

      {/* Not-in-MindBlown picker modal (#140) — for both orphan
          imports and decision-row → place overrides from the unified
          view. */}
      {notInMindBlownPickerItem && (
        <NodePickerModal
          title={`Import "${notInMindBlownPickerItem.issueTitle}" — pick a parent`}
          excludeNodeIds={[]}
          onPick={handleNotInMindBlownPickParent}
          onClose={() => setNotInMindBlownPickerItem(null)}
        />
      )}

      {/* Drift-audit trigger modal */}
      {driftModalOpen && (
        <DriftAuditModal
          orphanCount={
            orphanTotal ??
            notInMindBlownItems.filter((i) => i.kind === 'orphan').length
          }
          busy={driftBusy}
          error={driftError}
          onCancel={() => {
            setDriftModalOpen(false);
            setDriftError(null);
          }}
          onConfirm={runDriftAudit}
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
  // The "Not in MindBlown" tab has its own card component and no
  // selection model — BulkToolbar is hidden in that view at the call
  // site. Narrow the type so a future regression that re-introduces
  // bulk actions there surfaces as a type error.
  view: 'pending' | 'placed' | 'skipped';
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
  // The legacy three-bucket TriageCard never renders inside the
  // 'not-in-mindblown' tab — that tab has its own card component
  // (NotInMindBlownCard) that handles orphans + decision-row buckets
  // with the unified shape. Narrow the type so a stray case here
  // surfaces at the compile step.
  view: 'pending' | 'placed' | 'skipped';
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

      {/* Suggested-parent badge (place decisions only). The column is
          set on every LLM call regardless of confidence, so a
          low-confidence place that didn't auto-apply still surfaces
          the suggestion here — operator clicks the badge to open the
          Override picker pre-selected on that epic. Hidden on skipped
          / uncertain (the suggestion is meaningless there).

          When the suggested node was deleted between triage time and
          now, we render "(no longer exists)" in muted style so the
          operator knows to re-classify instead of confirming a stale
          suggestion. */}
      {decision.decision === 'place' && decision.suggestedParentNodeId && (
        <SuggestedParentBadge
          suggestedParentNodeId={decision.suggestedParentNodeId}
          onClick={onPlace}
          disabled={busy}
        />
      )}

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

// ── Suggested-parent badge ───────────────────────────────────────
//
// Renders under the reason on `place` decisions whose row has a
// `suggested_parent_node_id` set. The badge text is the suggested
// node's `text` (looked up in the in-memory store, same way the
// NodePickerModal resolves names) — falling back to a muted "(no
// longer exists)" affordance when the suggestion points at a
// deleted node.
//
// Clicking the badge invokes the same handler as the Place/Move
// button. That handler opens the NodePickerModal, which receives
// the suggestion via `initialSelectedNodeId` and pre-highlights it
// — so the operator can confirm with one click or pick a different
// epic. We deliberately don't add a separate "Place with suggested"
// shortcut: pre-selection + confirm IS the one-click flow, and an
// extra button would split the operator's attention between two
// near-identical affordances.

function SuggestedParentBadge({
  suggestedParentNodeId,
  onClick,
  disabled,
}: {
  suggestedParentNodeId: string;
  onClick: () => void;
  disabled: boolean;
}) {
  const nodes = useMindmapStore((s) => s.nodes);
  const suggested = nodes[suggestedParentNodeId];
  const stale = !suggested;
  const label = stale
    ? `${suggestedParentNodeId.slice(0, 8)}… (no longer exists)`
    : suggested.text;
  return (
    <button
      data-testid="triage-card-suggested-parent"
      data-suggested-parent-node-id={suggestedParentNodeId}
      data-suggested-stale={stale ? 'true' : 'false'}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        borderRadius: 4,
        border: '1px dashed #cbd5e1',
        background: 'transparent',
        color: stale ? '#94a3b8' : '#475569',
        fontStyle: stale ? 'italic' : 'normal',
        fontSize: 11,
        fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        textAlign: 'left',
      }}
      title={
        stale
          ? 'Claude suggested a parent that no longer exists in this map — re-classify or pick a different one.'
          : 'Claude suggested this parent. Click to open the picker pre-selected here.'
      }
    >
      <span style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Suggested:
      </span>
      <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </span>
    </button>
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

// ── Not-in-MindBlown view (#140) ──────────────────────────────────
//
// Renders the unified "tickets that aren't on the roadmap" surface:
// sub-filter buttons (All / Skipped / Pending / Uncertain / Orphans)
// at the top, plus a vertical list of per-card items. Each card shows
// the issue link + state, the bucket badge, and a small action set
// matched to the bucket:
//
//   - skipped / uncertain → Import to MindBlown + Re-classify
//   - pending-skipped     → Import + Confirm skip + Re-classify
//   - orphan              → Import + Mark as skip (no decision row exists)
//
// When the orphan branch is unavailable (no GitHub integration, or the
// import call failed) we still render the decision-row items and show
// an inline notice explaining the missing bucket. The notice is muted
// rather than red — the operator can still triage the rest.

function NotInMindBlownView({
  loading,
  items,
  filter,
  onFilterChange,
  orphansAvailable,
  orphansError,
  busyKey,
  onImport,
  onOrphanSkip,
  onReclassify,
  onConfirmSkip,
  orphanCount,
  driftBusy,
  driftResult,
  driftError,
  onOpenDriftAudit,
  onDismissDriftResult,
  onDismissDriftError,
}: {
  loading: boolean;
  items: NotInMindBlownItem[];
  filter: NotInMindBlownFilter;
  onFilterChange: (f: NotInMindBlownFilter) => void;
  orphansAvailable: boolean;
  orphansError: string | null;
  busyKey: string | null;
  onImport: (item: NotInMindBlownItem) => void;
  onOrphanSkip: (item: NotInMindBlownItem) => void;
  onReclassify: (item: NotInMindBlownItem) => void;
  onConfirmSkip: (item: NotInMindBlownItem) => void;
  orphanCount: number;
  driftBusy: boolean;
  driftResult: DriftAuditRunResponse | null;
  driftError: string | null;
  onOpenDriftAudit: () => void;
  onDismissDriftResult: () => void;
  onDismissDriftError: () => void;
}) {
  const filterButtons: Array<{ key: NotInMindBlownFilter; label: string; testId: string }> = [
    { key: 'all', label: 'All', testId: 'not-in-mindblown-filter-all' },
    { key: 'skipped', label: 'Skipped', testId: 'not-in-mindblown-filter-skipped' },
    { key: 'pending-skipped', label: 'Pending', testId: 'not-in-mindblown-filter-pending-skipped' },
    { key: 'uncertain', label: 'Uncertain', testId: 'not-in-mindblown-filter-uncertain' },
    { key: 'orphan', label: 'Orphans', testId: 'not-in-mindblown-filter-orphan' },
  ];
  return (
    <div data-testid="not-in-mindblown-view">
      {/* Sub-filter pills */}
      <div
        data-testid="not-in-mindblown-filter-bar"
        style={{
          padding: '8px 10px',
          borderBottom: '1px solid #f1f5f9',
          background: '#f8fafc',
          display: 'flex',
          gap: 4,
          flexWrap: 'wrap',
        }}
      >
        {filterButtons.map((b) => (
          <button
            key={b.key}
            data-testid={b.testId}
            onClick={() => onFilterChange(b.key)}
            style={{
              padding: '3px 10px',
              borderRadius: 12,
              border: '1px solid #e2e8f0',
              background: filter === b.key ? '#3b82f6' : '#fff',
              color: filter === b.key ? '#fff' : '#475569',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {b.label}
          </button>
        ))}
      </div>

      {/* Orphan-unavailable notice */}
      {!orphansAvailable && (filter === 'all' || filter === 'orphan') && (
        <div
          data-testid="not-in-mindblown-orphans-notice"
          style={{
            padding: '8px 12px',
            background: '#fef3c7',
            color: '#92400e',
            fontSize: 11,
            borderBottom: '1px solid #fde68a',
          }}
        >
          Orphan bucket unavailable: {orphansError ?? 'GitHub fetch failed'}
        </div>
      )}

      {/* Drift-audit trigger row (only shown when orphans are visible
          and at least one exists) */}
      {orphansAvailable && orphanCount > 0 && (filter === 'all' || filter === 'orphan') && (
        <div
          data-testid="drift-audit-trigger-row"
          style={{
            padding: '10px 12px',
            background: '#eff6ff',
            borderBottom: '1px solid #dbeafe',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 11,
            color: '#1e3a8a',
          }}
        >
          <span style={{ flex: 1 }}>
            <strong>{orphanCount}</strong>{' '}
            orphan{orphanCount === 1 ? '' : 's'} waiting. Run Claude on them
            now instead of waiting for the daily sweep.
          </span>
          <button
            data-testid="drift-audit-trigger-btn"
            disabled={driftBusy}
            onClick={onOpenDriftAudit}
            style={{
              padding: '5px 10px',
              borderRadius: 6,
              border: 'none',
              background: driftBusy ? '#94a3b8' : '#2563eb',
              color: '#fff',
              fontSize: 11,
              fontWeight: 600,
              cursor: driftBusy ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {driftBusy ? 'Running…' : 'Run drift audit'}
          </button>
        </div>
      )}

      {/* Drift-audit result banner */}
      {driftResult && (
        <div
          data-testid="drift-audit-result"
          style={{
            padding: '8px 12px',
            background: '#dcfce7',
            color: '#166534',
            fontSize: 11,
            borderBottom: '1px solid #bbf7d0',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
          }}
        >
          <span style={{ flex: 1 }}>
            Drift audit done in{' '}
            {Math.round(driftResult.counts.elapsedMs / 1000)}s. Triaged{' '}
            <strong>{driftResult.counts.triaged}</strong> orphan
            {driftResult.counts.triaged === 1 ? '' : 's'}:{' '}
            <strong>{driftResult.counts.placed}</strong> placed,{' '}
            <strong>{driftResult.counts.skipped}</strong> skipped,{' '}
            <strong>{driftResult.counts.uncertain}</strong> uncertain
            {driftResult.counts.errored > 0
              ? `, ${driftResult.counts.errored} errored`
              : ''}
            {driftResult.counts.queuedForNextRun > 0
              ? `. ${driftResult.counts.queuedForNextRun} above cap — run again to clear.`
              : '.'}
          </span>
          <button
            onClick={onDismissDriftResult}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#166534',
              fontFamily: 'inherit',
              fontSize: 12,
              padding: 0,
            }}
            title="Dismiss"
          >
            x
          </button>
        </div>
      )}

      {/* Drift-audit error banner */}
      {driftError && (
        <div
          data-testid="drift-audit-error"
          style={{
            padding: '8px 12px',
            background: '#fee2e2',
            color: '#991b1b',
            fontSize: 11,
            borderBottom: '1px solid #fecaca',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
          }}
        >
          <span style={{ flex: 1 }}>Drift audit failed: {driftError}</span>
          <button
            onClick={onDismissDriftError}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#991b1b',
              fontFamily: 'inherit',
              fontSize: 12,
              padding: 0,
            }}
            title="Dismiss"
          >
            x
          </button>
        </div>
      )}

      {/* Body */}
      {loading ? (
        <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
          Loading…
        </div>
      ) : items.length === 0 ? (
        <div
          data-testid="not-in-mindblown-empty"
          style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}
        >
          Nothing matches the current filter.
        </div>
      ) : (
        items.map((item) => (
          <NotInMindBlownCard
            key={
              item.triageDecisionId ?? `orphan:${item.externalId}`
            }
            item={item}
            busy={busyKey === (item.triageDecisionId ?? item.externalId)}
            onImport={() => onImport(item)}
            onOrphanSkip={() => onOrphanSkip(item)}
            onReclassify={() => onReclassify(item)}
            onConfirmSkip={() => onConfirmSkip(item)}
          />
        ))
      )}
    </div>
  );
}

function NotInMindBlownCard({
  item,
  busy,
  onImport,
  onOrphanSkip,
  onReclassify,
  onConfirmSkip,
}: {
  item: NotInMindBlownItem;
  busy: boolean;
  onImport: () => void;
  onOrphanSkip: () => void;
  onReclassify: () => void;
  onConfirmSkip: () => void;
}) {
  const bucketBadge = (() => {
    switch (item.kind) {
      case 'skipped':
        return { label: 'Skipped', bg: '#fef3c7', fg: '#854d0e' };
      case 'pending-skipped':
        return { label: 'Pending', bg: '#fef9c3', fg: '#854d0e' };
      case 'uncertain':
        return { label: 'Uncertain', bg: '#e2e8f0', fg: '#475569' };
      case 'orphan':
      default:
        return { label: 'Orphan', bg: '#dbeafe', fg: '#1e40af' };
    }
  })();
  const stateBadge =
    item.issueState === 'closed'
      ? { label: 'closed', bg: '#fee2e2', fg: '#991b1b' }
      : { label: 'open', bg: '#dcfce7', fg: '#166534' };
  return (
    <div
      data-testid="not-in-mindblown-card"
      data-kind={item.kind}
      data-external-id={item.externalId}
      style={{
        padding: 12,
        borderBottom: '1px solid #f1f5f9',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {/* Title row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#1e293b', flex: 1 }}>
          {item.issueTitle}
        </span>
        <span
          data-testid="not-in-mindblown-card-bucket"
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 10,
            background: bucketBadge.bg,
            color: bucketBadge.fg,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            whiteSpace: 'nowrap',
          }}
        >
          {bucketBadge.label}
        </span>
      </div>

      {/* External link + state */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
        <a
          href={item.issueUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="not-in-mindblown-card-link"
          style={{ color: '#3b82f6', textDecoration: 'none' }}
        >
          {item.externalId}
        </a>
        <span
          data-testid="not-in-mindblown-card-state"
          style={{
            fontSize: 9,
            padding: '1px 6px',
            borderRadius: 8,
            background: stateBadge.bg,
            color: stateBadge.fg,
            fontWeight: 600,
            textTransform: 'uppercase',
          }}
        >
          {stateBadge.label}
        </span>
        {item.decidedAt && (
          <>
            <span style={{ color: '#cbd5e1' }}>•</span>
            <span style={{ color: '#94a3b8', fontSize: 10 }}>
              {formatTimeAgo(item.decidedAt)}
            </span>
          </>
        )}
      </div>

      {/* Decision detail or orphan placeholder */}
      {item.kind === 'orphan' ? (
        <div
          data-testid="not-in-mindblown-card-orphan-marker"
          style={{
            fontSize: 11,
            color: '#64748b',
            fontStyle: 'italic',
            padding: 6,
            background: '#f8fafc',
            borderRadius: 4,
          }}
        >
          Not yet triaged — no decision row exists for this issue.
        </div>
      ) : (
        <div
          data-testid="not-in-mindblown-card-reason"
          style={{
            fontSize: 11,
            color: '#475569',
            lineHeight: 1.4,
            padding: 6,
            background: '#f8fafc',
            borderRadius: 4,
            border: '1px solid #f1f5f9',
          }}
        >
          {item.confidence != null && (
            <span style={{ color: '#94a3b8', marginRight: 6 }}>
              {item.confidence}%
            </span>
          )}
          {item.reason ?? ''}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <ActionBtn
          testId="not-in-mindblown-card-import"
          label="Import to MindBlown"
          kind="primary"
          disabled={busy}
          onClick={onImport}
        />
        {item.kind === 'orphan' ? (
          <ActionBtn
            testId="not-in-mindblown-card-mark-skip"
            label="Mark as skip"
            kind="default"
            disabled={busy}
            onClick={onOrphanSkip}
          />
        ) : (
          <ActionBtn
            testId="not-in-mindblown-card-reclassify"
            label={busy ? '…' : 'Re-classify'}
            kind="ghost"
            disabled={busy}
            onClick={onReclassify}
          />
        )}
        {item.kind === 'pending-skipped' && (
          <ActionBtn
            testId="not-in-mindblown-card-confirm-skip"
            label="Confirm skip"
            kind="default"
            disabled={busy}
            onClick={onConfirmSkip}
          />
        )}
      </div>
    </div>
  );
}

// Cost per triage call in USD. Opus pricing: ~1500 input tokens +
// ~200 output tokens at $15/$75 per M = $0.0375 input + $0.015 output ≈ $0.015.
// Conservative; actuals depend on map context size + reason length.
const TRIAGE_COST_USD_PER_ISSUE = 0.015;

// Wall-clock estimate per triage call — measured in production on
// Opus 4.7: ~3s LLM round-trip + ~1s ingest. Round up to 5s headroom
// so the operator's slider-as-progress-bar isn't optimistic.
const TRIAGE_SECONDS_PER_ISSUE = 5;

function DriftAuditModal({
  orphanCount,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  orphanCount: number;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (max: number | undefined) => void;
}) {
  // Slider clamped to [1, orphanCount]; defaults to all-of-them so the
  // common case ("clean up the backlog") is one click.
  const [max, setMax] = useState(orphanCount);

  // Belt-and-braces: if the prop changes (modal reopened after a
  // partial run shrank the backlog), re-seed the slider so we never
  // submit a max > current orphan count.
  useEffect(() => {
    setMax(orphanCount);
  }, [orphanCount]);

  const clampedMax = Math.max(1, Math.min(orphanCount, max));
  const costUsd = clampedMax * TRIAGE_COST_USD_PER_ISSUE;
  const etaSec = clampedMax * TRIAGE_SECONDS_PER_ISSUE;
  const etaText =
    etaSec < 60
      ? `~${etaSec}s`
      : etaSec < 3600
        ? `~${Math.round(etaSec / 60)}min`
        : `~${(etaSec / 3600).toFixed(1)}h`;

  return (
    <div
      data-testid="drift-audit-modal"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.5)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#ffffff',
          borderRadius: 8,
          width: 420,
          maxWidth: '92vw',
          padding: 20,
          boxShadow: '0 20px 40px rgba(15, 23, 42, 0.3)',
          fontFamily: 'inherit',
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15, color: '#1e293b', fontWeight: 700 }}>
          Run drift audit
        </h3>
        <p style={{ margin: '8px 0 16px', fontSize: 12, color: '#475569', lineHeight: 1.5 }}>
          Runs Claude on each orphan in this batch. High-confidence
          places land in MindBlown automatically; lower-confidence rows
          go to Pending review.
        </p>

        <label
          htmlFor="drift-audit-max"
          style={{ display: 'block', fontSize: 11, color: '#475569', marginBottom: 6 }}
        >
          Issues to process:{' '}
          <strong style={{ color: '#1e293b' }}>{clampedMax}</strong>{' '}
          <span style={{ color: '#94a3b8' }}>(of {orphanCount} available)</span>
        </label>
        <input
          id="drift-audit-max"
          data-testid="drift-audit-slider"
          type="range"
          min={1}
          max={orphanCount}
          step={1}
          value={clampedMax}
          onChange={(e) => setMax(Number(e.target.value))}
          disabled={busy}
          style={{ width: '100%', accentColor: '#2563eb' }}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 10,
            color: '#94a3b8',
            marginTop: 2,
          }}
        >
          <span>1 (sample)</span>
          <span>{orphanCount} (all)</span>
        </div>

        <div
          style={{
            marginTop: 14,
            padding: '10px 12px',
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            fontSize: 11,
            color: '#475569',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>
            Estimated cost:{' '}
            <strong style={{ color: '#1e293b' }}>${costUsd.toFixed(2)}</strong>{' '}
            <span style={{ color: '#94a3b8' }}>(Opus, ~1.5k tok/issue)</span>
          </span>
          <span>
            ETA: <strong style={{ color: '#1e293b' }}>{etaText}</strong>
          </span>
        </div>

        {error && (
          <div
            style={{
              marginTop: 12,
              padding: '8px 10px',
              background: '#fee2e2',
              color: '#991b1b',
              borderRadius: 6,
              fontSize: 11,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            marginTop: 16,
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <button
            data-testid="drift-audit-cancel"
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid #cbd5e1',
              background: '#ffffff',
              color: '#475569',
              fontSize: 12,
              cursor: busy ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            data-testid="drift-audit-confirm"
            onClick={() => onConfirm(clampedMax)}
            disabled={busy || orphanCount === 0}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: 'none',
              background: busy ? '#94a3b8' : '#2563eb',
              color: '#ffffff',
              fontSize: 12,
              fontWeight: 600,
              cursor: busy || orphanCount === 0 ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {busy ? 'Running…' : `Run on ${clampedMax}`}
          </button>
        </div>
      </div>
    </div>
  );
}
