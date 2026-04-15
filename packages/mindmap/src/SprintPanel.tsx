import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Cycle, NodeId } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';

// ── Constants ────────────────────────────────────────────────────

const PANEL_WIDTH = 380;

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  planned: { bg: '#e2e8f0', fg: '#475569' },
  active: { bg: '#dbeafe', fg: '#1d4ed8' },
  completed: { bg: '#dcfce7', fg: '#166534' },
};

// ── Helpers ──────────────────────────────────────────────────────

function formatDateRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[s.getMonth()]} ${s.getDate()} - ${months[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

// ── Shared styles ────────────────────────────────────────────────

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
  boxSizing: 'border-box',
};

const btnStyle: React.CSSProperties = {
  padding: '6px 14px',
  borderRadius: 6,
  border: 'none',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
  transition: 'background 0.15s',
};

// ── Sprint Create Form ──────────────────────────────────────────

function CreateSprintForm({ onClose }: { onClose: () => void }) {
  const createCycle = useMindmapStore((s) => s.createCycle);
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!name.trim() || !startDate || !endDate) return;
    setSaving(true);
    await createCycle(name.trim(), startDate, endDate);
    setSaving(false);
    onClose();
  }, [name, startDate, endDate, createCycle, onClose]);

  return (
    <div
      style={{
        padding: 16,
        borderBottom: '1px solid #e2e8f0',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: '#f8fafc',
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>New Sprint</div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') handleSubmit();
          if (e.key === 'Escape') onClose();
        }}
        placeholder="Sprint name"
        style={inputStyle}
        autoFocus
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8' }}>Start</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            style={inputStyle}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8' }}>End</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            style={inputStyle}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={{ ...btnStyle, background: '#f1f5f9', color: '#475569' }}>
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={saving || !name.trim() || !startDate || !endDate}
          style={{
            ...btnStyle,
            background: saving ? '#a5b4fc' : '#4f46e5',
            color: '#fff',
            opacity: !name.trim() || !startDate || !endDate ? 0.5 : 1,
          }}
        >
          {saving ? 'Creating...' : 'Create'}
        </button>
      </div>
    </div>
  );
}

// ── Sprint Edit Form ────────────────────────────────────────────

function EditSprintForm({
  cycle,
  onClose,
}: {
  cycle: Cycle;
  onClose: () => void;
}) {
  const updateCycle = useMindmapStore((s) => s.updateCycle);
  const [name, setName] = useState(cycle.name);
  const [startDate, setStartDate] = useState(cycle.startDate.slice(0, 10));
  const [endDate, setEndDate] = useState(cycle.endDate.slice(0, 10));
  const [saving, setSaving] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!name.trim() || !startDate || !endDate) return;
    setSaving(true);
    await updateCycle(cycle.id, { name: name.trim(), startDate, endDate });
    setSaving(false);
    onClose();
  }, [name, startDate, endDate, updateCycle, cycle.id, onClose]);

  return (
    <div
      style={{
        padding: 16,
        borderBottom: '1px solid #e2e8f0',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: '#fefce8',
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>Edit Sprint</div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') handleSubmit();
          if (e.key === 'Escape') onClose();
        }}
        placeholder="Sprint name"
        style={inputStyle}
        autoFocus
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8' }}>Start</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            style={inputStyle}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8' }}>End</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            style={inputStyle}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={{ ...btnStyle, background: '#f1f5f9', color: '#475569' }}>
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={saving}
          style={{ ...btnStyle, background: '#4f46e5', color: '#fff' }}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ── Sprint Node List ────────────────────────────────────────────

