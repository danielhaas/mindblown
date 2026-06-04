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
import { BlockedPanel } from './BlockedPanel.js';
import { TriagePanel } from './TriagePanel.js';
import { listTriageDecisions } from './api.js';
import { CommandPalette } from './CommandPalette.js';
import { QuickAdd } from './QuickAdd.js';
import { HillChart } from './HillChart.js';
import { WorkloadView } from './WorkloadView.js';
import { ReleasesView } from './ReleasesView.js';
import { ImportExport } from './ImportExport.js';
import { AuthScreen } from './AuthScreen.js';
import { ShareDialog } from './ShareDialog.js';
import { GitHubSettingsDialog } from './GitHubPanel.js';
import { AIChatPanel } from './AIChatPanel.js';
import { MapChatPanel } from './MapChatPanel.js';
import { useMapChatUnread } from './useMapChatUnread.js';
import { Breadcrumb } from './Breadcrumb.js';
import { WorkspaceSettings } from './WorkspaceSettings.js';
import { HelpOverlay } from './HelpOverlay.js';
import { TicketButton } from './TicketButton.js';
import { HealthListDialog } from './HealthListDialog.js';
import type { HealthSignal } from '@mindblown/core';
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
  onSettings,
  onHelp,
}: {
  maps: MapSummary[];
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRetry: () => void;
  onSettings: () => void;
  onHelp: () => void;
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={onHelp}
              title="Help / User Guide"
              style={{
                background: '#f1f5f9',
                border: 'none',
                borderRadius: 8,
                width: 32,
                height: 32,
                cursor: 'pointer',
                color: '#64748b',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                fontWeight: 700,
                fontFamily: 'inherit',
                transition: 'background 0.15s',
              }}
              onMouseOver={(e) => (e.currentTarget.style.background = '#e2e8f0')}
              onMouseOut={(e) => (e.currentTarget.style.background = '#f1f5f9')}
            >
              ?
            </button>
            <button
              onClick={onSettings}
              title="Workspace Settings"
              style={{
                background: '#f1f5f9',
                border: 'none',
                borderRadius: 8,
                padding: '8px 10px',
                cursor: 'pointer',
                color: '#64748b',
                display: 'flex',
                alignItems: 'center',
                transition: 'background 0.15s',
              }}
              onMouseOver={(e) => (e.currentTarget.style.background = '#e2e8f0')}
              onMouseOut={(e) => (e.currentTarget.style.background = '#f1f5f9')}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="2.5" />
                <path d="M13.5 8a5.5 5.5 0 01-.3 1.6l1.3.8-.8 1.4-1.4-.5a5.5 5.5 0 01-1.4.8l-.2 1.5H9l-.2-1.5a5.5 5.5 0 01-1.4-.8l-1.4.5-.8-1.4 1.3-.8A5.5 5.5 0 016.2 8a5.5 5.5 0 01.3-1.6l-1.3-.8.8-1.4 1.4.5a5.5 5.5 0 011.4-.8L9 2.4h1.6l.2 1.5a5.5 5.5 0 011.4.8l1.4-.5.8 1.4-1.3.8a5.5 5.5 0 01.3 1.6z" />
              </svg>
            </button>
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
  { id: 'releases', label: 'Releases', enabled: true },
  { id: 'list', label: 'List', enabled: false },
  { id: 'calendar', label: 'Calendar', enabled: true },
  { id: 'hill', label: 'Hill Chart', enabled: true },
  { id: 'workload', label: 'Workload', enabled: true },
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

// ── Version Indicator ─────────────────────────────────────────

function VersionIndicator({
  versions,
  activeVersionFilter,
  onFilterChange,
}: {
  versions: { id: string; name: string; status: string }[];
  activeVersionFilter: string | null;
  onFilterChange: (id: string | null) => void;
}) {
  const filterVersion = activeVersionFilter
    ? versions.find((v) => v.id === activeVersionFilter)
    : null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {/* Filter indicator */}
      {filterVersion && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 4,
              background: '#f0fdf4',
              color: '#059669',
            }}
          >
            {filterVersion.name}
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
            title="Clear version filter"
          >
            x
          </button>
        </div>
      )}

      {/* Version filter dropdown */}
      <select
        value={activeVersionFilter ?? ''}
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
        title="Filter by version"
      >
        <option value="">All versions</option>
        {versions.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name} ({v.status})
          </option>
        ))}
      </select>
    </div>
  );
}

