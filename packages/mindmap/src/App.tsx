import { useCallback, useEffect, useRef, useState } from 'react';
import { useMindmapStore } from './store.js';
import type { ActiveView } from './store.js';
import { MindmapEditor } from './MindmapEditor.js';
import { PropertyPanel } from './PropertyPanel.js';
import { KanbanView } from './KanbanView.js';
import { GanttView } from './GanttView.js';
import { ListView } from './ListView.js';
import { CalendarView } from './CalendarView.js';
import { SprintPanel } from './SprintPanel.js';
import { CommandPalette } from './CommandPalette.js';
import { QuickAdd } from './QuickAdd.js';
import type { MapSummary } from './api.js';

// ── Health badge colors ────────────────────────────────────────

const HEALTH_LABEL: Record<string, { text: string; bg: string; fg: string }> = {
  on_track: { text: 'On Track', bg: '#dcfce7', fg: '#166534' },
  at_risk: { text: 'At Risk', bg: '#fef3c7', fg: '#92400e' },
  behind: { text: 'Behind', bg: '#fee2e2', fg: '#991b1b' },
};

// ── Spinner ────────────────────────────────────────────────────

function Spinner({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ animation: 'spin 1s linear infinite' }}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="#e2e8f0"
        strokeWidth="3"
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        fill="none"
        stroke="#4f46e5"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Connection indicator ───────────────────────────────────────

function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
      }}
      title={connected ? 'Connected' : 'Disconnected'}
    >
      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: connected ? '#059669' : '#dc2626',
          boxShadow: connected ? '0 0 6px rgba(5,150,105,0.4)' : '0 0 6px rgba(220,38,38,0.4)',
          transition: 'background 0.3s, box-shadow 0.3s',
        }}
      />
      <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>
        {connected ? 'Live' : 'Offline'}
      </span>
    </div>
  );
}

// ── Map List / Landing ──────────────────────────────────────────

function MapList({
  maps,
  loading,
  error,
  onSelect,
  onCreate,
  onRetry,
}: {
  maps: MapSummary[];
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRetry: () => void;
}) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f8fafc',
      }}
    >
      <div
        style={{
          width: 480,
          maxWidth: '90vw',
          background: '#fff',
          borderRadius: 16,
          boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '24px 28px 16px',
            borderBottom: '1px solid #f1f5f9',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1e293b' }}>
              MindBlown
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#94a3b8' }}>
              Select a map or create a new one
            </p>
          </div>
          <button
            onClick={onCreate}
            style={{
              background: '#4f46e5',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'background 0.15s',
            }}
            onMouseOver={(e) => (e.currentTarget.style.background = '#4338ca')}
            onMouseOut={(e) => (e.currentTarget.style.background = '#4f46e5')}
          >
            + New Map
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '8px 12px 16px', minHeight: 120 }}>
          {loading && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
              <Spinner size={28} />
            </div>
          )}

          {error && !loading && (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <p style={{ color: '#dc2626', fontSize: 13, margin: '0 0 12px' }}>{error}</p>
              <button
                onClick={onRetry}
                style={{
                  background: '#f1f5f9',
                  border: 'none',
                  borderRadius: 6,
                  padding: '6px 14px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#475569',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !error && maps.length === 0 && (
            <div style={{ textAlign: 'center', padding: 32, color: '#94a3b8', fontSize: 13 }}>
              No maps yet. Create your first one!
            </div>
          )}

          {!loading &&
            maps.map((map) => {
              const healthInfo = HEALTH_LABEL[map.healthSignal] ?? HEALTH_LABEL.on_track;
              return (
                <button
                  key={map.id}
                  onClick={() => onSelect(map.id)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '12px 16px',
                    border: 'none',
                    borderRadius: 10,
                    background: 'transparent',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    textAlign: 'left',
                    transition: 'background 0.15s',
                  }}
                  onMouseOver={(e) => (e.currentTarget.style.background = '#f8fafc')}
                  onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {/* Color dot */}
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      background: '#eef2ff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 16,
                      flexShrink: 0,
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="3" fill="#4f46e5" />
                      <circle cx="5" cy="8" r="2" fill="#6366f1" opacity="0.6" />
                      <circle cx="19" cy="8" r="2" fill="#6366f1" opacity="0.6" />
                      <circle cx="5" cy="16" r="2" fill="#6366f1" opacity="0.6" />
                      <circle cx="19" cy="16" r="2" fill="#6366f1" opacity="0.6" />
                      <line x1="12" y1="12" x2="5" y2="8" stroke="#a5b4fc" strokeWidth="1" />
                      <line x1="12" y1="12" x2="19" y2="8" stroke="#a5b4fc" strokeWidth="1" />
                      <line x1="12" y1="12" x2="5" y2="16" stroke="#a5b4fc" strokeWidth="1" />
                      <line x1="12" y1="12" x2="19" y2="16" stroke="#a5b4fc" strokeWidth="1" />
                    </svg>
                  </div>

                  {/* Map info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#1e293b' }}>
                      {map.name}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                      {/* Progress bar */}
                      <div
                        style={{
                          width: 60,
                          height: 4,
                          borderRadius: 2,
                          background: '#e2e8f0',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: `${Math.round(map.computedProgress)}%`,
                            height: '100%',
                            borderRadius: 2,
                            background: map.computedProgress >= 100 ? '#059669' : '#4f46e5',
                          }}
                        />
                      </div>
                      <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>
                        {Math.round(map.computedProgress)}%
                      </span>
                    </div>
                  </div>

                  {/* Health badge */}
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: 4,
                      background: healthInfo.bg,
                      color: healthInfo.fg,
                      flexShrink: 0,
                    }}
                  >
                    {healthInfo.text}
                  </span>
                </button>
              );
            })}
        </div>
      </div>
    </div>
  );
}

