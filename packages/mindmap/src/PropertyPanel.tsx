import { useCallback, useEffect, useRef, useState } from 'react';
import type { Node, ComputedNodeValues, Priority, ClaimTrailEntry } from '@mindblown/core';
import { CLAIM_EVENT_TYPES, claimTrail, describeSession, parseSession } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import { CommentsPanel } from './CommentsPanel.js';
import { GitHubNodeSection } from './GitHubPanel.js';
import { AttachmentsSection } from './AttachmentsSection.js';
import { MediaUploadButton } from './MediaUploadButton.js';
import * as api from './api.js';
import type { EstimateResult } from './api.js';

// ── Styles ───────────────────────────────────────────────────────

const PANEL_WIDTH = 320;

const STATUS_OPTIONS = [
  { value: '', label: 'No status' },
  { value: 'todo', label: 'To Do' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
  { value: 'blocked', label: 'Blocked' },
];

const PRIORITY_OPTIONS: Array<{ value: string; label: string; color: string }> = [
  { value: '', label: 'No priority', color: '#94a3b8' },
  { value: 'P0', label: 'P0 - Critical', color: '#dc2626' },
  { value: 'P1', label: 'P1 - High', color: '#ea580c' },
  { value: 'P2', label: 'P2 - Medium', color: '#2563eb' },
  { value: 'P3', label: 'P3 - Low', color: '#6b7280' },
];

const HEALTH_LABELS: Record<string, { text: string; color: string; bg: string }> = {
  on_track: { text: 'On Track', color: '#166534', bg: '#dcfce7' },
  at_risk: { text: 'At Risk', color: '#92400e', bg: '#fef3c7' },
  behind: { text: 'Behind', color: '#991b1b', bg: '#fee2e2' },
};

// ── Debounced field update ───────────────────────────────────────

function useDebouncedUpdate(nodeId: string, delay = 400) {
  const updateNode = useMindmapStore((s) => s.updateNode);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useCallback(
    (updates: Partial<Node>) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        updateNode(nodeId, updates);
      }, delay);
    },
    [nodeId, delay, updateNode],
  );
}

// ── Label + Input row ────────────────────────────────────────────

function Field({
  label,
  children,
  computed,
}: {
  label: string;
  children: React.ReactNode;
  computed?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: '#64748b',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        {label}
        {computed && (
          <span style={{ fontWeight: 400, textTransform: 'none', marginLeft: 4, color: '#94a3b8' }}>
            (computed)
          </span>
        )}
      </label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  fontSize: 13,
  color: '#1e293b',
  fontFamily: 'inherit',
  background: '#fff',
  outline: 'none',
  transition: 'border-color 0.15s',
  boxSizing: 'border-box',
};

const disabledInputStyle: React.CSSProperties = {
  ...inputStyle,
  background: '#f8fafc',
  color: '#94a3b8',
  cursor: 'default',
};

const aiEstimateBtnStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: '#eff6ff',
  color: '#1d4ed8',
  border: '1px solid #bfdbfe',
  borderRadius: 6,
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
  flexShrink: 0,
};

const acceptEstimateBtnStyle: React.CSSProperties = {
  padding: '4px 10px',
  background: '#3b82f6',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 500,
  cursor: 'pointer',
};

const dismissEstimateBtnStyle: React.CSSProperties = {
  padding: '4px 10px',
  background: 'transparent',
  color: '#64748b',
  border: '1px solid #cbd5e1',
  borderRadius: 4,
  fontSize: 11,
  cursor: 'pointer',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2394a3b8' d='M3 4.5L6 8l3-3.5H3z'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 8px center',
  paddingRight: 28,
};

// ── Main component ───────────────────────────────────────────────