// ── Blocked Indicator ─────────────────────────────────────────

function BlockedIndicator({
  count,
  panelOpen,
  onOpenPanel,
}: {
  count: number;
  panelOpen: boolean;
  onOpenPanel: () => void;
}) {
  const hasBlocked = count > 0;
  const fg = panelOpen ? '#991b1b' : hasBlocked ? '#991b1b' : '#64748b';
  const bg = panelOpen ? '#fee2e2' : '#fff';
  const border = panelOpen ? '#fca5a5' : hasBlocked ? '#fecaca' : '#e2e8f0';
  return (
    <button
      onClick={onOpenPanel}
      title={hasBlocked ? `${count} blocked node(s)` : 'No blocked nodes'}
      style={{
        padding: '3px 10px',
        borderRadius: 4,
        border: `1px solid ${border}`,
        fontSize: 11,
        fontWeight: 600,
        fontFamily: 'inherit',
        cursor: 'pointer',
        background: bg,
        color: fg,
        transition: 'all 0.15s',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <span>🔒</span>
      <span>Blocked</span>
      {hasBlocked && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            background: panelOpen ? '#991b1b' : '#fecaca',
            color: panelOpen ? '#fff' : '#991b1b',
            padding: '0 5px',
            borderRadius: 8,
            minWidth: 14,
            textAlign: 'center',
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ── Triage Indicator (#94) ────────────────────────────────────

function TriageIndicator({
  count,
  panelOpen,
  onOpenPanel,
}: {
  count: number;
  panelOpen: boolean;
  onOpenPanel: () => void;
}) {
  const hasPending = count > 0;
  const fg = panelOpen ? '#1d4ed8' : hasPending ? '#1d4ed8' : '#64748b';
  const bg = panelOpen ? '#dbeafe' : '#fff';
  const border = panelOpen ? '#93c5fd' : hasPending ? '#bfdbfe' : '#e2e8f0';
  return (
    <button
      data-testid="triage-indicator"
      onClick={onOpenPanel}
      title={hasPending ? `${count} triage decision(s) pending review` : 'Triage'}
      style={{
        padding: '3px 10px',
        borderRadius: 4,
        border: `1px solid ${border}`,
        fontSize: 11,
        fontWeight: 600,
        fontFamily: 'inherit',
        cursor: 'pointer',
        background: bg,
        color: fg,
        transition: 'all 0.15s',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <span>🧭</span>
      <span>Triage</span>
      {hasPending && (
        <span
          data-testid="triage-indicator-count"
          style={{
            fontSize: 10,
            fontWeight: 700,
            background: panelOpen ? '#1d4ed8' : '#bfdbfe',
            color: panelOpen ? '#fff' : '#1d4ed8',
            padding: '0 5px',
            borderRadius: 8,
            minWidth: 14,
            textAlign: 'center',
          }}
        >
          {count}
        </span>
      )}
    </button>
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

/**
 * A small floating pill rendered in place of a docked chat panel when the
 * user has minimised it. Click the label to restore the panel, click × to
 * fully close. Stacked above the TicketButton in the bottom-right corner.
 */
function MinimisedChip({
  label,
  color,
  bottom,
  onExpand,
  onClose,
}: {
  label: string;
  color: string;
  bottom: number;
  onExpand: () => void;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        right: 20,
        bottom,
        zIndex: 40,
        display: 'flex',
        alignItems: 'stretch',
        height: 32,
        borderRadius: 16,
        background: '#fff',
        border: `1px solid ${color}`,
        boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
        overflow: 'hidden',
        fontFamily: 'inherit',
      }}
    >
      <button
        onClick={onExpand}
        title={`Restore ${label}`}
        style={{
          padding: '0 12px',
          background: 'transparent',
          border: 'none',
          color,
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {label}
      </button>
      <button
        onClick={onClose}
        title="Close"
        aria-label="Close"
        style={{
          padding: '0 10px',
          background: 'transparent',
          border: 'none',
          borderLeft: `1px solid ${color}33`,
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
  );
}

// ── Main App ───────────────────────────────────────────────────

export function App() {
  const user = useMindmapStore((s) => s.user);
  const token = useMindmapStore((s) => s.token);
  const checkAuth = useMindmapStore((s) => s.checkAuth);
  const logout = useMindmapStore((s) => s.logout);

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
  const versions = useMindmapStore((s) => s.versions);
  const activeVersionFilter = useMindmapStore((s) => s.activeVersionFilter);
  const setActiveVersionFilter = useMindmapStore((s) => s.setActiveVersionFilter);
  const loadVersions = useMindmapStore((s) => s.loadVersions);

  const loadMaps = useMindmapStore((s) => s.loadMaps);
  const loadMap = useMindmapStore((s) => s.loadMap);
  const createMap = useMindmapStore((s) => s.createMap);
  const closeMap = useMindmapStore((s) => s.closeMap);
  const updateMapName = useMindmapStore((s) => s.updateMapName);
  const setActiveView = useMindmapStore((s) => s.setActiveView);

  const [sprintPanelOpen, setSprintPanelOpen] = useState(false);
  const [blockedPanelOpen, setBlockedPanelOpen] = useState(false);
  const [triagePanelOpen, setTriagePanelOpen] = useState(false);
  const [triagePendingCount, setTriagePendingCount] = useState(0);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [importExportOpen, setImportExportOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [githubSettingsOpen, setGithubSettingsOpen] = useState(false);
  const [aiChatOpen, setAiChatOpen] = useState(false);
  const [aiChatMinimised, setAiChatMinimised] = useState(false);
  const [mapChatOpen, setMapChatOpen] = useState(false);
  const [mapChatMinimised, setMapChatMinimised] = useState(false);
  const mapChatUnread = useMapChatUnread(currentMapId, rootNodeId, mapChatOpen);
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [healthListHealth, setHealthListHealth] = useState<HealthSignal | null>(null);
  const [ghBanner, setGhBanner] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  // Auto-login on page load if token exists
  useEffect(() => {
    checkAuth().finally(() => setAuthChecked(true));
  }, [checkAuth]);

  // Poll the pending-triage count for the active map. Cheap (one
  // SELECT, server-side-filtered), used by the TriageIndicator badge.
  // The panel itself does its own pull when opened — this is just for
  // the always-visible counter. We re-poll when the panel closes so
  // the badge reflects post-action state. 60s heartbeat covers the
  // "operator-on-GitHub-edits-an-issue" path; for the real-time path
  // Phase 1 follow-up will wire a `triage:decision_*` broadcast.
  useEffect(() => {
    if (!currentMapId) {
      setTriagePendingCount(0);
      return;
    }
    let cancelled = false;
    const tick = () => {
      listTriageDecisions(currentMapId, { reviewed: false, limit: 200 })
        .then((res) => {
          if (cancelled) return;
          setTriagePendingCount(res.total);
        })
        .catch(() => {
          // Triage may not be opted in for this map — silently zero out.
          if (!cancelled) setTriagePendingCount(0);
        });
    };
    tick();
    const interval = window.setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [currentMapId, triagePanelOpen]);

  // Handle GitHub OAuth callback redirect (?gh=connected or ?gh=error)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gh = params.get('gh');
    if (gh) {
      // Clean the URL
      const url = new URL(window.location.href);
      url.searchParams.delete('gh');
      url.searchParams.delete('reason');
      window.history.replaceState({}, '', url.pathname + url.search);

      if (gh === 'connected') {
        setGhBanner('GitHub connected successfully!');
        setTimeout(() => setGhBanner(null), 5000);
      } else if (gh === 'error') {
        const reason = params.get('reason') ?? 'unknown';
        setGhBanner(`GitHub connection failed: ${reason}`);
        setTimeout(() => setGhBanner(null), 8000);
      }
    }
  }, []);

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

      // / -> search nodes (open command palette)
      if (e.key === '/') {
        const editingNodeId = useMindmapStore.getState().editingNodeId;
        if (editingNodeId) return;
        e.preventDefault();
        setCommandPaletteOpen(true);
        setQuickAddOpen(false);
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentMapId]);

  // Mouse "back" button (XButton1) — pop one entry off the focus
  // navigation history. When no history is available, the browser's
  // default back navigation is preserved.
  useEffect(() => {
    if (!currentMapId) return;
    const handler = (e: MouseEvent) => {
      if (e.button !== 3) return;
      const { focusHistory, popFocusHistory } = useMindmapStore.getState();
      if (focusHistory.length === 0) return;
      e.preventDefault();
      popFocusHistory();
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
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

  // Load maps when authenticated
  useEffect(() => {
    if (user) loadMaps();
  }, [user, loadMaps]);

  // Load cycles and versions when map is opened
  useEffect(() => {
    if (currentMapId) {
      loadCycles();
      loadVersions();
    }
  }, [currentMapId, loadCycles, loadVersions]);

  // Auto-open if there's only one map
  const autoOpened = useRef(false);

  // URL → state: on first auth, open the map in ?map=<id> if present.
  // Sets autoOpened so the single-map auto-opener doesn't race ahead.
  const urlMapInitDone = useRef(false);
  useEffect(() => {
    if (!user || urlMapInitDone.current) return;
    urlMapInitDone.current = true;
    const mapId = new URLSearchParams(window.location.search).get('map');
    if (mapId) {
      autoOpened.current = true;
      loadMap(mapId);
    }
  }, [user, loadMap]);

  // State → URL: mirror currentMapId into ?map=<id> via replaceState so the
  // URL is shareable / reload-safe without polluting browser history.
  useEffect(() => {
    const url = new URL(window.location.href);
    const current = url.searchParams.get('map');
    if (currentMapId && current !== currentMapId) {
      url.searchParams.set('map', currentMapId);
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    } else if (!currentMapId && current) {
      url.searchParams.delete('map');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    }
  }, [currentMapId]);

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

  // ── Auth check loading ───────────────────────────────────────

  if (!authChecked) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc' }}>
        <Spinner size={32} />
      </div>
    );
  }

  // ── Auth screen ─────────────────────────────────────────────

  if (!user) {
    return <AuthScreen />;
  }

  // ── Map list view ────────────────────────────────────────────

  if (!currentMapId) {
    return (
      <div style={{ width: '100%', height: '100%', position: 'relative' }}>
        {ghBanner && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              padding: '8px 16px',
              background: ghBanner.includes('failed') ? '#fef2f2' : '#f0fdf4',
              color: ghBanner.includes('failed') ? '#991b1b' : '#166534',
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              zIndex: 10,
            }}
          >
            <span>{ghBanner}</span>
            <button
              onClick={() => setGhBanner(null)}
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 14, padding: '0 4px', fontFamily: 'inherit' }}
            >
              x
            </button>
          </div>
        )}
        <MapList
          maps={maps}
          loading={loading}
          error={error}
          onSelect={loadMap}
          onCreate={handleCreateMap}
          onRetry={loadMaps}
          onSettings={() => setWorkspaceSettingsOpen(true)}
          onHelp={() => setHelpOpen(true)}
        />
        {workspaceSettingsOpen && (
          <WorkspaceSettings onClose={() => setWorkspaceSettingsOpen(false)} />
        )}
        {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
        <TicketButton />
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
  let blockedLeafCount = 0;
  for (const n of Object.values(nodes)) {
    if (n.childrenIds.length > 0) continue;
    if (computed.get(n.id)?.isBlocked) blockedLeafCount += 1;
  }

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
          {/* Search button */}
          <button
            onClick={() => setCommandPaletteOpen(true)}
            style={{
              padding: '3px 10px',
              borderRadius: 4,
              border: '1px solid #e2e8f0',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: 'pointer',
              background: '#fff',
              color: '#64748b',
              transition: 'all 0.15s',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.background = '#eef2ff';
              e.currentTarget.style.borderColor = '#c7d2fe';
              e.currentTarget.style.color = '#4f46e5';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.background = '#fff';
              e.currentTarget.style.borderColor = '#e2e8f0';
              e.currentTarget.style.color = '#64748b';
            }}
            title="Search nodes  ( /  or  Ctrl+K )"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10.5 10.5l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Search
            <span
              style={{
                marginLeft: 4,
                padding: '0 4px',
                borderRadius: 3,
                background: '#f1f5f9',
                color: '#94a3b8',
                fontFamily: 'monospace',
                fontSize: 10,
                fontWeight: 600,
                border: '1px solid #e2e8f0',
              }}
            >
              /
            </span>
          </button>

          {/* Import/Export button */}
          <button
            onClick={() => setImportExportOpen(true)}
            style={{
              padding: '3px 10px',
              borderRadius: 4,
              border: '1px solid #e2e8f0',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: 'pointer',
              background: '#fff',
              color: '#64748b',
              transition: 'all 0.15s',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.background = '#eef2ff';
              e.currentTarget.style.borderColor = '#c7d2fe';
              e.currentTarget.style.color = '#4f46e5';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.background = '#fff';
              e.currentTarget.style.borderColor = '#e2e8f0';
              e.currentTarget.style.color = '#64748b';
            }}
            title="Import / Export"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M2 10v3a1 1 0 001 1h10a1 1 0 001-1v-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M8 2v8m0 0l-3-3m3 3l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Import/Export
          </button>

          <button
            onClick={() => setHelpOpen(true)}
            title="Help / User Guide"
            style={{
              width: 24,
              height: 24,
              borderRadius: 4,
              border: '1px solid #e2e8f0',
              fontSize: 12,
              fontWeight: 700,
              fontFamily: 'inherit',
              cursor: 'pointer',
              background: '#fff',
              color: '#64748b',
              transition: 'all 0.15s',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.background = '#eef2ff';
              e.currentTarget.style.borderColor = '#c7d2fe';
              e.currentTarget.style.color = '#4f46e5';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.background = '#fff';
              e.currentTarget.style.borderColor = '#e2e8f0';
              e.currentTarget.style.color = '#64748b';
            }}
          >
            ?
          </button>

          <div style={{ width: 1, height: 20, background: '#e2e8f0' }} />

          {/* Version filter */}
          <VersionIndicator
            versions={versions}
            activeVersionFilter={activeVersionFilter}
            onFilterChange={setActiveVersionFilter}
          />

          <div style={{ width: 1, height: 20, background: '#e2e8f0' }} />

          {/* Sprint indicator and filter */}
          <SprintIndicator
            cycles={cycles}
            activeCycleFilter={activeCycleFilter}
            onFilterChange={setActiveCycleFilter}
            onOpenPanel={() => {
              setSprintPanelOpen(!sprintPanelOpen);
              if (!sprintPanelOpen) {
                setBlockedPanelOpen(false);
                // Mutual-exclusion fix from Ray's #100 review: the
                // Blocked + Triage handlers below close Sprint when
                // they open, but Sprint wasn't symmetrically closing
                // Triage. Result: the Triage indicator stayed
                // highlighted while Sprint rendered (panel precedence
                // chain at the right-dock favours Sprint).
                setTriagePanelOpen(false);
              }
            }}
            panelOpen={sprintPanelOpen}
          />

          <div style={{ width: 1, height: 20, background: '#e2e8f0' }} />

          {/* Blocked indicator */}
          <BlockedIndicator
            count={blockedLeafCount}
            panelOpen={blockedPanelOpen}
            onOpenPanel={() => {
              setBlockedPanelOpen(!blockedPanelOpen);
              if (!blockedPanelOpen) {
                setSprintPanelOpen(false);
                setTriagePanelOpen(false);
              }
            }}
          />

          <div style={{ width: 1, height: 20, background: '#e2e8f0' }} />

          {/* Triage indicator (#94) */}
          <TriageIndicator
            count={triagePendingCount}
            panelOpen={triagePanelOpen}
            onOpenPanel={() => {
              setTriagePanelOpen(!triagePanelOpen);
              if (!triagePanelOpen) {
                setSprintPanelOpen(false);
                setBlockedPanelOpen(false);
              }
            }}
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
            health === 'on_track' ? (
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
            ) : (
              <button
                onClick={() => setHealthListHealth(health)}
                title={`Show ${healthInfo.text.toLowerCase()} tasks`}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: 4,
                  background: healthInfo.bg,
                  color: healthInfo.fg,
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {healthInfo.text}
              </button>
            )
          )}

          {/* Connection status */}
          <ConnectionDot connected={wsConnected} />

          <div style={{ width: 1, height: 20, background: '#e2e8f0' }} />

          {/* Share button */}
          <button
            onClick={() => setShareDialogOpen(true)}
            style={{
              padding: '3px 10px',
              borderRadius: 4,
              border: '1px solid #e2e8f0',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: 'pointer',
              background: '#fff',
              color: '#4f46e5',
              transition: 'all 0.15s',
            }}
          >
            Share
          </button>

          {/* AI Chat toggle */}
          <button
            onClick={() => {
              // Three states: closed → fully open, minimised → restore,
              // open → close. Bringing AI Chat fully on screen force-minimises
              // (not closes) a fully-open Map chat — both 380px right-docks
              // overlap, but its conversation is preserved.
              if (!aiChatOpen) {
                setAiChatOpen(true);
                setAiChatMinimised(false);
                if (mapChatOpen && !mapChatMinimised) setMapChatMinimised(true);
              } else if (aiChatMinimised) {
                setAiChatMinimised(false);
                if (mapChatOpen && !mapChatMinimised) setMapChatMinimised(true);
              } else {
                setAiChatOpen(false);
              }
            }}
            style={{
              padding: '3px 10px',
              borderRadius: 4,
              border: '1px solid #e2e8f0',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: 'pointer',
              background: aiChatOpen ? '#3b82f6' : '#fff',
              color: aiChatOpen ? '#fff' : '#3b82f6',
              transition: 'all 0.15s',
            }}
          >
            AI Chat
          </button>

          {/* Map chat toggle (talk to other people on this map) */}
          <button
            onClick={() => {
              if (!mapChatOpen) {
                setMapChatOpen(true);
                setMapChatMinimised(false);
                if (aiChatOpen && !aiChatMinimised) setAiChatMinimised(true);
              } else if (mapChatMinimised) {
                setMapChatMinimised(false);
                if (aiChatOpen && !aiChatMinimised) setAiChatMinimised(true);
              } else {
                setMapChatOpen(false);
              }
            }}
            title={
              mapChatUnread > 0
                ? `Map chat — ${mapChatUnread} new`
                : 'Chat with others on this map'
            }
            style={{
              position: 'relative',
              padding: '3px 10px',
              borderRadius: 4,
              border: '1px solid #e2e8f0',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: 'pointer',
              background: mapChatOpen ? '#0ea5e9' : '#fff',
              color: mapChatOpen ? '#fff' : '#0ea5e9',
              transition: 'all 0.15s',
            }}
          >
            Map chat
            {mapChatUnread > 0 && !mapChatOpen && (
              <span
                style={{
                  position: 'absolute',
                  top: -5,
                  right: -5,
                  minWidth: 16,
                  height: 16,
                  padding: '0 4px',
                  borderRadius: 8,
                  background: '#dc2626',
                  color: '#fff',
                  fontSize: 10,
                  fontWeight: 700,
                  lineHeight: '16px',
                  textAlign: 'center',
                  boxShadow: '0 0 0 1.5px #fff',
                }}
              >
                {mapChatUnread > 99 ? '99+' : mapChatUnread}
              </span>
            )}
          </button>

          {/* GitHub settings */}
          <button
            onClick={() => setGithubSettingsOpen(true)}
            title="GitHub Integration"
            style={{
              padding: '3px 8px',
              borderRadius: 4,
              border: '1px solid #e2e8f0',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: 'pointer',
              background: '#fff',
              color: '#64748b',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              transition: 'all 0.15s',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </button>

          {/* Settings */}
          <button
            onClick={() => setWorkspaceSettingsOpen(true)}
            title="Workspace Settings"
            style={{
              padding: '3px 8px',
              borderRadius: 4,
              border: '1px solid #e2e8f0',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: 'pointer',
              background: '#fff',
              color: '#64748b',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              transition: 'all 0.15s',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="8" r="2.5" />
              <path d="M13.5 8a5.5 5.5 0 01-.3 1.6l1.3.8-.8 1.4-1.4-.5a5.5 5.5 0 01-1.4.8l-.2 1.5H9l-.2-1.5a5.5 5.5 0 01-1.4-.8l-1.4.5-.8-1.4 1.3-.8A5.5 5.5 0 016.2 8a5.5 5.5 0 01.3-1.6l-1.3-.8.8-1.4 1.4.5a5.5 5.5 0 011.4-.8L9 2.4h1.6l.2 1.5a5.5 5.5 0 011.4.8l1.4-.5.8 1.4-1.3.8a5.5 5.5 0 01.3 1.6z" />
            </svg>
          </button>

          <div style={{ width: 1, height: 20, background: '#e2e8f0' }} />

          {/* User avatar + name + logout */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: '#eef2ff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 700,
                color: '#4f46e5',
                flexShrink: 0,
              }}
            >
              {(user?.name ?? user?.email ?? '?')[0].toUpperCase()}
            </div>
            <span style={{ fontSize: 11, fontWeight: 500, color: '#475569', maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.name ?? user?.email}
            </span>
            <button
              onClick={logout}
              title="Sign out"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '2px 4px',
                fontSize: 11,
                color: '#94a3b8',
                fontFamily: 'inherit',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M6 14H3a1 1 0 01-1-1V3a1 1 0 011-1h3M11 11l3-3-3-3M14 8H6" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* GitHub connection banner */}
      {ghBanner && (
        <div
          style={{
            padding: '6px 16px',
            background: ghBanner.includes('failed') ? '#fef2f2' : '#f0fdf4',
            borderBottom: `1px solid ${ghBanner.includes('failed') ? '#fecaca' : '#bbf7d0'}`,
            color: ghBanner.includes('failed') ? '#991b1b' : '#166534',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>{ghBanner}</span>
          <button
            onClick={() => setGhBanner(null)}
            style={{
              background: 'none',
              border: 'none',
              color: 'inherit',
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

      {/* Breadcrumb navigation for drill-down */}
      <Breadcrumb />

      {/* Main content + Property/Sprint panel */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {activeView === 'mindmap' && <MindmapEditor />}
          {activeView === 'kanban' && <KanbanView />}
          {activeView === 'gantt' && <GanttView />}
          {activeView === 'releases' && <ReleasesView />}
          {activeView === 'list' && <ListView />}
          {activeView === 'calendar' && <CalendarView />}
          {activeView === 'hill' && <HillChart />}
          {activeView === 'workload' && <WorkloadView />}
        </div>
        {blockedPanelOpen ? (
          <BlockedPanel onClose={() => setBlockedPanelOpen(false)} />
        ) : sprintPanelOpen ? (
          <SprintPanel onClose={() => setSprintPanelOpen(false)} />
        ) : triagePanelOpen && currentMapId ? (
          <TriagePanel
            mapId={currentMapId}
            onClose={() => setTriagePanelOpen(false)}
          />
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

      {/* Import/Export Modal */}
      <ImportExport
        open={importExportOpen}
        onClose={() => setImportExportOpen(false)}
      />

      {/* Share Dialog */}
      {shareDialogOpen && currentMapId && (
        <ShareDialog
          mapId={currentMapId}
          onClose={() => setShareDialogOpen(false)}
        />
      )}

      {/* GitHub Settings Dialog (legacy per-map) */}
      {githubSettingsOpen && currentMapId && (
        <GitHubSettingsDialog
          mapId={currentMapId}
          onClose={() => setGithubSettingsOpen(false)}
        />
      )}

      {/* Workspace Settings */}
      {workspaceSettingsOpen && (
        <WorkspaceSettings onClose={() => setWorkspaceSettingsOpen(false)} mapId={currentMapId} />
      )}

      {/* Help / User Guide */}
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}

      {/* Health drilldown list */}
      {healthListHealth && (
        <HealthListDialog
          health={healthListHealth}
          onClose={() => setHealthListHealth(null)}
        />
      )}

      {/* AI Chat Panel — full panel when open & !minimised, chip when minimised */}
      {aiChatOpen && currentMapId && !aiChatMinimised && (
        <AIChatPanel
          mapId={currentMapId}
          onClose={() => setAiChatOpen(false)}
          onMinimise={() => setAiChatMinimised(true)}
        />
      )}
      {aiChatOpen && currentMapId && aiChatMinimised && (
        <MinimisedChip
          label="AI Chat"
          color="#3b82f6"
          bottom={72}
          onExpand={() => {
            setAiChatMinimised(false);
            // Force-minimise (not close) the other chat if it's fully open,
            // so the two 380px right-docked panels don't overlap. Leave it
            // alone if it's already minimised or fully closed.
            if (mapChatOpen && !mapChatMinimised) setMapChatMinimised(true);
          }}
          onClose={() => setAiChatOpen(false)}
        />
      )}

      {/* Map Chat Panel — same minimise pattern */}
      {mapChatOpen && currentMapId && rootNodeId && !mapChatMinimised && (
        <MapChatPanel
          mapId={currentMapId}
          rootNodeId={rootNodeId}
          onClose={() => setMapChatOpen(false)}
          onMinimise={() => setMapChatMinimised(true)}
        />
      )}
      {mapChatOpen && currentMapId && rootNodeId && mapChatMinimised && (
        <MinimisedChip
          label={mapChatUnread > 0 ? `Map chat · ${mapChatUnread > 99 ? '99+' : mapChatUnread}` : 'Map chat'}
          color="#0ea5e9"
          bottom={aiChatOpen && aiChatMinimised ? 116 : 72}
          onExpand={() => {
            setMapChatMinimised(false);
            if (aiChatOpen && !aiChatMinimised) setAiChatMinimised(true);
          }}
          onClose={() => setMapChatOpen(false)}
        />
      )}

      <TicketButton />
    </div>
  );
}
