/**
 * Triage review panel (#94 — Phase 1 frontend).
 *
 * Three sub-views (Pending / Skipped / Placed) showing AI triage
 * decisions for the current map. Operator actions per row:
 *
 *   - Confirm    — mark the row reviewed, keep the auto decision.
 *   - Override   — pick a different parent via the node-picker modal,
 *                  optionally change decision (skip / uncertain).
 *   - Re-classify — re-run the LLM against the current map context.
 *
 * Lives alongside BlockedPanel / SprintPanel — same right-docked
 * 380px width, same close-button pattern. The map header's
 * TriageIndicator button toggles it. Phase 0's backend exposes the
 * three routes; Phase 2 adds bulk operations.
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
  confirmTriageDecision,
  listTriageDecisions,
  overrideTriageDecision,
  reclassifyTriageDecision,
  type TriageDecision,
  type TriageDecisionKind,
} from './api.js';
import { NodePickerModal } from './NodePickerModal.js';

const PANEL_WIDTH = 420;

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
  const [busyDecisionId, setBusyDecisionId] = useState<string | null>(null);
  const [pickerForDecision, setPickerForDecision] = useState<TriageDecision | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Server-side filter for the active sub-view. Pending = unreviewed;
    // Placed = decision=place AND (reviewed OR placedNodeId set); Skipped
    // = decision=skip AND reviewed. We pull each view fresh because the
    // server count is authoritative — Phase 2 will switch to a single
    // "all decisions" pull + client-side bucketing if perf demands it.
    const filters =
      view === 'pending'
        ? { reviewed: false, limit: 200 }
        : view === 'placed'
          ? { decision: 'place' as TriageDecisionKind, reviewed: true, limit: 200 }
          : { decision: 'skip' as TriageDecisionKind, reviewed: true, limit: 200 };
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
  }, [mapId, view, refreshTick]);

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
        to reparent, Re-classify to re-run.
      </div>

      {/* Node picker modal */}
      {pickerForDecision && (
        <NodePickerModal
          title={`Pick a parent for "${pickerForDecision.issueTitle}"`}
          excludeNodeIds={pickerForDecision.placedNodeId ? [pickerForDecision.placedNodeId] : []}
          onPick={handlePickParent}
          onClose={() => setPickerForDecision(null)}
        />
      )}
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
  onConfirm,
  onPlace,
  onReclassify,
  onSkip,
  onUncertain,
}: {
  decision: TriageDecision;
  view: SubView;
  busy: boolean;
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
      }}
    >
      {/* Title row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
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
