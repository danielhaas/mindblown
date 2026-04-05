import { useCallback, useEffect, useRef, useState } from 'react';
import type { Node, ComputedNodeValues, Priority } from '@mindblown/core';
import { useMindmapStore } from './store.js';

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

  const node = selectedNodeId ? nodes[selectedNodeId] : null;
  const cv = selectedNodeId ? computed.get(selectedNodeId) : undefined;
  const isOpen = !!node;

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
    />
  );
}

function PropertyPanelInner({
  node,
  nodeId,
  computedValues,
  updateNode: directUpdate,
}: {
  node: Node;
  nodeId: string;
  computedValues?: ComputedNodeValues;
  updateNode: (id: string, updates: Partial<Node>) => void;
}) {
  const debouncedUpdate = useDebouncedUpdate(nodeId);
  const hasChildren = node.childrenIds.length > 0;

  // Local state for text fields
  const [title, setTitle] = useState(node.text);
  const [description, setDescription] = useState(node.description ?? '');
  const [effort, setEffort] = useState(node.effortEstimate?.toString() ?? '');
  const [percent, setPercent] = useState(node.percentComplete ?? 0);
  const [tags, setTags] = useState(node.tags.join(', '));
  const [dueDate, setDueDate] = useState(node.dueDate ?? '');
  const [startDate, setStartDate] = useState(node.startDate ?? '');

  // Sync local state when node changes externally
  useEffect(() => { setTitle(node.text); }, [node.text]);
  useEffect(() => { setDescription(node.description ?? ''); }, [node.description]);
  useEffect(() => { setEffort(node.effortEstimate?.toString() ?? ''); }, [node.effortEstimate]);
  useEffect(() => { setPercent(node.percentComplete ?? 0); }, [node.percentComplete]);
  useEffect(() => { setTags(node.tags.join(', ')); }, [node.tags]);
  useEffect(() => { setDueDate(node.dueDate ?? ''); }, [node.dueDate]);
  useEffect(() => { setStartDate(node.startDate ?? ''); }, [node.startDate]);

  const health = computedValues?.healthSignal ?? 'on_track';
  const healthInfo = HEALTH_LABELS[health];

  return (
    <div
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
          padding: '16px 16px 12px',
          borderBottom: '1px solid #f1f5f9',
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
          Properties
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

        {/* Effort estimate */}
        <Field label="Effort Estimate" computed={hasChildren}>
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
            style={hasChildren ? disabledInputStyle : inputStyle}
            placeholder={hasChildren ? 'Computed from children' : '0'}
          />
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

        {/* Sprint / Cycle */}
        <CycleField nodeId={nodeId} currentCycleId={node.cycleId} />

        {/* Milestone toggle */}
        <Field label="Milestone">
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              color: '#1e293b',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={node.isMilestone}
              onChange={(e) => directUpdate(nodeId, { isMilestone: e.target.checked })}
              style={{ accentColor: '#8b5cf6' }}
            />
            Mark as milestone (zero-effort checkpoint)
          </label>
        </Field>
      </div>
    </div>
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