// ── Editable map name ──────────────────────────────────────────

function EditableMapName({ name, onChange }: { name: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setValue(name); }, [name]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  if (!editing) {
    return (
      <span
        onClick={() => setEditing(true)}
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: '#1e293b',
          letterSpacing: '-0.01em',
          cursor: 'pointer',
          padding: '2px 4px',
          borderRadius: 4,
          transition: 'background 0.15s',
        }}
        onMouseOver={(e) => (e.currentTarget.style.background = '#f1f5f9')}
        onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
        title="Click to rename"
      >
        {name}
      </span>
    );
  }

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const trimmed = value.trim();
        if (trimmed && trimmed !== name) onChange(trimmed);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          const trimmed = value.trim();
          if (trimmed && trimmed !== name) onChange(trimmed);
          setEditing(false);
        } else if (e.key === 'Escape') {
          setValue(name);
          setEditing(false);
        }
      }}
      style={{
        fontSize: 15,
        fontWeight: 700,
        color: '#1e293b',
        border: '1px solid #c7d2fe',
        borderRadius: 4,
        padding: '2px 6px',
        outline: 'none',
        background: '#fff',
        fontFamily: 'inherit',
        width: 180,
      }}
    />
  );
}

// ── View Switcher ─────────────────────────────────────────────

const VIEW_TABS: { id: ActiveView; label: string; enabled: boolean }[] = [
  { id: 'mindmap', label: 'Mindmap', enabled: true },
  { id: 'kanban', label: 'Kanban', enabled: true },
  { id: 'gantt', label: 'Gantt', enabled: true },
  { id: 'list', label: 'List', enabled: false },
  { id: 'calendar', label: 'Calendar', enabled: true },
];