export function PropertyPanel() {
  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);
  const nodes = useMindmapStore((s) => s.nodes);
  const computed = useMindmapStore((s) => s.computed);
  const updateNode = useMindmapStore((s) => s.updateNode);

  // The panel follows the selection, but the user can always dismiss it.
  // Dismissal is remembered per node id, so selecting another node (or
  // re-selecting this one after a deselect) brings the panel back.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  const node = selectedNodeId ? nodes[selectedNodeId] : null;
  const cv = selectedNodeId ? computed.get(selectedNodeId) : undefined;
  const isOpen = !!node && selectedNodeId !== dismissedFor;

  // Don't render if closed
  if (!isOpen || !node || !selectedNodeId) {
    return null;
  }

  return (
    <PropertyPanelInner
      key={selectedNodeId}
      node={node}
      nodeId={selectedNodeId}
      computedValues={cv}
      updateNode={updateNode}
      onClose={() => setDismissedFor(selectedNodeId)}
    />
  );
}

function PropertyPanelInner({
  node,
  nodeId,
  computedValues,
  updateNode: directUpdate,
  onClose,
}: {
  node: Node;
  nodeId: string;
  computedValues?: ComputedNodeValues;
  updateNode: (id: string, updates: Partial<Node>) => void;
  onClose: () => void;
}) {
  const debouncedUpdate = useDebouncedUpdate(nodeId);
  const hasChildren = node.childrenIds.length > 0;

  // ── AI Estimate state ─────────────────────────────────────────
  const [estimating, setEstimating] = useState(false);
  const [estimateResult, setEstimateResult] = useState<EstimateResult | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);

  // Local state for text fields
  const [title, setTitle] = useState(node.text);
  const [description, setDescription] = useState(node.description ?? '');
  const [effort, setEffort] = useState(node.effortEstimate?.toString() ?? '');
  const [percent, setPercent] = useState(node.percentComplete ?? 0);
  const [tags, setTags] = useState(node.tags.join(', '));
  const [dueDate, setDueDate] = useState(node.dueDate ?? '');
  const [startDate, setStartDate] = useState(node.startDate ?? '');
  const [blockedReason, setBlockedReason] = useState(node.blockedReason ?? '');
  const [requirementId, setRequirementId] = useState(node.requirementId ?? '');
  const [verificationText, setVerificationText] = useState(node.verificationText ?? '');
  const [verificationUrl, setVerificationUrl] = useState(node.verificationUrl ?? '');
  const [verificationVideoUrl, setVerificationVideoUrl] = useState(node.verificationVideoUrl ?? '');
  const [verificationVideoPosterUrl, setVerificationVideoPosterUrl] = useState(
    node.verificationVideoPosterUrl ?? '',
  );

  // Sync local state when node changes externally
  useEffect(() => { setTitle(node.text); }, [node.text]);
  useEffect(() => { setDescription(node.description ?? ''); }, [node.description]);
  useEffect(() => { setEffort(node.effortEstimate?.toString() ?? ''); }, [node.effortEstimate]);
  useEffect(() => { setPercent(node.percentComplete ?? 0); }, [node.percentComplete]);
  useEffect(() => { setTags(node.tags.join(', ')); }, [node.tags]);
  useEffect(() => { setDueDate(node.dueDate ?? ''); }, [node.dueDate]);
  useEffect(() => { setStartDate(node.startDate ?? ''); }, [node.startDate]);
  useEffect(() => { setBlockedReason(node.blockedReason ?? ''); }, [node.blockedReason]);
  useEffect(() => { setRequirementId(node.requirementId ?? ''); }, [node.requirementId]);
  useEffect(() => { setVerificationText(node.verificationText ?? ''); }, [node.verificationText]);
  useEffect(() => { setVerificationUrl(node.verificationUrl ?? ''); }, [node.verificationUrl]);
  useEffect(() => { setVerificationVideoUrl(node.verificationVideoUrl ?? ''); }, [node.verificationVideoUrl]);
  useEffect(() => { setVerificationVideoPosterUrl(node.verificationVideoPosterUrl ?? ''); }, [node.verificationVideoPosterUrl]);

  const applyServerNode = useMindmapStore((s) => s.applyServerNode);
  const allNodes = useMindmapStore((s) => s.nodes);
  const predecessorTitles = (computedValues?.blockedBy?.predecessorIds ?? [])
    .map((pid) => allNodes[pid]?.text ?? pid);

  const health = computedValues?.healthSignal ?? 'on_track';
  const healthInfo = HEALTH_LABELS[health];

  return (
    <div
      style={{
        width: PANEL_WIDTH,
        // Das Property-Panel steht seit App.tsx:2184 daneben statt in derselben
        // else-Kette, also können zwei Panels nebeneinander liegen. Ohne dies
        // schrumpfen beide, sobald der Platz knapp wird.
        flexShrink: 0,
        height: '100%',
        borderLeft: '1px solid #e2e8f0',
        background: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '16px 16px 12px',
          borderBottom: '1px solid #f1f5f9',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Properties
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close properties panel"
            style={{
              padding: '0 4px',
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              fontSize: 16,
              lineHeight: 1,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            ×
          </button>
        </div>
        <input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            debouncedUpdate({ text: e.target.value });
          }}
          onBlur={() => {
            const trimmed = title.trim();
            if (trimmed && trimmed !== node.text) {
              directUpdate(nodeId, { text: trimmed });
            }
          }}
          onKeyDown={(e) => e.stopPropagation()}
          style={{
            ...inputStyle,
            fontSize: 15,
            fontWeight: 600,
            border: 'none',
            padding: '4px 0',
          }}
          placeholder="Node title"
        />
      </div>

      {/* Scrollable body */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {/* Computed values (read-only) */}
        <div style={{ display: 'flex', gap: 8 }}>
          {/* Health badge */}
          <div
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              background: healthInfo.bg,
              color: healthInfo.color,
              fontSize: 11,
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            {healthInfo.text}
          </div>
          {/* Computed progress */}
          <div
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              background: '#f1f5f9',
              color: '#475569',
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {Math.round(computedValues?.computedProgress ?? 0)}% done
          </div>
          {/* Computed effort */}
          <div
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              background: '#f1f5f9',
              color: '#475569',
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {computedValues?.computedEffort ?? 0}d
          </div>
        </div>

        {/* Description */}
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              debouncedUpdate({ description: e.target.value || null });
            }}
            onKeyDown={(e) => e.stopPropagation()}
            style={{
              ...inputStyle,
              minHeight: 60,
              resize: 'vertical',
              fontFamily: 'inherit',
            }}
            placeholder="Add a description..."
          />
        </Field>

        {/* Status */}
        <Field label="Status">
          <select
            value={node.status ?? ''}
            onChange={(e) => {
              directUpdate(nodeId, { status: e.target.value || null });
            }}
            onKeyDown={(e) => e.stopPropagation()}
            style={selectStyle}
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </Field>

        {/* Blocked reason */}
        <Field label="Blocked reason">
          <input
            value={blockedReason}
            onChange={(e) => {
              setBlockedReason(e.target.value);
              debouncedUpdate({ blockedReason: e.target.value || null });
            }}
            onBlur={() => {
              const trimmed = blockedReason.trim();
              const persisted = node.blockedReason ?? '';
              if (trimmed !== persisted) {
                directUpdate(nodeId, { blockedReason: trimmed || null });
              }
            }}
            onKeyDown={(e) => e.stopPropagation()}
            style={inputStyle}
            placeholder="Why is this blocked? (leave empty if not blocked)"
          />
          {predecessorTitles.length > 0 && (
            <div
              style={{
                marginTop: 6,
                padding: '6px 8px',
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: 6,
                fontSize: 11,
                color: '#991b1b',
              }}
            >
              Waiting on: {predecessorTitles.map((t) => `"${t}"`).join(', ')}
            </div>
          )}
        </Field>

        {/* Priority */}
        <Field label="Priority">
          <select
            value={node.priority ?? ''}
            onChange={(e) => {
              directUpdate(nodeId, { priority: (e.target.value || null) as Priority | null });
            }}
            onKeyDown={(e) => e.stopPropagation()}
            style={selectStyle}
          >
            {PRIORITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </Field>

        {/* Requirement ID — marks this node as a business requirement */}
        <Field label="Requirement ID">
          <input
            value={requirementId}
            onChange={(e) => setRequirementId(e.target.value)}
            onBlur={() => {
              const trimmed = requirementId.trim();
              const persisted = node.requirementId ?? '';
              if (trimmed !== persisted) {
                directUpdate(nodeId, { requirementId: trimmed || null });
              }
            }}
            onKeyDown={(e) => e.stopPropagation()}
            style={inputStyle}
            placeholder="e.g. MAN-01 (marks node as requirement)"
          />
        </Field>

        {/* Requirement priority (MoSCoW) — only relevant with an ID */}
        {(node.requirementId != null || requirementId.trim() !== '') && (
          <Field label="Req. Priority">
            <select
              value={node.requirementPriority ?? ''}
              onChange={(e) => {
                directUpdate(nodeId, {
                  requirementPriority: (e.target.value || null) as Node['requirementPriority'],
                });
              }}
              onKeyDown={(e) => e.stopPropagation()}
              style={selectStyle}
            >
              <option value="">None</option>
              <option value="must">Must (Muss)</option>
              <option value="should">Should (Soll)</option>
              <option value="could">Could (Kann)</option>
            </select>
          </Field>
        )}

        {/* Verification how-to + deep link — the review surface reads these */}
        {(node.requirementId != null || requirementId.trim() !== '') && (
          <>
            <Field label="How to verify">
              <textarea
                value={verificationText}
                onChange={(e) => setVerificationText(e.target.value)}
                onBlur={() => {
                  const trimmed = verificationText.trim();
                  const persisted = node.verificationText ?? '';
                  if (trimmed !== persisted) {
                    directUpdate(nodeId, { verificationText: trimmed || null });
                  }
                }}
                onKeyDown={(e) => e.stopPropagation()}
                style={{
                  ...inputStyle,
                  minHeight: 80,
                  resize: 'vertical',
                  fontFamily: 'inherit',
                }}
                placeholder={'How is this checked? Markdown, e.g.\n1. Sign in as …\n2. …\n\n**Expected:** …\n**Test data:** …'}
              />
            </Field>
            <Field label="Where to check">
              <input
                value={verificationUrl}
                onChange={(e) => setVerificationUrl(e.target.value)}
                onBlur={() => {
                  const trimmed = verificationUrl.trim();
                  const persisted = node.verificationUrl ?? '';
                  if (trimmed !== persisted) {
                    directUpdate(nodeId, { verificationUrl: trimmed || null });
                  }
                }}
                onKeyDown={(e) => e.stopPropagation()}
                style={inputStyle}
                placeholder="https://staging… (where is it checked?)"
              />
            </Field>
            <Field label="Demo video">
              <input
                value={verificationVideoUrl}
                onChange={(e) => setVerificationVideoUrl(e.target.value)}
                onBlur={() => {
                  const trimmed = verificationVideoUrl.trim();
                  const persisted = node.verificationVideoUrl ?? '';
                  if (trimmed !== persisted) {
                    directUpdate(nodeId, { verificationVideoUrl: trimmed || null });
                  }
                }}
                onKeyDown={(e) => e.stopPropagation()}
                style={inputStyle}
                placeholder="https://… (short demo clip)"
              />
              {/* The field still takes a pasted URL — YouTube, a link from
                  somewhere else. The upload is the second way in, for the
                  common case where the clip only exists on the recorder's
                  own machine. Writing straight through `directUpdate`
                  rather than waiting for a blur: the user never typed
                  anything, so there is no blur to wait for. */}
              <MediaUploadButton
                accept="video/*"
                label="Upload video…"
                onUploaded={(media) => {
                  setVerificationVideoUrl(media.url);
                  directUpdate(nodeId, { verificationVideoUrl: media.url });
                }}
              />
            </Field>
            {/* Its own field rather than something derived from the clip:
                the browser cannot pick a representative frame, and the
                one it would show for free — frame 0 — is the blank page
                the screen recorder was still waiting on. Directly under
                the video link because it is only read when that is set. */}
            <Field label="Video poster">
              <input
                value={verificationVideoPosterUrl}
                onChange={(e) => setVerificationVideoPosterUrl(e.target.value)}
                onBlur={() => {
                  const trimmed = verificationVideoPosterUrl.trim();
                  const persisted = node.verificationVideoPosterUrl ?? '';
                  if (trimmed !== persisted) {
                    directUpdate(nodeId, { verificationVideoPosterUrl: trimmed || null });
                  }
                }}
                onKeyDown={(e) => e.stopPropagation()}
                style={inputStyle}
                placeholder="https://… (still frame for the player)"
              />
              <MediaUploadButton
                accept="image/*"
                label="Upload poster…"
                onUploaded={(media) => {
                  setVerificationVideoPosterUrl(media.url);
                  directUpdate(nodeId, { verificationVideoPosterUrl: media.url });
                }}
              />
            </Field>
          </>
        )}

        {/* Effort estimate */}
        <Field label="Effort Estimate" computed={hasChildren}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="number"
              min={0}
              value={hasChildren ? (computedValues?.computedEffort ?? '') : effort}
              onChange={(e) => {
                if (hasChildren) return;
                setEffort(e.target.value);
                const val = e.target.value ? parseFloat(e.target.value) : null;
                debouncedUpdate({ effortEstimate: val });
              }}
              onKeyDown={(e) => e.stopPropagation()}
              disabled={hasChildren}
              style={{ ...(hasChildren ? disabledInputStyle : inputStyle), flex: 1 }}
              placeholder={hasChildren ? 'Computed from children' : '0'}
            />
            {!hasChildren && (
              <button
                type="button"
                onClick={async () => {
                  setEstimating(true);
                  setEstimateError(null);
                  setEstimateResult(null);
                  try {
                    const res = await api.aiEstimate(node.mapId, { nodeId });
                    setEstimateResult(res);
                  } catch (err: any) {
                    setEstimateError(err.message || 'Failed to get AI estimate');
                  } finally {
                    setEstimating(false);
                  }
                }}
                disabled={estimating}
                style={aiEstimateBtnStyle}
                title="AI Estimate: predicts effort from past completed items"
              >
                {estimating ? '…' : 'AI'}
              </button>
            )}
          </div>
          {estimateError && (
            <div style={{ color: '#dc2626', fontSize: 11, marginTop: 4 }}>{estimateError}</div>
          )}
          {estimateResult && !hasChildren && (
            <div
              style={{
                marginTop: 6,
                padding: '6px 8px',
                background: '#eff6ff',
                border: '1px solid #bfdbfe',
                borderRadius: 6,
                fontSize: 11,
                color: '#1e40af',
              }}
            >
              <div style={{ fontWeight: 600 }}>
                Suggested: {estimateResult.estimate} {estimateResult.effortUnit}
                {' '}
                <span style={{ fontWeight: 400, color: '#3b82f6' }}>
                  ({estimateResult.confidence} confidence, {estimateResult.samplesUsed} samples
                  {estimateResult.fudgeFactor != null
                    ? `, fudge ×${estimateResult.fudgeFactor} applied at forecast time`
                    : ''})
                </span>
              </div>
              {estimateResult.notes && (
                <div style={{ color: '#475569', marginTop: 2 }}>{estimateResult.notes}</div>
              )}
              <div style={{ marginTop: 4, display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => {
                    setEffort(String(estimateResult.estimate));
                    debouncedUpdate({ effortEstimate: estimateResult.estimate });
                    setEstimateResult(null);
                  }}
                  style={acceptEstimateBtnStyle}
                >
                  Accept
                </button>
                <button
                  type="button"
                  onClick={() => setEstimateResult(null)}
                  style={dismissEstimateBtnStyle}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </Field>

        {/* % Complete */}
        <Field label="% Complete" computed={hasChildren}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={hasChildren ? Math.round(computedValues?.computedProgress ?? 0) : percent}
              onChange={(e) => {
                if (hasChildren) return;
                const val = parseInt(e.target.value, 10);
                setPercent(val);
                directUpdate(nodeId, { percentComplete: val });
              }}
              disabled={hasChildren}
              style={{ flex: 1, accentColor: '#4f46e5' }}
            />
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: hasChildren ? '#94a3b8' : '#1e293b',
                minWidth: 36,
                textAlign: 'right',
              }}
            >
              {hasChildren ? Math.round(computedValues?.computedProgress ?? 0) : percent}%
            </span>
          </div>
        </Field>

        {/* Dates */}
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <Field label="Start Date">
              <input
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  directUpdate(nodeId, { startDate: e.target.value || null });
                }}
                onKeyDown={(e) => e.stopPropagation()}
                style={inputStyle}
              />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Due Date">
              <input
                type="date"
                value={dueDate}
                onChange={(e) => {
                  setDueDate(e.target.value);
                  directUpdate(nodeId, { dueDate: e.target.value || null });
                }}
                onKeyDown={(e) => e.stopPropagation()}
                style={inputStyle}
              />
            </Field>
          </div>
        </div>

        {/* Tags */}
        <Field label="Tags">
          <input
            value={tags}
            onChange={(e) => {
              setTags(e.target.value);
              const parsed = e.target.value
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean);
              debouncedUpdate({ tags: parsed });
            }}
            onKeyDown={(e) => e.stopPropagation()}
            style={inputStyle}
            placeholder="tag1, tag2, ..."
          />
        </Field>

        {/* Assignees */}
        <AssigneeField nodeId={nodeId} assigneeIds={node.assigneeIds} />

        {/* Sprint / Cycle */}
        <CycleField nodeId={nodeId} currentCycleId={node.cycleId} />

        {/* Phase */}
        <PhaseField nodeId={nodeId} currentPhaseId={node.phaseId} />

        {/* Divider */}
        <div style={{ height: 1, background: '#f1f5f9', margin: '4px 0' }} />

        {/* Attachments — files and links, on every node, not just
            requirements. Unlike the verification block above, this doesn't
            wait for a Requirement ID: hanging a document on a task is
            useful long before that task is a formally tracked requirement. */}
        <Field label="Attachments">
          <AttachmentsSection
            attachments={node.attachments ?? []}
            onAdd={async (attachment) => {
              applyServerNode(await api.addAttachment(node.mapId, nodeId, attachment));
            }}
            onRemove={async (attachmentId) => {
              applyServerNode(await api.removeAttachment(node.mapId, nodeId, attachmentId));
            }}
          />
        </Field>

        {/* Divider */}
        <div style={{ height: 1, background: '#f1f5f9', margin: '4px 0' }} />

        {/* Fleet trail — who picked the node up, released it, delivered it.
            Reads the claim events, not claimedBySession: that field is
            nulled on done, so the node alone can't say who delivered it. */}
        <FleetTrailSection node={node} />

        {/* GitHub section */}
        <GitHubNodeSection mapId={node.mapId} node={node} />

        {/* Divider */}
        <div style={{ height: 1, background: '#f1f5f9', margin: '4px 0' }} />

        {/* Comments section */}
        <CommentsPanel mapId={node.mapId} nodeId={nodeId} />
      </div>
    </div>
  );
}