function SprintNodeList({ cycleId }: { cycleId: string }) {
  const nodes = useMindmapStore((s) => s.nodes);
  const computed = useMindmapStore((s) => s.computed);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);

  const assignedNodes = useMemo(
    () => Object.values(nodes).filter((n) => n.cycleId === cycleId),
    [nodes, cycleId],
  );

  if (assignedNodes.length === 0) {
    return (
      <div style={{ padding: '12px 16px', fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }}>
        No nodes assigned to this sprint. Select a node and assign it via the property panel.
      </div>
    );
  }

  return (
    <div style={{ padding: '4px 0' }}>
      {assignedNodes.map((node) => {
        const cv = computed.get(node.id as NodeId);
        const progress = cv?.computedProgress ?? node.percentComplete ?? 0;
        const isDone = node.status === 'done' || node.status === 'Done' || progress >= 100;
        const isSelected = node.id === selectedNodeId;

        return (
          <div
            key={node.id}
            onClick={() => selectNode(node.id)}
            style={{
              padding: '6px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              cursor: 'pointer',
              background: isSelected ? '#eef2ff' : 'transparent',
              transition: 'background 0.1s',
              fontSize: 12,
            }}
            onMouseEnter={(e) => {
              if (!isSelected) e.currentTarget.style.background = '#f8fafc';
            }}
            onMouseLeave={(e) => {
              if (!isSelected) e.currentTarget.style.background = 'transparent';
            }}
          >
            {/* Completion checkbox */}
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                border: isDone ? '2px solid #059669' : '2px solid #cbd5e1',
                background: isDone ? '#059669' : 'transparent',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {isDone && (
                <svg width="8" height="8" viewBox="0 0 8 8">
                  <path d="M1.5 4L3 5.5L6.5 2" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" />
                </svg>
              )}
            </div>
            <span
              style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: isDone ? '#94a3b8' : '#1e293b',
                textDecoration: isDone ? 'line-through' : 'none',
              }}
            >
              {node.text}
            </span>
            <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 500, flexShrink: 0 }}>
              {Math.round(progress)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Sprint Card ─────────────────────────────────────────────────

function SprintCard({
  cycle,
  isExpanded,
  onToggleExpand,
}: {
  cycle: Cycle;
  isExpanded: boolean;
  onToggleExpand: () => void;
}) {
  const nodes = useMindmapStore((s) => s.nodes);
  const updateCycle = useMindmapStore((s) => s.updateCycle);
  const deleteCycle = useMindmapStore((s) => s.deleteCycle);
  const cycles = useMindmapStore((s) => s.cycles);
  const activeCycleFilter = useMindmapStore((s) => s.activeCycleFilter);
  const setActiveCycleFilter = useMindmapStore((s) => s.setActiveCycleFilter);

  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [rollingOver, setRollingOver] = useState(false);

  // Compute progress for this cycle
  const assignedNodes = useMemo(
    () => Object.values(nodes).filter((n) => n.cycleId === cycle.id),
    [nodes, cycle.id],
  );
  const totalNodes = assignedNodes.length;
  const doneNodes = assignedNodes.filter(
    (n) => n.status === 'done' || n.status === 'Done' || (n.percentComplete ?? 0) >= 100,
  ).length;
  const progress = totalNodes > 0 ? (doneNodes / totalNodes) * 100 : 0;

  const statusInfo = STATUS_COLORS[cycle.status] ?? STATUS_COLORS.planned;
  const isFilterActive = activeCycleFilter === cycle.id;

  const handleStatusChange = useCallback(
    (newStatus: 'planned' | 'active' | 'completed') => {
      updateCycle(cycle.id, { status: newStatus });
    },
    [updateCycle, cycle.id],
  );

  const handleDelete = useCallback(() => {
    deleteCycle(cycle.id);
    setConfirmDelete(false);
  }, [deleteCycle, cycle.id]);

  const handleRollover = useCallback(async () => {
    // Find the next planned sprint
    const nextPlanned = cycles.find(
      (c) => c.status === 'planned' && c.id !== cycle.id,
    );
    if (!nextPlanned) {
      alert('No planned sprint to roll over to. Create a new sprint first.');
      return;
    }
    setRollingOver(true);
    try {
      await api.rolloverCycle(cycle.id, nextPlanned.id);
      // Reload to see changes
      useMindmapStore.getState().loadCycles();
      if (useMindmapStore.getState().currentMapId) {
        useMindmapStore.getState().loadMap(useMindmapStore.getState().currentMapId!);
      }
    } catch {
      useMindmapStore.setState({ error: 'Failed to rollover sprint' });
    }
    setRollingOver(false);
  }, [cycle.id, cycles]);

  if (editing) {
    return <EditSprintForm cycle={cycle} onClose={() => setEditing(false)} />;
  }

  return (
    <div
      style={{
        borderBottom: '1px solid #f1f5f9',
      }}
    >
      {/* Sprint header */}
      <div
        style={{
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
        }}
        onClick={onToggleExpand}
      >
        {/* Expand arrow */}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="#94a3b8"
          style={{
            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
            flexShrink: 0,
          }}
        >
          <path d="M3 1L8 5L3 9z" />
        </svg>

        {/* Name + date */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{cycle.name}</div>
          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>
            {formatDateRange(cycle.startDate, cycle.endDate)}
          </div>
        </div>

        {/* Status badge */}
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 4,
            background: statusInfo.bg,
            color: statusInfo.fg,
            flexShrink: 0,
          }}
        >
          {cycle.status}
        </span>

        {/* Progress */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <div
            style={{
              width: 40,
              height: 4,
              borderRadius: 2,
              background: '#e2e8f0',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${Math.round(progress)}%`,
                height: '100%',
                background: progress >= 100 ? '#059669' : '#4f46e5',
                borderRadius: 2,
                transition: 'width 0.3s',
              }}
            />
          </div>
          <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 500, minWidth: 24 }}>
            {doneNodes}/{totalNodes}
          </span>
        </div>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div>
          {/* Actions bar */}
          <div
            style={{
              padding: '0 16px 8px',
              display: 'flex',
              gap: 6,
              flexWrap: 'wrap',
            }}
          >
            {/* Filter toggle */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setActiveCycleFilter(isFilterActive ? null : cycle.id);
              }}
              style={{
                ...btnStyle,
                padding: '4px 10px',
                fontSize: 10,
                background: isFilterActive ? '#4f46e5' : '#f1f5f9',
                color: isFilterActive ? '#fff' : '#475569',
              }}
            >
              {isFilterActive ? 'Clear Filter' : 'Filter Views'}
            </button>

            {/* Status buttons */}
            {cycle.status !== 'active' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleStatusChange('active');
                }}
                style={{
                  ...btnStyle,
                  padding: '4px 10px',
                  fontSize: 10,
                  background: '#dbeafe',
                  color: '#1d4ed8',
                }}
              >
                Mark Active
              </button>
            )}
            {cycle.status !== 'completed' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleStatusChange('completed');
                }}
                style={{
                  ...btnStyle,
                  padding: '4px 10px',
                  fontSize: 10,
                  background: '#dcfce7',
                  color: '#166534',
                }}
              >
                Complete
              </button>
            )}
            {cycle.status === 'completed' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleRollover();
                }}
                disabled={rollingOver}
                style={{
                  ...btnStyle,
                  padding: '4px 10px',
                  fontSize: 10,
                  background: '#fef3c7',
                  color: '#92400e',
                }}
              >
                {rollingOver ? 'Rolling over...' : 'Rollover'}
              </button>
            )}

            <div style={{ flex: 1 }} />

            {/* Edit */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
              style={{
                ...btnStyle,
                padding: '4px 10px',
                fontSize: 10,
                background: '#f1f5f9',
                color: '#475569',
              }}
            >
              Edit
            </button>

            {/* Delete */}
            {confirmDelete ? (
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete();
                  }}
                  style={{
                    ...btnStyle,
                    padding: '4px 10px',
                    fontSize: 10,
                    background: '#fee2e2',
                    color: '#991b1b',
                  }}
                >
                  Confirm
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDelete(false);
                  }}
                  style={{
                    ...btnStyle,
                    padding: '4px 10px',
                    fontSize: 10,
                    background: '#f1f5f9',
                    color: '#475569',
                  }}
                >
                  No
                </button>
              </div>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDelete(true);
                }}
                style={{
                  ...btnStyle,
                  padding: '4px 10px',
                  fontSize: 10,
                  background: '#fee2e2',
                  color: '#991b1b',
                }}
              >
                Delete
              </button>
            )}
          </div>

          {/* Assigned nodes list */}
          <SprintNodeList cycleId={cycle.id} />
        </div>
      )}
    </div>
  );
}

// ── Main Sprint Panel ───────────────────────────────────────────

export function SprintPanel({ onClose }: { onClose: () => void }) {
  const cycles = useMindmapStore((s) => s.cycles);
  const loadCycles = useMindmapStore((s) => s.loadCycles);
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Load cycles on mount
  useEffect(() => {
    loadCycles();
  }, [loadCycles]);

  // Sort cycles: active first, then planned, then completed
  const sortedCycles = useMemo(() => {
    const order = { active: 0, planned: 1, completed: 2 };
    return [...cycles].sort((a, b) => {
      const oa = order[a.status] ?? 1;
      const ob = order[b.status] ?? 1;
      if (oa !== ob) return oa - ob;
      return new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
    });
  }, [cycles]);

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
          padding: '12px 16px',
          borderBottom: '1px solid #e2e8f0',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="#4f46e5">
          <rect x="1" y="3" width="14" height="11" rx="2" fill="none" stroke="#4f46e5" strokeWidth="1.5" />
          <line x1="4" y1="1" x2="4" y2="5" stroke="#4f46e5" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="12" y1="1" x2="12" y2="5" stroke="#4f46e5" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="1" y1="7" x2="15" y2="7" stroke="#4f46e5" strokeWidth="1" />
        </svg>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', flex: 1 }}>Sprints</span>
        <button
          onClick={() => setShowCreate(!showCreate)}
          style={{
            ...btnStyle,
            padding: '4px 12px',
            fontSize: 11,
            background: '#4f46e5',
            color: '#fff',
          }}
        >
          + New
        </button>
        <button
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

      {/* Create form */}
      {showCreate && <CreateSprintForm onClose={() => setShowCreate(false)} />}

      {/* Sprint list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {sortedCycles.length === 0 && !showCreate && (
          <div
            style={{
              padding: 32,
              textAlign: 'center',
              color: '#94a3b8',
              fontSize: 13,
            }}
          >
            No sprints yet. Create your first one!
          </div>
        )}
        {sortedCycles.map((cycle) => (
          <SprintCard
            key={cycle.id}
            cycle={cycle}
            isExpanded={expandedId === cycle.id}
            onToggleExpand={() =>
              setExpandedId(expandedId === cycle.id ? null : cycle.id)
            }
          />
        ))}
      </div>
    </div>
  );
}