function ViewSwitcher({ active, onChange }: { active: ActiveView; onChange: (v: ActiveView) => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        background: '#f1f5f9',
        borderRadius: 6,
        padding: 2,
        gap: 1,
      }}
    >
      {VIEW_TABS.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            onClick={() => tab.enabled && onChange(tab.id)}
            disabled={!tab.enabled}
            style={{
              fontSize: 11,
              fontWeight: isActive ? 600 : 500,
              color: !tab.enabled ? '#cbd5e1' : isActive ? '#1e293b' : '#64748b',
              background: isActive ? '#ffffff' : 'transparent',
              border: 'none',
              borderRadius: 4,
              padding: '3px 10px',
              cursor: tab.enabled ? 'pointer' : 'default',
              fontFamily: 'inherit',
              transition: 'all 0.15s',
              boxShadow: isActive ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Sprint Indicator ──────────────────────────────────────────

function SprintIndicator({
  cycles,
  activeCycleFilter,
  onFilterChange,
  onOpenPanel,
  panelOpen,
}: {
  cycles: { id: string; name: string; status: string; startDate: string; endDate: string }[];
  activeCycleFilter: string | null;
  onFilterChange: (id: string | null) => void;
  onOpenPanel: () => void;
  panelOpen: boolean;
}) {
  const activeSprint = cycles.find((c) => c.status === 'active');
  const filterSprint = activeCycleFilter
    ? cycles.find((c) => c.id === activeCycleFilter)
    : null;

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtShort(iso: string): string {
    const d = new Date(iso);
    return `${months[d.getMonth()]} ${d.getDate()}`;
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {/* Active sprint info */}
      {activeSprint && !filterSprint && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="3" width="14" height="11" rx="2" stroke="#4f46e5" strokeWidth="1.5" />
            <line x1="4" y1="1" x2="4" y2="5" stroke="#4f46e5" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="12" y1="1" x2="12" y2="5" stroke="#4f46e5" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#4f46e5' }}>
            {activeSprint.name}
          </span>
          <span style={{ fontSize: 10, color: '#94a3b8' }}>
            {fmtShort(activeSprint.startDate)}-{fmtShort(activeSprint.endDate)}
          </span>
        </div>
      )}

      {/* Filter indicator */}
      {filterSprint && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 4,
              background: '#eef2ff',
              color: '#4f46e5',
            }}
          >
            Showing: {filterSprint.name}
          </span>
          <button
            onClick={() => onFilterChange(null)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '0 2px',
              color: '#94a3b8',
              fontSize: 12,
              fontFamily: 'inherit',
            }}
            title="Clear sprint filter"
          >
            x
          </button>
        </div>
      )}

      {/* Sprint filter dropdown */}
      {cycles.length > 0 && (
        <select
          value={activeCycleFilter ?? ''}
          onChange={(e) => onFilterChange(e.target.value || null)}
          onKeyDown={(e) => e.stopPropagation()}
          style={{
            fontSize: 10,
            fontFamily: 'inherit',
            border: '1px solid #e2e8f0',
            borderRadius: 4,
            padding: '2px 18px 2px 6px',
            color: '#475569',
            background: '#fff',
            appearance: 'none' as const,
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath fill='%2394a3b8' d='M2 3.5L5 7l3-3.5H2z'/%3E%3C/svg%3E")`,
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'right 4px center',
            cursor: 'pointer',
          }}
          title="Filter by sprint"
        >
          <option value="">All sprints</option>
          {cycles.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.status})
            </option>
          ))}
        </select>
      )}

      {/* Sprints panel button */}
      <button
        onClick={onOpenPanel}
        style={{
          padding: '3px 10px',
          borderRadius: 4,
          border: panelOpen ? '1px solid #4f46e5' : '1px solid #e2e8f0',
          fontSize: 11,
          fontWeight: 600,
          fontFamily: 'inherit',
          cursor: 'pointer',
          background: panelOpen ? '#eef2ff' : '#fff',
          color: panelOpen ? '#4f46e5' : '#64748b',
          transition: 'all 0.15s',
        }}
      >
        Sprints
      </button>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────