// ── Fleet trail ──────────────────────────────────────────────────

const TRAIL_KIND_COLOR: Record<ClaimTrailEntry['kind'], string> = {
  claimed: '#2563eb',
  released: '#64748b',
  delivered: '#166534',
  done: '#166534',
};

function formatTrailTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function FleetTrailSection({ node }: { node: Node }) {
  const [entries, setEntries] = useState<ClaimTrailEntry[]>([]);
  const [failed, setFailed] = useState(false);

  // Re-fetch on the node fields a claim write touches, so a release or a
  // done-transition pushed over the socket shows up without reopening
  // the panel.
  const { id: nodeId, mapId, claimedBySession, status, completedAt, actualEffort } = node;
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    api
      .fetchChangeHistory(mapId, { nodeId, eventTypes: CLAIM_EVENT_TYPES, limit: 50 })
      .then(({ events }) => {
        if (!cancelled) setEntries(claimTrail(events, { completedAt, actualEffort }));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [mapId, nodeId, claimedBySession, status, completedAt, actualEffort]);

  if (entries.length === 0 && !claimedBySession) return null;

  const holder = claimedBySession
    ? describeSession({ session: claimedBySession, ...parseSession(claimedBySession) })
    : null;

  return (
    <>
      <Field label="Fleet trail">
        {holder && (
          <div
            style={{
              fontSize: 12,
              padding: '4px 8px',
              borderRadius: 6,
              background: '#dbeafe',
              color: '#1e40af',
              fontWeight: 600,
            }}
            title={claimedBySession ?? undefined}
          >
            held by {holder}
          </div>
        )}
        {failed && (
          <div style={{ fontSize: 12, color: '#94a3b8' }}>Trail unavailable</div>
        )}
        {entries.length > 0 && (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {entries.map((e, i) => (
              <li
                key={`${e.at}-${e.kind}-${i}`}
                style={{ display: 'flex', gap: 8, fontSize: 12, lineHeight: '16px' }}
                title={e.session ?? undefined}
              >
                <span style={{ color: '#94a3b8', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                  {formatTrailTime(e.at)}
                </span>
                <span
                  style={{
                    color: TRAIL_KIND_COLOR[e.kind],
                    fontWeight: e.session !== null && e.session === claimedBySession && e.kind === 'claimed' ? 600 : 400,
                  }}
                >
                  {e.text}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Field>

      {/* Divider */}
      <div style={{ height: 1, background: '#f1f5f9', margin: '4px 0' }} />
    </>
  );
}

// ── Assignee Field ───────────────────────────────────────────────
//
// The write surface `assigneeIds` never had. Every other view already
// renders assignees (Kanban avatars, List column, Calendar, Workload
// bars) but nothing could set one, so the field was empty everywhere and
// those surfaces silently degraded.
//
// Candidates come from the map's member list (everyone with a permission
// on it). Ids already on a node that no longer resolve to a member — a
// revoked collaborator, or an id written over MCP — are still listed and
// still removable, so opening the panel can never silently drop data the
// picker doesn't understand.

function AssigneeField({ nodeId, assigneeIds }: { nodeId: string; assigneeIds: string[] }) {
  const members = useMindmapStore((s) => s.members);
  const loadMembers = useMindmapStore((s) => s.loadMembers);
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const updateNode = useMindmapStore((s) => s.updateNode);

  useEffect(() => {
    void loadMembers();
  }, [currentMapId, loadMembers]);

  const toggle = useCallback(
    (userId: string) => {
      const next = assigneeIds.includes(userId)
        ? assigneeIds.filter((id) => id !== userId)
        : [...assigneeIds, userId];
      updateNode(nodeId, { assigneeIds: next });
    },
    [nodeId, assigneeIds, updateNode],
  );

  const known = new Set(members.map((m) => m.userId));
  const orphans = assigneeIds.filter((id) => !known.has(id));

  return (
    <Field label="Assignees">
      {members.length === 0 && orphans.length === 0 ? (
        <div style={{ fontSize: 12, color: '#94a3b8' }}>
          Nobody has access to this map yet — share it to assign work.
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {members.map((m) => {
            const active = assigneeIds.includes(m.userId);
            return (
              <button
                key={m.userId}
                onClick={() => toggle(m.userId)}
                title={m.email}
                style={{
                  padding: '4px 10px',
                  borderRadius: 999,
                  border: active ? '1px solid #4f46e5' : '1px solid #e2e8f0',
                  background: active ? '#eef2ff' : '#fff',
                  color: active ? '#3730a3' : '#64748b',
                  fontSize: 12,
                  fontWeight: active ? 600 : 400,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {m.name}
              </button>
            );
          })}
          {orphans.map((id) => (
            <button
              key={id}
              onClick={() => toggle(id)}
              title={`${id} — no longer has access to this map. Click to remove.`}
              style={{
                padding: '4px 10px',
                borderRadius: 999,
                border: '1px dashed #cbd5e1',
                background: '#f8fafc',
                color: '#94a3b8',
                fontSize: 12,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {id.length > 12 ? `${id.slice(0, 10)}…` : id} ✕
            </button>
          ))}
        </div>
      )}
    </Field>
  );
}

// ── Phase Field ──────────────────────────────────────────────────
//
// Select over the map's PhaseDefs (statusWorkflow idiom), ordered by
// position. Sits next to Version/Sprint — a phase is a lightweight
// label reference (node.phaseId), not a heavy entity.

function PhaseField({
  nodeId,
  currentPhaseId,
}: {
  nodeId: string;
  currentPhaseId: string | null;
}) {
  const currentMap = useMindmapStore((s) => s.currentMap);
  const updateNode = useMindmapStore((s) => s.updateNode);

  const phases = [...(currentMap?.phases ?? [])].sort((a, b) => a.position - b.position);

  return (
    <Field label="Phase">
      <select
        value={currentPhaseId ?? ''}
        onChange={(e) => updateNode(nodeId, { phaseId: e.target.value || null })}
        onKeyDown={(e) => e.stopPropagation()}
        style={selectStyle}
      >
        <option value="">None</option>
        {phases.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

// ── Cycle Field ──────────────────────────────────────────────────

function CycleField({
  nodeId,
  currentCycleId,
}: {
  nodeId: string;
  currentCycleId: string | null;
}) {
  const cycles = useMindmapStore((s) => s.cycles);
  const assignNodeToCycle = useMindmapStore((s) => s.assignNodeToCycle);
  const unassignNodeFromCycle = useMindmapStore((s) => s.unassignNodeFromCycle);
  const loadCycles = useMindmapStore((s) => s.loadCycles);

  // Load cycles if not loaded yet
  useEffect(() => {
    if (cycles.length === 0) {
      loadCycles();
    }
  }, [cycles.length, loadCycles]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newCycleId = e.target.value || null;
      if (newCycleId === currentCycleId) return;

      if (currentCycleId && !newCycleId) {
        unassignNodeFromCycle(nodeId, currentCycleId);
      } else if (newCycleId) {
        // If previously assigned, unassign first (the backend may handle this automatically)
        assignNodeToCycle(nodeId, newCycleId);
      }
    },
    [nodeId, currentCycleId, assignNodeToCycle, unassignNodeFromCycle],
  );

  return (
    <Field label="Sprint / Cycle">
      <select
        value={currentCycleId ?? ''}
        onChange={handleChange}
        onKeyDown={(e) => e.stopPropagation()}
        style={selectStyle}
      >
        <option value="">None</option>
        {cycles.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.status})
          </option>
        ))}
      </select>
    </Field>
  );
}
