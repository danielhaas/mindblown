import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMindmapStore } from './store.js';
import { computeWorkloads } from './viewScope.js';

// ── Colors ───────────────────────────────────────────────────────

const STATUS_COLORS = {
  todo: '#94a3b8',
  in_progress: '#3b82f6',
  done: '#22c55e',
};

const STATUS_LABELS = {
  todo: 'To Do',
  in_progress: 'In Progress',
  done: 'Done',
};

// ── Component ────────────────────────────────────────────────────

export function WorkloadView() {
  const nodes = useMindmapStore((s) => s.nodes);
  const currentMap = useMindmapStore((s) => s.currentMap);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const setActiveView = useMindmapStore((s) => s.setActiveView);
  const getVisibleNodes = useMindmapStore((s) => s.getVisibleNodes);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);
  const activeVersionFilter = useMindmapStore((s) => s.activeVersionFilter);
  const activeCycleFilter = useMindmapStore((s) => s.activeCycleFilter);
  const activePhaseFilter = useMindmapStore((s) => s.activePhaseFilter);
  const nodeActors = useMindmapStore((s) => s.nodeActors);
  const loadNodeActors = useMindmapStore((s) => s.loadNodeActors);
  const currentMapId = useMindmapStore((s) => s.currentMapId);

  // Attribution fallback — fetched here rather than in loadMap because
  // this is the only view that needs it and it queries the change log.
  useEffect(() => {
    void loadNodeActors();
  }, [currentMapId, loadNodeActors]);

  const [capacity, setCapacity] = useState(40);
  const [editingCapacity, setEditingCapacity] = useState(false);
  const [filterAssignee, setFilterAssignee] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<'todo' | 'in_progress' | 'done' | null>(null);

  const statusWorkflow = currentMap?.statusWorkflow ?? [];

  // Per-assignee effort from the leaf nodes of the store's scope walk, so
  // the active version/sprint filters apply (incl. tag inheritance +
  // ancestor connect). Drill-down focus, depth limit, and collapse state
  // deliberately do NOT apply — the workload always aggregates ALL leaves,
  // exactly as before the filter fix.
  const workloads = useMemo(
    () =>
      computeWorkloads(
        getVisibleNodes({ respectFocus: false, respectDepth: false, respectCollapsed: false }),
        statusWorkflow,
        nodeActors,
      ),
    [nodes, rootNodeId, getVisibleNodes, activeVersionFilter, activeCycleFilter, activePhaseFilter, statusWorkflow, nodeActors],
  );

  const maxEffort = Math.max(capacity, ...workloads.map((w) => w.total));

  // Handle clicking a segment
  const handleSegmentClick = useCallback(
    (assigneeId: string, status: 'todo' | 'in_progress' | 'done') => {
      setFilterAssignee(assigneeId);
      setFilterStatus(status);
    },
    [],
  );

  // Filtered task list
  const filteredTasks = useMemo(() => {
    if (!filterAssignee || !filterStatus) return null;
    const workload = workloads.find((w) => w.assigneeId === filterAssignee);
    if (!workload) return null;
    const group = workload.tasksByStatus.find((g) => g.status === filterStatus);
    return group?.nodes ?? [];
  }, [filterAssignee, filterStatus, workloads]);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: '#f8fafc',
        overflow: 'auto',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '16px 24px 8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1e293b' }}>Workload</h2>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#94a3b8' }}>
            Effort distribution by person. Click a bar segment to see tasks.
            Names marked <span style={{ color: '#94a3b8' }}>~</span> are inferred from who last
            edited the work; assign a node to make it authoritative.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* Legend */}
          <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#64748b' }}>
            {(['todo', 'in_progress', 'done'] as const).map((s) => (
              <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    background: STATUS_COLORS[s],
                    display: 'inline-block',
                  }}
                />
                {STATUS_LABELS[s]}
              </span>
            ))}
          </div>

          {/* Capacity config */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={{ color: '#64748b', fontWeight: 500 }}>Capacity:</span>
            {editingCapacity ? (
              <input
                type="number"
                value={capacity}
                onChange={(e) => setCapacity(Math.max(1, Number(e.target.value) || 1))}
                onBlur={() => setEditingCapacity(false)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') setEditingCapacity(false);
                }}
                autoFocus
                style={{
                  width: 50,
                  fontSize: 12,
                  border: '1px solid #c7d2fe',
                  borderRadius: 4,
                  padding: '2px 6px',
                  outline: 'none',
                  fontFamily: 'inherit',
                }}
              />
            ) : (
              <button
                onClick={() => setEditingCapacity(true)}
                style={{
                  background: '#f1f5f9',
                  border: '1px solid #e2e8f0',
                  borderRadius: 4,
                  padding: '2px 8px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#475569',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {capacity}h/wk
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Chart area */}
      <div style={{ flex: 1, padding: '8px 24px 24px', overflow: 'auto' }}>
        {workloads.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 200,
              color: '#94a3b8',
              fontSize: 13,
            }}
          >
            {activeVersionFilter || activeCycleFilter || activePhaseFilter
              ? 'No assigned tasks with effort estimates match the active filter.'
              : 'No leaf nodes with effort estimates found. Add effort estimates to leaf nodes.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {workloads.map((w) => {
              const isOverCapacity = w.total > capacity;
              const barMaxWidth = 600;
              const scale = barMaxWidth / maxEffort;

              return (
                <div key={w.assigneeId} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {/* Assignee label */}
                  <div
                    style={{
                      width: 100,
                      flexShrink: 0,
                      fontSize: 12,
                      fontWeight: 600,
                      color: '#334155',
                      textAlign: 'right',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={
                      w.source === 'assignee'
                        ? `${w.label} — assigned`
                        : w.source === 'claim'
                          ? `${w.label} — claimed by this session`
                          : `${w.label} — inferred from who last edited these nodes (nothing is assigned)`
                    }
                  >
                    {w.label}
                    {w.source !== 'assignee' && (
                      <span style={{ color: '#cbd5e1', fontWeight: 400 }}>
                        {w.source === 'claim' ? ' ⧗' : ' ~'}
                      </span>
                    )}
                  </div>

                  {/* Bar container */}
                  <div style={{ flex: 1, position: 'relative', height: 32 }}>
                    {/* Capacity line */}
                    <div
                      style={{
                        position: 'absolute',
                        left: capacity * scale,
                        top: 0,
                        bottom: 0,
                        width: 2,
                        background: '#ef4444',
                        opacity: 0.6,
                        zIndex: 2,
                      }}
                      title={`Capacity: ${capacity}h`}
                    />

                    {/* Stacked bar */}
                    <div
                      style={{
                        display: 'flex',
                        height: '100%',
                        borderRadius: 4,
                        overflow: 'hidden',
                        border: isOverCapacity ? '2px solid #ef4444' : '1px solid #e2e8f0',
                      }}
                    >
                      {(['todo', 'in_progress', 'done'] as const).map((status) => {
                        const value = status === 'todo' ? w.todo : status === 'in_progress' ? w.inProgress : w.done;
                        if (value === 0) return null;
                        const width = value * scale;
                        const isActive = filterAssignee === w.assigneeId && filterStatus === status;

                        return (
                          <div
                            key={status}
                            onClick={() => handleSegmentClick(w.assigneeId, status)}
                            style={{
                              width,
                              height: '100%',
                              background: isOverCapacity && status !== 'done'
                                ? (status === 'todo' ? '#fca5a5' : '#f87171')
                                : STATUS_COLORS[status],
                              opacity: isActive ? 1 : 0.85,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              transition: 'opacity 0.15s',
                              outline: isActive ? '2px solid #4f46e5' : 'none',
                              outlineOffset: -2,
                            }}
                            title={`${STATUS_LABELS[status]}: ${value}h`}
                            onMouseOver={(e) => (e.currentTarget.style.opacity = '1')}
                            onMouseOut={(e) => (e.currentTarget.style.opacity = isActive ? '1' : '0.85')}
                          >
                            {width > 30 && (
                              <span style={{ fontSize: 10, fontWeight: 600, color: '#fff' }}>
                                {value}h
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Total */}
                  <div
                    style={{
                      width: 60,
                      flexShrink: 0,
                      fontSize: 12,
                      fontWeight: 600,
                      color: isOverCapacity ? '#ef4444' : '#475569',
                      textAlign: 'right',
                    }}
                  >
                    {w.total}h
                    {isOverCapacity && (
                      <span style={{ fontSize: 10, fontWeight: 500 }}>
                        {' '}(+{w.total - capacity})
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Filtered task list */}
        {filteredTasks && filterAssignee && filterStatus && (
          <div
            style={{
              marginTop: 24,
              background: '#fff',
              borderRadius: 8,
              border: '1px solid #e2e8f0',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '10px 16px',
                borderBottom: '1px solid #f1f5f9',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600, color: '#334155' }}>
                {filterAssignee} - {STATUS_LABELS[filterStatus]} ({filteredTasks.length} tasks)
              </span>
              <button
                onClick={() => { setFilterAssignee(null); setFilterStatus(null); }}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: 12,
                  color: '#94a3b8',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Close
              </button>
            </div>
            {filteredTasks.length === 0 ? (
              <div style={{ padding: 16, color: '#94a3b8', fontSize: 12 }}>No tasks</div>
            ) : (
              <div>
                {filteredTasks.map((task) => (
                  <div
                    key={task.id}
                    onClick={() => {
                      selectNode(task.id);
                      setActiveView('mindmap');
                    }}
                    style={{
                      padding: '8px 16px',
                      borderBottom: '1px solid #f8fafc',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      transition: 'background 0.15s',
                    }}
                    onMouseOver={(e) => (e.currentTarget.style.background = '#f8fafc')}
                    onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <span style={{ fontSize: 12, color: '#334155' }}>{task.text}</span>
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>
                      {task.effortEstimate ?? 0}h
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