export function App() {
  const maps = useMindmapStore((s) => s.maps);
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const currentMap = useMindmapStore((s) => s.currentMap);
  const nodes = useMindmapStore((s) => s.nodes);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);
  const computed = useMindmapStore((s) => s.computed);
  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);
  const loading = useMindmapStore((s) => s.loading);
  const error = useMindmapStore((s) => s.error);
  const wsConnected = useMindmapStore((s) => s.wsConnected);
  const activeView = useMindmapStore((s) => s.activeView);
  const cycles = useMindmapStore((s) => s.cycles);
  const activeCycleFilter = useMindmapStore((s) => s.activeCycleFilter);
  const setActiveCycleFilter = useMindmapStore((s) => s.setActiveCycleFilter);
  const loadCycles = useMindmapStore((s) => s.loadCycles);

  const loadMaps = useMindmapStore((s) => s.loadMaps);
  const loadMap = useMindmapStore((s) => s.loadMap);
  const createMap = useMindmapStore((s) => s.createMap);
  const closeMap = useMindmapStore((s) => s.closeMap);
  const updateMapName = useMindmapStore((s) => s.updateMapName);
  const setActiveView = useMindmapStore((s) => s.setActiveView);

  const [sprintPanelOpen, setSprintPanelOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);

  // Global keyboard shortcuts for command palette and quick add
  useEffect(() => {
    if (!currentMapId) return;

    const handler = (e: KeyboardEvent) => {
      // Don't intercept when typing in inputs
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      // Cmd+K / Ctrl+K -> command palette (always, even in inputs)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen((v) => !v);
        setQuickAddOpen(false);
        return;
      }

      if (isInput) return;

      // Q -> quick add (only when not in an input)
      if (e.key === 'q' || e.key === 'Q') {
        // Don't open if editing a node
        const editingNodeId = useMindmapStore.getState().editingNodeId;
        if (editingNodeId) return;
        e.preventDefault();
        setQuickAddOpen((v) => !v);
        setCommandPaletteOpen(false);
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentMapId]);

  // Helper callbacks for command palette
  const handleFitToScreen = useCallback(() => {
    (window as any).__mindmapFitToScreen?.();
  }, []);
  const handleZoomIn = useCallback(() => {
    (window as any).__mindmapZoomIn?.();
  }, []);
  const handleZoomOut = useCallback(() => {
    (window as any).__mindmapZoomOut?.();
  }, []);

  // Load maps on mount
  useEffect(() => {
    loadMaps();
  }, [loadMaps]);

  // Load cycles when map is opened
  useEffect(() => {
    if (currentMapId) {
      loadCycles();
    }
  }, [currentMapId, loadCycles]);

  // Auto-open if there's only one map
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!autoOpened.current && !currentMapId && !loading && maps.length === 1) {
      autoOpened.current = true;
      loadMap(maps[0].id);
    }
  }, [maps, currentMapId, loading, loadMap]);

  const handleCreateMap = useCallback(() => {
    const name = prompt('Map name:');
    if (name?.trim()) {
      createMap(name.trim());
    }
  }, [createMap]);

  // ── Map list view ────────────────────────────────────────────

  if (!currentMapId) {
    return (
      <div style={{ width: '100%', height: '100%' }}>
        <MapList
          maps={maps}
          loading={loading}
          error={error}
          onSelect={loadMap}
          onCreate={handleCreateMap}
          onRetry={loadMaps}
        />
      </div>
    );
  }

  // ── Editor view ──────────────────────────────────────────────

  const rootComputed = rootNodeId ? computed.get(rootNodeId) : undefined;
  const progress = rootComputed?.computedProgress ?? 0;
  const effort = rootComputed?.computedEffort ?? 0;
  const health = rootComputed?.healthSignal ?? 'on_track';
  const healthInfo = HEALTH_LABEL[health];
  const nodeCount = Object.keys(nodes).length;

  // Loading overlay for map load
  if (loading && nodeCount === 0) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f8fafc',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <Spinner size={32} />
          <span style={{ fontSize: 13, color: '#94a3b8' }}>Loading map...</span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div
        style={{
          height: 48,
          minHeight: 48,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 16px 0 8px',
          borderBottom: '1px solid #e2e8f0',
          background: '#ffffff',
          zIndex: 10,
        }}
      >
        {/* Left: back button + map name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={closeMap}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '4px 8px',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              color: '#64748b',
              fontSize: 13,
              fontWeight: 500,
              fontFamily: 'inherit',
              transition: 'background 0.15s',
            }}
            onMouseOver={(e) => (e.currentTarget.style.background = '#f1f5f9')}
            onMouseOut={(e) => (e.currentTarget.style.background = 'none')}
            title="Back to maps"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style={{ marginRight: 2 }}>
              <path d="M10.3 12.3a1 1 0 0 1-1.4 0l-3.6-3.6a1 1 0 0 1 0-1.4l3.6-3.6a1 1 0 0 1 1.4 1.4L7.4 8l2.9 2.9a1 1 0 0 1 0 1.4z" />
            </svg>
            Maps
          </button>

          <div style={{ width: 1, height: 20, background: '#e2e8f0' }} />

          <EditableMapName
            name={currentMap?.name ?? 'Untitled'}
            onChange={updateMapName}
          />

          <div style={{ width: 1, height: 20, background: '#e2e8f0' }} />

          <ViewSwitcher active={activeView} onChange={setActiveView} />
        </div>

        {/* Right: sprint indicator + stats */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {/* Sprint indicator and filter */}
          <SprintIndicator
            cycles={cycles}
            activeCycleFilter={activeCycleFilter}
            onFilterChange={setActiveCycleFilter}
            onOpenPanel={() => setSprintPanelOpen(!sprintPanelOpen)}
            panelOpen={sprintPanelOpen}
          />

          <div style={{ width: 1, height: 20, background: '#e2e8f0' }} />

          {/* Node count */}
          <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>
            {nodeCount} nodes
          </span>

          {/* Progress */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div
              style={{
                width: 80,
                height: 6,
                borderRadius: 3,
                background: '#e2e8f0',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${Math.round(progress)}%`,
                  height: '100%',
                  borderRadius: 3,
                  background: progress >= 100 ? '#059669' : '#4f46e5',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>
              {Math.round(progress)}%
            </span>
          </div>

          {/* Effort */}
          <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 500 }}>
            {effort}d effort
          </span>

          {/* Health badge */}
          {healthInfo && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 4,
                background: healthInfo.bg,
                color: healthInfo.fg,
              }}
            >
              {healthInfo.text}
            </span>
          )}

          {/* Connection status */}
          <ConnectionDot connected={wsConnected} />

          {/* Keyboard hint */}
          <span style={{ fontSize: 11, color: '#cbd5e1' }}>
            {selectedNodeId
              ? '\u2318K: commands | Q: quick add | Tab: child | Enter: sibling'
              : '\u2318K: commands | Q: quick add | Click a node to start'}
          </span>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div
          style={{
            padding: '6px 16px',
            background: '#fef2f2',
            borderBottom: '1px solid #fecaca',
            color: '#991b1b',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>{error}</span>
          <button
            onClick={() => useMindmapStore.setState({ error: null })}
            style={{
              background: 'none',
              border: 'none',
              color: '#991b1b',
              cursor: 'pointer',
              fontSize: 14,
              padding: '0 4px',
              fontFamily: 'inherit',
            }}
          >
            x
          </button>
        </div>
      )}

      {/* Main content + Property/Sprint panel */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {activeView === 'mindmap' && <MindmapEditor />}
          {activeView === 'kanban' && <KanbanView />}
          {activeView === 'gantt' && <GanttView />}
          {activeView === 'list' && <ListView />}
          {activeView === 'calendar' && <CalendarView />}
        </div>
        {sprintPanelOpen ? (
          <SprintPanel onClose={() => setSprintPanelOpen(false)} />
        ) : (
          <PropertyPanel />
        )}
      </div>

      {/* Command Palette */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onFitToScreen={handleFitToScreen}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
      />

      {/* Quick Add */}
      <QuickAdd
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
      />
    </div>
  );
}
