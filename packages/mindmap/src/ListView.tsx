import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Node, NodeId, ComputedNodeValues, Priority } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import { OctocatIcon } from './icons/Octocat.js';
import { pickCurrentCycle } from './roles.js';

// ── Constants ──────────────────────────────────────────────────

const toggleStyle = (on: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11,
  fontWeight: 500,
  color: '#64748b',
  cursor: 'pointer',
  padding: '4px 8px',
  borderRadius: 6,
  background: on ? '#eef2ff' : 'transparent',
  border: on ? '1px solid #c7d2fe' : '1px solid transparent',
});

const STATUS_OPTIONS = [
  { value: '', label: 'No status' },
  { value: 'todo', label: 'To Do' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
  { value: 'blocked', label: 'Blocked' },
];

const PRIORITY_OPTIONS: Array<{ value: string; label: string; color: string }> = [
  { value: '', label: 'None', color: '#94a3b8' },
  { value: 'P0', label: 'P0', color: '#dc2626' },
  { value: 'P1', label: 'P1', color: '#ea580c' },
  { value: 'P2', label: 'P2', color: '#2563eb' },
  { value: 'P3', label: 'P3', color: '#6b7280' },
];

const HEALTH_BADGE: Record<string, { text: string; bg: string; fg: string }> = {
  on_track: { text: 'On Track', bg: '#dcfce7', fg: '#166534' },
  at_risk: { text: 'At Risk', bg: '#fef3c7', fg: '#92400e' },
  behind: { text: 'Behind', bg: '#fee2e2', fg: '#991b1b' },
};

const PRIORITY_BADGE: Record<string, { bg: string; fg: string }> = {
  P0: { bg: '#fee2e2', fg: '#dc2626' },
  P1: { bg: '#ffedd5', fg: '#ea580c' },
  P2: { bg: '#dbeafe', fg: '#2563eb' },
  P3: { bg: '#f1f5f9', fg: '#6b7280' },
};

const STATUS_BADGE: Record<string, { bg: string; fg: string }> = {
  todo: { bg: '#f1f5f9', fg: '#475569' },
  in_progress: { bg: '#dbeafe', fg: '#1d4ed8' },
  done: { bg: '#dcfce7', fg: '#166534' },
  blocked: { bg: '#fee2e2', fg: '#991b1b' },
};

const ROW_HEIGHT = 36;
const INDENT_PX = 20;
const DEBOUNCE_MS = 400;

// Sentinel option value for the "+ New phase…" entry in the phase
// dropdown — switches the cell into an inline text editor that creates
// the phase (appended to the map's phases list) and assigns it.
const NEW_PHASE_VALUE = '__new_phase__';

type SortKey =
  | 'tree'
  | 'title'
  | 'status'
  | 'priority'
  | 'phase'
  | 'effort'
  | 'progress'
  | 'health'
  | 'startDate'
  | 'dueDate';
type SortDir = 'asc' | 'desc';
type GroupBy = 'none' | 'status' | 'priority' | 'phase' | 'parent';

// ── Flat row type ──────────────────────────────────────────────

interface FlatRow {
  node: Node;
  depth: number;
  cv: ComputedNodeValues | undefined;
  isLeaf: boolean;
  treeIndex: number; // original tree order index
}

// ── Debounce hook ──────────────────────────────────────────────

function useDebouncedCallback(delay: number) {
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  return useCallback(
    (key: string, fn: () => void) => {
      const existing = timers.current.get(key);
      if (existing) clearTimeout(existing);
      timers.current.set(
        key,
        setTimeout(() => {
          fn();
          timers.current.delete(key);
        }, delay),
      );
    },
    [delay],
  );
}

// ── Inline cell components ─────────────────────────────────────

const cellInput: React.CSSProperties = {
  width: '100%',
  height: '100%',
  border: 'none',
  outline: 'none',
  background: 'transparent',
  fontFamily: 'inherit',
  fontSize: 12,
  color: '#1e293b',
  padding: '0 6px',
  boxSizing: 'border-box',
};

const cellSelect: React.CSSProperties = {
  ...cellInput,
  appearance: 'none',
  cursor: 'pointer',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath fill='%2394a3b8' d='M2 3.5L5 7l3-3.5H2z'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 4px center',
  paddingRight: 18,
};

const disabledCell: React.CSSProperties = {
  ...cellInput,
  color: '#94a3b8',
  cursor: 'default',
};

// ── Main component ─────────────────────────────────────────────

export function ListView() {
  const nodes = useMindmapStore((s) => s.nodes);
  const currentMap = useMindmapStore((s) => s.currentMap);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);
  const computed = useMindmapStore((s) => s.computed);
  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const updateNode = useMindmapStore((s) => s.updateNode);
  const createPhase = useMindmapStore((s) => s.createPhase);
  const deleteNode = useMindmapStore((s) => s.deleteNode);
  const toggleCollapse = useMindmapStore((s) => s.toggleCollapse);
  const getVisibleNodes = useMindmapStore((s) => s.getVisibleNodes);
  const focusNodeId = useMindmapStore((s) => s.focusNodeId);
  const maxDepth = useMindmapStore((s) => s.maxDepth);
  const activeVersionFilter = useMindmapStore((s) => s.activeVersionFilter);
  const activeCycleFilter = useMindmapStore((s) => s.activeCycleFilter);
  const activePhaseFilter = useMindmapStore((s) => s.activePhaseFilter);

  // ── Local UI state ────────────────────────────────────────────

  const [sortKey, setSortKey] = useState<SortKey>('tree');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [priorityFilter, setPriorityFilter] = useState<Set<string>>(new Set());
  const [blockedFilter, setBlockedFilter] = useState<'all' | 'blocked' | 'unblocked'>('all');
  const [leavesOnly, setLeavesOnly] = useState(false);
  // "Mine" — nodes assigned to the signed-in user. Off by default: on real
  // maps most tickets are unassigned (persona Round 1), so on-by-default
  // would show an empty list.
  const [mineOnly, setMineOnly] = useState(false);
  const user = useMindmapStore((s) => s.user);
  const cycles = useMindmapStore((s) => s.cycles);
  const setActiveCycleFilter = useMindmapStore((s) => s.setActiveCycleFilter);
  const currentCycle = useMemo(() => pickCurrentCycle(cycles), [cycles]);
  const currentSprintOn = currentCycle !== null && activeCycleFilter === currentCycle.id;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editingCell, setEditingCell] = useState<{ nodeId: string; field: string } | null>(null);

  const debounce = useDebouncedCallback(DEBOUNCE_MS);
  const tableRef = useRef<HTMLDivElement>(null);

  // Phase definitions of the current map, sorted by position (canonical
  // phase order) — dropdown options and phase grouping render in this order.
  const mapPhases = useMemo(
    () => [...(currentMap?.phases ?? [])].sort((a, b) => a.position - b.position),
    [currentMap],
  );
  const phaseNameById = useMemo(
    () => new Map(mapPhases.map((p) => [p.id, p.name] as const)),
    [mapPhases],
  );

  // Sync single selection with store
  useEffect(() => {
    if (selectedIds.size === 1) {
      const id = [...selectedIds][0];
      if (id !== selectedNodeId) selectNode(id);
    }
  }, [selectedIds, selectedNodeId, selectNode]);

  // ── Flatten tree (respects drill-down) ──────────────────────────

  const flatRows = useMemo(() => {
    const visibleNodes = getVisibleNodes();
    if (visibleNodes.length === 0) return [];

    const rows: FlatRow[] = [];
    let treeIdx = 0;

    for (const vn of visibleNodes) {
      if (vn.isDimmed) continue; // skip dimmed siblings in list view
      const isLeaf = vn.node.childrenIds.length === 0 || vn.hasHiddenChildren;
      rows.push({
        node: vn.node,
        depth: vn.depth,
        cv: computed.get(vn.node.id),
        isLeaf,
        treeIndex: treeIdx++,
      });
    }

    return rows;
  }, [nodes, rootNodeId, computed, getVisibleNodes, focusNodeId, maxDepth, activeVersionFilter, activeCycleFilter, activePhaseFilter]);

  // ── Filter ────────────────────────────────────────────────────

  const filteredRows = useMemo(() => {
    let rows = flatRows;

    // Text search
    if (searchText.trim()) {
      const q = searchText.toLowerCase().trim();
      // Keep rows matching + all ancestors so tree structure is visible
      const matchIds = new Set<string>();
      for (const r of rows) {
        if (r.node.text.toLowerCase().includes(q)) {
          matchIds.add(r.node.id);
          // Walk up to keep ancestors visible
          let cur = r.node;
          while (cur.parentId && nodes[cur.parentId]) {
            matchIds.add(cur.parentId);
            cur = nodes[cur.parentId];
          }
        }
      }
      rows = rows.filter((r) => matchIds.has(r.node.id));
    }

    // Status filter
    if (statusFilter.size > 0) {
      const matchIds = new Set<string>();
      for (const r of rows) {
        const s = r.node.status ?? '';
        if (statusFilter.has(s)) {
          matchIds.add(r.node.id);
          let cur = r.node;
          while (cur.parentId && nodes[cur.parentId]) {
            matchIds.add(cur.parentId);
            cur = nodes[cur.parentId];
          }
        }
      }
      rows = rows.filter((r) => matchIds.has(r.node.id));
    }

    // Priority filter
    if (priorityFilter.size > 0) {
      const matchIds = new Set<string>();
      for (const r of rows) {
        const p = r.node.priority ?? '';
        if (priorityFilter.has(p)) {
          matchIds.add(r.node.id);
          let cur = r.node;
          while (cur.parentId && nodes[cur.parentId]) {
            matchIds.add(cur.parentId);
            cur = nodes[cur.parentId];
          }
        }
      }
      rows = rows.filter((r) => matchIds.has(r.node.id));
    }

    // Blocked filter
    if (blockedFilter !== 'all') {
      const matchIds = new Set<string>();
      for (const r of rows) {
        const blocked = r.cv?.isBlocked ?? false;
        if ((blockedFilter === 'blocked' && blocked) || (blockedFilter === 'unblocked' && !blocked)) {
          matchIds.add(r.node.id);
          let cur = r.node;
          while (cur.parentId && nodes[cur.parentId]) {
            matchIds.add(cur.parentId);
            cur = nodes[cur.parentId];
          }
        }
      }
      rows = rows.filter((r) => matchIds.has(r.node.id));
    }

    // Leaves only
    if (leavesOnly) {
      rows = rows.filter((r) => r.isLeaf);
    }

    // Mine — keep ancestors so the tree stays readable, like text search
    if (mineOnly && user) {
      const uid = user.id;
      const matchIds = new Set<string>();
      for (const r of rows) {
        if (r.node.assigneeIds.includes(uid)) {
          matchIds.add(r.node.id);
          let cur = r.node;
          while (cur.parentId && nodes[cur.parentId]) {
            matchIds.add(cur.parentId);
            cur = nodes[cur.parentId];
          }
        }
      }
      rows = rows.filter((r) => matchIds.has(r.node.id));
    }

    return rows;
  }, [flatRows, searchText, statusFilter, priorityFilter, blockedFilter, leavesOnly, mineOnly, user, nodes]);

  // ── Sort ──────────────────────────────────────────────────────

  const sortedRows = useMemo(() => {
    if (sortKey === 'tree') return filteredRows;

    const sorted = [...filteredRows];
    const dir = sortDir === 'asc' ? 1 : -1;

    sorted.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'title':
          cmp = a.node.text.localeCompare(b.node.text);
          break;
        case 'status':
          cmp = (a.node.status ?? '').localeCompare(b.node.status ?? '');
          break;
        case 'priority':
          cmp = (a.node.priority ?? 'P9').localeCompare(b.node.priority ?? 'P9');
          break;
        case 'phase': {
          // Sort by the map's canonical phase order (position); rows
          // without a phase (or with a dangling id) sort last.
          const ai = a.node.phaseId ? mapPhases.findIndex((p) => p.id === a.node.phaseId) : -1;
          const bi = b.node.phaseId ? mapPhases.findIndex((p) => p.id === b.node.phaseId) : -1;
          cmp =
            (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) -
            (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
          break;
        }
        case 'effort':
          cmp = (a.cv?.computedEffort ?? 0) - (b.cv?.computedEffort ?? 0);
          break;
        case 'progress':
          cmp = (a.cv?.computedProgress ?? 0) - (b.cv?.computedProgress ?? 0);
          break;
        case 'health': {
          const order: Record<string, number> = { behind: 0, at_risk: 1, on_track: 2 };
          cmp = (order[a.cv?.healthSignal ?? 'on_track'] ?? 2) - (order[b.cv?.healthSignal ?? 'on_track'] ?? 2);
          break;
        }
        case 'startDate':
          cmp = (a.node.startDate ?? '').localeCompare(b.node.startDate ?? '');
          break;
        case 'dueDate':
          cmp = (a.node.dueDate ?? '').localeCompare(b.node.dueDate ?? '');
          break;
      }
      return cmp * dir;
    });

    return sorted;
  }, [filteredRows, sortKey, sortDir, mapPhases]);

  // ── Group ─────────────────────────────────────────────────────

  type GroupedResult = Array<{ label: string; rows: FlatRow[]; stats: { effort: number; progress: number; count: number } }>;

  const groupedRows = useMemo((): GroupedResult | null => {
    if (groupBy === 'none') return null;

    const groups = new Map<string, FlatRow[]>();

    for (const row of sortedRows) {
      let key: string;
      switch (groupBy) {
        case 'status':
          key = row.node.status ?? '(no status)';
          break;
        case 'priority':
          key = row.node.priority ?? '(no priority)';
          break;
        case 'phase':
          key = row.node.phaseId
            ? (phaseNameById.get(row.node.phaseId) ?? '(unknown phase)')
            : '(no phase)';
          break;
        case 'parent':
          key = row.node.parentId ? (nodes[row.node.parentId]?.text ?? '(unknown)') : '(root)';
          break;
        default:
          key = '';
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    const result: GroupedResult = [];
    for (const [label, rows] of groups) {
      const totalEffort = rows.reduce((s, r) => s + (r.cv?.computedEffort ?? 0), 0);
      const avgProgress = rows.length > 0
        ? rows.reduce((s, r) => s + (r.cv?.computedProgress ?? 0), 0) / rows.length
        : 0;
      result.push({ label, rows, stats: { effort: totalEffort, progress: avgProgress, count: rows.length } });
    }

    // Phase groups render in canonical phase order (position), with the
    // "(no phase)" / "(unknown phase)" buckets at the end.
    if (groupBy === 'phase') {
      const orderByLabel = new Map(mapPhases.map((p, i) => [p.name, i] as const));
      result.sort(
        (x, y) =>
          (orderByLabel.get(x.label) ?? Number.MAX_SAFE_INTEGER) -
          (orderByLabel.get(y.label) ?? Number.MAX_SAFE_INTEGER),
      );
    }

    return result;
  }, [sortedRows, groupBy, nodes, mapPhases, phaseNameById]);

  // ── Column header click → sort ────────────────────────────────

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        if (sortDir === 'asc') setSortDir('desc');
        else {
          // Reset to tree order
          setSortKey('tree');
          setSortDir('asc');
        }
      } else {
        setSortKey(key);
        setSortDir('asc');
      }
    },
    [sortKey, sortDir],
  );

  // ── Row click / selection ─────────────────────────────────────

  const handleRowClick = useCallback(
    (nodeId: string, e: React.MouseEvent) => {
      if (e.shiftKey) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(nodeId)) next.delete(nodeId);
          else next.add(nodeId);
          return next;
        });
      } else {
        setSelectedIds(new Set([nodeId]));
      }
      setEditingCell(null);
    },
    [],
  );

  // ── Cell click → start editing ────────────────────────────────

  const handleCellClick = useCallback(
    (nodeId: string, field: string, e: React.MouseEvent) => {
      e.stopPropagation();
      setEditingCell({ nodeId, field });
      setSelectedIds(new Set([nodeId]));
    },
    [],
  );

  // ── Bulk operations ───────────────────────────────────────────

  const handleBulkStatus = useCallback(
    (status: string) => {
      for (const id of selectedIds) {
        updateNode(id, { status: status || null });
      }
    },
    [selectedIds, updateNode],
  );

  const handleBulkPriority = useCallback(
    (priority: string) => {
      for (const id of selectedIds) {
        updateNode(id, { priority: (priority || null) as Priority | null });
      }
    },
    [selectedIds, updateNode],
  );

  const handleBulkDelete = useCallback(() => {
    const ids = [...selectedIds];
    setSelectedIds(new Set());
    for (const id of ids) {
      deleteNode(id);
    }
  }, [selectedIds, deleteNode]);

  // ── Multi-select filter toggles ───────────────────────────────

  const toggleStatusFilter = useCallback((val: string) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val);
      else next.add(val);
      return next;
    });
  }, []);

  const togglePriorityFilter = useCallback((val: string) => {
    setPriorityFilter((prev) => {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val);
      else next.add(val);
      return next;
    });
  }, []);

  // ── Sort arrow indicator ──────────────────────────────────────

  const sortArrow = (key: SortKey) => {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
  };

  // ── Render a single data row ──────────────────────────────────

  const renderRow = (row: FlatRow, idx: number) => {
    const { node, depth, cv, isLeaf } = row;
    const isSelected = selectedIds.has(node.id);
    const hasChildren = node.childrenIds.length > 0;
    const health = cv?.healthSignal ?? 'on_track';
    const healthInfo = HEALTH_BADGE[health];
    const priorityInfo = node.priority ? PRIORITY_BADGE[node.priority] : null;
    const statusInfo = node.status ? STATUS_BADGE[node.status] : null;

    const statusLabel = STATUS_OPTIONS.find((o) => o.value === (node.status ?? ''))?.label ?? (node.status ?? '-');
    const priorityLabel = PRIORITY_OPTIONS.find((o) => o.value === (node.priority ?? ''))?.label ?? '-';

    const rowBg = isSelected
      ? '#eef2ff'
      : idx % 2 === 0
        ? '#ffffff'
        : '#f8fafc';

    const isEditingField = (field: string) =>
      editingCell?.nodeId === node.id && editingCell?.field === field;

    return (
      <div
        key={node.id}
        onClick={(e) => handleRowClick(node.id, e)}
        style={{
          display: 'flex',
          height: ROW_HEIGHT,
          minHeight: ROW_HEIGHT,
          alignItems: 'center',
          background: rowBg,
          borderBottom: '1px solid #f1f5f9',
          cursor: 'pointer',
          transition: 'background 0.1s',
        }}
        onMouseEnter={(e) => {
          if (!isSelected) e.currentTarget.style.background = '#f1f5f9';
        }}
        onMouseLeave={(e) => {
          if (!isSelected) e.currentTarget.style.background = rowBg;
        }}
      >
        {/* Title — sticky first column */}
        <div
          style={{
            width: 320,
            minWidth: 320,
            position: 'sticky',
            left: 0,
            zIndex: 2,
            background: 'inherit',
            display: 'flex',
            alignItems: 'center',
            height: '100%',
            borderRight: '1px solid #e2e8f0',
            paddingLeft: depth * INDENT_PX + 8,
            boxSizing: 'border-box',
          }}
        >
          {/* Collapse toggle */}
          {hasChildren ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleCollapse(node.id);
              }}
              style={{
                width: 18,
                height: 18,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                color: '#94a3b8',
                fontSize: 10,
                flexShrink: 0,
                borderRadius: 3,
                transition: 'background 0.1s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#e2e8f0')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
              title={node.collapsed ? 'Expand' : 'Collapse'}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                {node.collapsed ? (
                  <path d="M3 1.5L7.5 5 3 8.5V1.5z" />
                ) : (
                  <path d="M1.5 3L5 7.5 8.5 3H1.5z" />
                )}
              </svg>
            </button>
          ) : (
            <span style={{ width: 18, flexShrink: 0 }} />
          )}

          {/* Title text */}
          {isEditingField('title') ? (
            <TitleEditor
              value={node.text}
              onSave={(text) => {
                updateNode(node.id, { text });
                setEditingCell(null);
              }}
              onCancel={() => setEditingCell(null)}
            />
          ) : (
            <span
              onDoubleClick={(e) => handleCellClick(node.id, 'title', e)}
              style={{
                fontSize: 12,
                fontWeight: hasChildren ? 600 : 400,
                color: '#1e293b',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
                paddingLeft: 4,
              }}
              title={node.text}
            >
              {node.text}
            </span>
          )}
          {(() => {
            const githubLink = node.externalLinks.find((l) => l.provider === 'github');
            if (!githubLink) return null;
            const issueNum = githubLink.externalId.split('#')[1];
            return (
              <a
                href={githubLink.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={githubLink.externalId}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                  marginLeft: 6,
                  marginRight: 6,
                  flexShrink: 0,
                  fontSize: 11,
                  color: githubLink.syncEnabled ? '#475569' : '#94a3b8',
                  textDecoration: 'none',
                }}
              >
                <OctocatIcon size={11} color="currentColor" />
                {issueNum && <span>#{issueNum}</span>}
              </a>
            );
          })()}
        </div>

        {/* Status */}
        <div
          style={{ width: 110, minWidth: 110, height: '100%', display: 'flex', alignItems: 'center', borderRight: '1px solid #f1f5f9', padding: '0 4px', boxSizing: 'border-box' }}
          onClick={(e) => handleCellClick(node.id, 'status', e)}
        >
          {isEditingField('status') ? (
            <select
              autoFocus
              value={node.status ?? ''}
              onChange={(e) => {
                updateNode(node.id, { status: e.target.value || null });
                setEditingCell(null);
              }}
              onBlur={() => setEditingCell(null)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setEditingCell(null); }}
              style={cellSelect}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
              {statusInfo ? (
                <span style={{ fontSize: 11, fontWeight: 500, padding: '2px 6px', borderRadius: 4, background: statusInfo.bg, color: statusInfo.fg }}>
                  {statusLabel}
                </span>
              ) : (
                <span style={{ fontSize: 11, color: '#cbd5e1' }}>-</span>
              )}
              {cv?.isBlocked && (
                <span
                  title={
                    cv.blockedBy?.manual
                      ? `Blocked: ${node.blockedReason ?? ''}`
                      : `Waiting on ${cv.blockedBy?.predecessorIds.length ?? 0} predecessor(s)`
                  }
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    padding: '2px 5px',
                    borderRadius: 4,
                    background: STATUS_BADGE.blocked.bg,
                    color: STATUS_BADGE.blocked.fg,
                    flexShrink: 0,
                  }}
                >
                  🔒
                </span>
              )}
            </div>
          )}
        </div>

        {/* Priority */}
        <div
          style={{ width: 70, minWidth: 70, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRight: '1px solid #f1f5f9', boxSizing: 'border-box' }}
          onClick={(e) => handleCellClick(node.id, 'priority', e)}
        >
          {isEditingField('priority') ? (
            <select
              autoFocus
              value={node.priority ?? ''}
              onChange={(e) => {
                updateNode(node.id, { priority: (e.target.value || null) as Priority | null });
                setEditingCell(null);
              }}
              onBlur={() => setEditingCell(null)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setEditingCell(null); }}
              style={cellSelect}
            >
              {PRIORITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : (
            priorityInfo ? (
              <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: priorityInfo.bg, color: priorityInfo.fg }}>
                {priorityLabel}
              </span>
            ) : (
              <span style={{ fontSize: 11, color: '#cbd5e1' }}>-</span>
            )
          )}
        </div>

        {/* Phase */}
        <div
          style={{ width: 110, minWidth: 110, height: '100%', display: 'flex', alignItems: 'center', borderRight: '1px solid #f1f5f9', padding: '0 4px', boxSizing: 'border-box' }}
          onClick={(e) => {
            // Don't restart the select while the "+ New phase…" text
            // editor is open — a click inside the input bubbles here.
            if (isEditingField('phaseNew')) {
              e.stopPropagation();
              return;
            }
            handleCellClick(node.id, 'phase', e);
          }}
        >
          {isEditingField('phaseNew') ? (
            <PhaseEditor
              onSave={async (name) => {
                // Create the PhaseDef on the map (appended at the end of
                // the canonical order), then assign it to the node.
                const phaseId = await createPhase(name);
                if (phaseId) updateNode(node.id, { phaseId });
                setEditingCell(null);
              }}
              onCancel={() => setEditingCell(null)}
            />
          ) : isEditingField('phase') ? (
            <select
              autoFocus
              value={node.phaseId ?? ''}
              onChange={(e) => {
                if (e.target.value === NEW_PHASE_VALUE) {
                  setEditingCell({ nodeId: node.id, field: 'phaseNew' });
                  return;
                }
                updateNode(node.id, { phaseId: e.target.value || null });
                setEditingCell(null);
              }}
              onBlur={() =>
                // Keep the phaseNew editor alive when the blur was caused
                // by switching to it via the "+ New phase…" option.
                setEditingCell((cur) => (cur?.field === 'phaseNew' ? cur : null))
              }
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setEditingCell(null); }}
              style={cellSelect}
            >
              <option value="">—</option>
              {mapPhases.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
              <option value={NEW_PHASE_VALUE}>+ New phase…</option>
            </select>
          ) : (
            node.phaseId ? (
              <span style={{ fontSize: 11, fontWeight: 500, padding: '2px 6px', borderRadius: 4, background: '#f5f3ff', color: '#6d28d9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {phaseNameById.get(node.phaseId) ?? node.phaseId}
              </span>
            ) : (
              <span style={{ fontSize: 11, color: '#cbd5e1' }}>—</span>
            )
          )}
        </div>

        {/* Assignee */}
        <div style={{ width: 100, minWidth: 100, height: '100%', display: 'flex', alignItems: 'center', padding: '0 6px', borderRight: '1px solid #f1f5f9', boxSizing: 'border-box' }}>
          <span style={{ fontSize: 11, color: node.assigneeIds.length > 0 ? '#475569' : '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {node.assigneeIds.length > 0 ? node.assigneeIds.join(', ') : '-'}
          </span>
        </div>

        {/* Effort Estimate */}
        <div
          style={{ width: 80, minWidth: 80, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 6px', borderRight: '1px solid #f1f5f9', boxSizing: 'border-box' }}
          onClick={(e) => isLeaf ? handleCellClick(node.id, 'effort', e) : undefined}
        >
          {isLeaf && isEditingField('effort') ? (
            <NumberEditor
              value={node.effortEstimate}
              onSave={(val) => {
                updateNode(node.id, { effortEstimate: val });
                setEditingCell(null);
              }}
              onCancel={() => setEditingCell(null)}
            />
          ) : (
            <span style={{ fontSize: 11, color: isLeaf ? '#1e293b' : '#94a3b8', fontStyle: isLeaf ? 'normal' : 'italic' }}>
              {isLeaf
                ? (node.effortEstimate != null ? node.effortEstimate : '-')
                : (cv?.computedEffort ?? '-')}
            </span>
          )}
        </div>

        {/* % Complete */}
        <div
          style={{ width: 90, minWidth: 90, height: '100%', display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px', borderRight: '1px solid #f1f5f9', boxSizing: 'border-box' }}
          onClick={(e) => isLeaf ? handleCellClick(node.id, 'percent', e) : undefined}
        >
          {isLeaf && isEditingField('percent') ? (
            <NumberEditor
              value={node.percentComplete}
              min={0}
              max={100}
              onSave={(val) => {
                updateNode(node.id, { percentComplete: val != null ? Math.min(100, Math.max(0, val)) : null });
                setEditingCell(null);
              }}
              onCancel={() => setEditingCell(null)}
            />
          ) : (
            <>
              <div style={{ flex: 1, height: 4, borderRadius: 2, background: '#e2e8f0', overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${Math.round(isLeaf ? (node.percentComplete ?? 0) : (cv?.computedProgress ?? 0))}%`,
                    height: '100%',
                    borderRadius: 2,
                    background: isLeaf ? '#4f46e5' : '#a5b4fc',
                    transition: 'width 0.2s',
                  }}
                />
              </div>
              <span style={{ fontSize: 11, color: isLeaf ? '#1e293b' : '#94a3b8', minWidth: 28, textAlign: 'right' }}>
                {Math.round(isLeaf ? (node.percentComplete ?? 0) : (cv?.computedProgress ?? 0))}%
              </span>
            </>
          )}
        </div>

        {/* Computed Effort (parents) */}
        <div style={{ width: 80, minWidth: 80, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 6px', borderRight: '1px solid #f1f5f9', boxSizing: 'border-box' }}>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>
            {!isLeaf ? (cv?.computedEffort ?? '-') : '-'}
          </span>
        </div>

        {/* Computed Progress (parents) */}
        <div style={{ width: 90, minWidth: 90, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 6px', borderRight: '1px solid #f1f5f9', boxSizing: 'border-box' }}>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>
            {!isLeaf ? `${Math.round(cv?.computedProgress ?? 0)}%` : '-'}
          </span>
        </div>

        {/* Health */}
        <div style={{ width: 80, minWidth: 80, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRight: '1px solid #f1f5f9', boxSizing: 'border-box' }}>
          <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: healthInfo.bg, color: healthInfo.fg }}>
            {healthInfo.text}
          </span>
        </div>

        {/* Start Date */}
        <div
          style={{ width: 110, minWidth: 110, height: '100%', display: 'flex', alignItems: 'center', padding: '0 4px', borderRight: '1px solid #f1f5f9', boxSizing: 'border-box' }}
          onClick={(e) => handleCellClick(node.id, 'startDate', e)}
        >
          {isEditingField('startDate') ? (
            <input
              type="date"
              autoFocus
              defaultValue={node.startDate ?? ''}
              onChange={(e) => {
                debounce(`startDate-${node.id}`, () => updateNode(node.id, { startDate: e.target.value || null }));
              }}
              onBlur={() => setEditingCell(null)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setEditingCell(null); }}
              style={{ ...cellInput, fontSize: 11 }}
            />
          ) : (
            <span style={{ fontSize: 11, color: node.startDate ? '#475569' : '#cbd5e1' }}>
              {node.startDate ?? '-'}
            </span>
          )}
        </div>

        {/* Due Date */}
        <div
          style={{ width: 110, minWidth: 110, height: '100%', display: 'flex', alignItems: 'center', padding: '0 4px', borderRight: '1px solid #f1f5f9', boxSizing: 'border-box' }}
          onClick={(e) => handleCellClick(node.id, 'dueDate', e)}
        >
          {isEditingField('dueDate') ? (
            <input
              type="date"
              autoFocus
              defaultValue={node.dueDate ?? ''}
              onChange={(e) => {
                debounce(`dueDate-${node.id}`, () => updateNode(node.id, { dueDate: e.target.value || null }));
              }}
              onBlur={() => setEditingCell(null)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setEditingCell(null); }}
              style={{ ...cellInput, fontSize: 11 }}
            />
          ) : (
            <span style={{ fontSize: 11, color: node.dueDate ? '#475569' : '#cbd5e1' }}>
              {node.dueDate ?? '-'}
            </span>
          )}
        </div>

        {/* Tags */}
        <div style={{ width: 140, minWidth: 140, height: '100%', display: 'flex', alignItems: 'center', padding: '0 6px', boxSizing: 'border-box' }}>
          {node.tags.length > 0 ? (
            <div style={{ display: 'flex', gap: 3, overflow: 'hidden' }}>
              {node.tags.map((tag) => (
                <span
                  key={tag}
                  style={{
                    fontSize: 10,
                    padding: '1px 5px',
                    borderRadius: 3,
                    background: '#eef2ff',
                    color: '#4338ca',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : (
            <span style={{ fontSize: 11, color: '#cbd5e1' }}>-</span>
          )}
        </div>
      </div>
    );
  };

  // ── Column header ─────────────────────────────────────────────

  const thStyle = (width: number, sticky?: boolean): React.CSSProperties => ({
    width,
    minWidth: width,
    height: 32,
    display: 'flex',
    alignItems: 'center',
    padding: '0 6px',
    fontSize: 11,
    fontWeight: 600,
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    borderRight: '1px solid #e2e8f0',
    borderBottom: '2px solid #e2e8f0',
    background: '#f8fafc',
    cursor: 'pointer',
    userSelect: 'none',
    boxSizing: 'border-box',
    whiteSpace: 'nowrap',
    ...(sticky
      ? { position: 'sticky', left: 0, zIndex: 4 }
      : {}),
  });

  // ── Group header row ──────────────────────────────────────────

  const renderGroupHeader = (label: string, stats: { effort: number; progress: number; count: number }) => (
    <div
      key={`group-${label}`}
      style={{
        display: 'flex',
        height: 32,
        alignItems: 'center',
        background: '#eef2ff',
        borderBottom: '1px solid #c7d2fe',
        padding: '0 12px',
        gap: 12,
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 700, color: '#4338ca' }}>{label}</span>
      <span style={{ fontSize: 11, color: '#6366f1' }}>{stats.count} items</span>
      <span style={{ fontSize: 11, color: '#6366f1' }}>{stats.effort}d effort</span>
      <span style={{ fontSize: 11, color: '#6366f1' }}>{Math.round(stats.progress)}% avg</span>
    </div>
  );

  // ── Render ────────────────────────────────────────────────────

  const displayRows = groupBy === 'none' ? sortedRows : [];

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#ffffff' }}>
      {/* ── Filter bar ─────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid #e2e8f0',
          background: '#f8fafc',
          flexWrap: 'wrap',
        }}
      >
        {/* Search */}
        <div style={{ position: 'relative', flex: '0 0 200px' }}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#94a3b8"
            strokeWidth="2"
            style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)' }}
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Search nodes..."
            style={{
              width: '100%',
              padding: '5px 8px 5px 28px',
              border: '1px solid #e2e8f0',
              borderRadius: 6,
              fontSize: 12,
              color: '#1e293b',
              background: '#fff',
              outline: 'none',
              fontFamily: 'inherit',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Status filter */}
        <FilterDropdown
          label="Status"
          options={STATUS_OPTIONS.filter((o) => o.value !== '')}
          selected={statusFilter}
          onToggle={toggleStatusFilter}
        />

        {/* Priority filter */}
        <FilterDropdown
          label="Priority"
          options={PRIORITY_OPTIONS.filter((o) => o.value !== '').map((o) => ({ value: o.value, label: o.label }))}
          selected={priorityFilter}
          onToggle={togglePriorityFilter}
        />

        {/* Blocked filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {(['all', 'blocked', 'unblocked'] as const).map((mode) => {
            const active = blockedFilter === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setBlockedFilter(mode)}
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  padding: '4px 8px',
                  borderRadius: 6,
                  background: active ? (mode === 'blocked' ? '#fee2e2' : '#eef2ff') : 'transparent',
                  border: active
                    ? `1px solid ${mode === 'blocked' ? '#fecaca' : '#c7d2fe'}`
                    : '1px solid transparent',
                  color: active ? (mode === 'blocked' ? '#991b1b' : '#4338ca') : '#64748b',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {mode === 'all' ? 'All' : mode === 'blocked' ? '🔒 Blocked' : 'Unblocked'}
              </button>
            );
          })}
        </div>

        {/* Leaves only */}
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            fontWeight: 500,
            color: '#64748b',
            cursor: 'pointer',
            padding: '4px 8px',
            borderRadius: 6,
            background: leavesOnly ? '#eef2ff' : 'transparent',
            border: leavesOnly ? '1px solid #c7d2fe' : '1px solid transparent',
          }}
        >
          <input
            type="checkbox"
            checked={leavesOnly}
            onChange={(e) => setLeavesOnly(e.target.checked)}
            style={{ accentColor: '#4f46e5', width: 12, height: 12 }}
          />
          Leaves only
        </label>

        {/* Mine */}
        {user && (
          <label style={toggleStyle(mineOnly)} title="Only nodes assigned to me">
            <input
              type="checkbox"
              checked={mineOnly}
              onChange={(e) => setMineOnly(e.target.checked)}
              style={{ accentColor: '#4f46e5', width: 12, height: 12 }}
            />
            Mine
          </label>
        )}

        {/* Current sprint — drives the map-wide sprint filter, so the header
            chip and URL (?sprint=) stay in sync with this checkbox. */}
        {currentCycle && (
          <label style={toggleStyle(currentSprintOn)} title={currentCycle.name}>
            <input
              type="checkbox"
              checked={currentSprintOn}
              onChange={(e) => setActiveCycleFilter(e.target.checked ? currentCycle.id : null)}
              style={{ accentColor: '#4f46e5', width: 12, height: 12 }}
            />
            Current sprint
          </label>
        )}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Group by */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 500, color: '#94a3b8' }}>Group:</span>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
            onKeyDown={(e) => e.stopPropagation()}
            style={{
              fontSize: 11,
              padding: '4px 20px 4px 6px',
              border: '1px solid #e2e8f0',
              borderRadius: 6,
              background: '#fff',
              color: '#475569',
              fontFamily: 'inherit',
              outline: 'none',
              appearance: 'none',
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath fill='%2394a3b8' d='M2 3.5L5 7l3-3.5H2z'/%3E%3C/svg%3E")`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 4px center',
              cursor: 'pointer',
            }}
          >
            <option value="none">None</option>
            <option value="status">Status</option>
            <option value="priority">Priority</option>
            <option value="phase">Phase</option>
            <option value="parent">Parent</option>
          </select>
        </div>

        {/* Row count */}
        <span style={{ fontSize: 11, color: '#94a3b8' }}>
          {sortedRows.length} rows
        </span>
      </div>

      {/* ── Table ──────────────────────────────────────────────── */}
      <div
        ref={tableRef}
        style={{
          flex: 1,
          overflow: 'auto',
          position: 'relative',
        }}
      >
        {/* Header row — sticky top */}
        <div
          style={{
            display: 'flex',
            position: 'sticky',
            top: 0,
            zIndex: 5,
          }}
        >
          <div style={thStyle(320, true)} onClick={() => handleSort('title')}>
            Title{sortArrow('title')}
          </div>
          <div style={thStyle(110)} onClick={() => handleSort('status')}>
            Status{sortArrow('status')}
          </div>
          <div style={thStyle(70)} onClick={() => handleSort('priority')}>
            Priority{sortArrow('priority')}
          </div>
          <div style={thStyle(110)} onClick={() => handleSort('phase')}>
            Phase{sortArrow('phase')}
          </div>
          <div style={thStyle(100)}>
            Assignee
          </div>
          <div style={thStyle(80)} onClick={() => handleSort('effort')}>
            Effort{sortArrow('effort')}
          </div>
          <div style={thStyle(90)} onClick={() => handleSort('progress')}>
            % Done{sortArrow('progress')}
          </div>
          <div style={thStyle(80)}>
            Comp. Effort
          </div>
          <div style={thStyle(90)}>
            Comp. Prog.
          </div>
          <div style={thStyle(80)} onClick={() => handleSort('health')}>
            Health{sortArrow('health')}
          </div>
          <div style={thStyle(110)} onClick={() => handleSort('startDate')}>
            Start{sortArrow('startDate')}
          </div>
          <div style={thStyle(110)} onClick={() => handleSort('dueDate')}>
            Due{sortArrow('dueDate')}
          </div>
          <div style={{ ...thStyle(140), borderRight: 'none' }}>
            Tags
          </div>
        </div>

        {/* Body */}
        {groupedRows
          ? groupedRows.map((g) => (
              <div key={g.label}>
                {renderGroupHeader(g.label, g.stats)}
                {g.rows.map((row, idx) => renderRow(row, idx))}
              </div>
            ))
          : displayRows.map((row, idx) => renderRow(row, idx))}

        {/* Empty state */}
        {sortedRows.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
            No nodes match the current filters.
          </div>
        )}
      </div>

      {/* ── Bulk operations bar ────────────────────────────────── */}
      {selectedIds.size > 1 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '8px 16px',
            background: '#1e293b',
            color: '#f8fafc',
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          <span>{selectedIds.size} selected</span>
          <span style={{ color: '#64748b' }}>|</span>

          <span style={{ color: '#94a3b8' }}>Set status:</span>
          <select
            onChange={(e) => {
              if (e.target.value !== '__noop__') {
                handleBulkStatus(e.target.value);
                e.target.value = '__noop__';
              }
            }}
            defaultValue="__noop__"
            style={{
              fontSize: 11,
              padding: '3px 6px',
              borderRadius: 4,
              border: '1px solid #475569',
              background: '#334155',
              color: '#f8fafc',
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            <option value="__noop__" disabled>Choose...</option>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          <span style={{ color: '#64748b' }}>|</span>

          <span style={{ color: '#94a3b8' }}>Set priority:</span>
          <select
            onChange={(e) => {
              if (e.target.value !== '__noop__') {
                handleBulkPriority(e.target.value);
                e.target.value = '__noop__';
              }
            }}
            defaultValue="__noop__"
            style={{
              fontSize: 11,
              padding: '3px 6px',
              borderRadius: 4,
              border: '1px solid #475569',
              background: '#334155',
              color: '#f8fafc',
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            <option value="__noop__" disabled>Choose...</option>
            {PRIORITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          <span style={{ color: '#64748b' }}>|</span>

          <button
            onClick={handleBulkDelete}
            style={{
              fontSize: 11,
              padding: '3px 10px',
              borderRadius: 4,
              border: '1px solid #7f1d1d',
              background: '#991b1b',
              color: '#fecaca',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Delete
          </button>

          {/* Clear selection */}
          <div style={{ flex: 1 }} />
          <button
            onClick={() => setSelectedIds(new Set())}
            style={{
              fontSize: 11,
              padding: '3px 10px',
              borderRadius: 4,
              border: 'none',
              background: '#475569',
              color: '#e2e8f0',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

// ── Inline title editor ─────────────────────────────────────────

function TitleEditor({
  value,
  onSave,
  onCancel,
}: {
  value: string;
  onSave: (v: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const trimmed = text.trim();
        if (trimmed && trimmed !== value) onSave(trimmed);
        else onCancel();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          const trimmed = text.trim();
          if (trimmed && trimmed !== value) onSave(trimmed);
          else onCancel();
        } else if (e.key === 'Escape') {
          onCancel();
        }
      }}
      style={{
        ...cellInput,
        flex: 1,
        fontWeight: 500,
        paddingLeft: 4,
      }}
    />
  );
}

// ── Inline "new phase" editor ───────────────────────────────────
//
// Rendered when "+ New phase…" is picked in the phase dropdown. Typing a
// label and committing assigns it to the node; the server appends unknown
// labels to the map's ordered phases list automatically (the store
// mirrors that append locally so the dropdown updates immediately).

function PhaseEditor({
  onSave,
  onCancel,
}: {
  onSave: (v: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed) onSave(trimmed);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      value={text}
      placeholder="New phase…"
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') onCancel();
      }}
      style={{ ...cellInput, fontSize: 11 }}
    />
  );
}

// ── Inline number editor ────────────────────────────────────────

function NumberEditor({
  value,
  min,
  max,
  onSave,
  onCancel,
}: {
  value: number | null;
  min?: number;
  max?: number;
  onSave: (v: number | null) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(value?.toString() ?? '');
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === '') {
      onSave(null);
    } else {
      const num = parseFloat(trimmed);
      if (!isNaN(num)) onSave(num);
      else onCancel();
    }
  };

  return (
    <input
      ref={ref}
      type="number"
      value={text}
      min={min}
      max={max}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') onCancel();
      }}
      style={{
        ...cellInput,
        width: '100%',
        textAlign: 'right',
      }}
    />
  );
}

// ── Filter dropdown component ───────────────────────────────────

function FilterDropdown({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  selected: Set<string>;
  onToggle: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as HTMLElement)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const hasSelection = selected.size > 0;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 11,
          fontWeight: 500,
          color: hasSelection ? '#4338ca' : '#64748b',
          padding: '4px 8px',
          borderRadius: 6,
          border: hasSelection ? '1px solid #c7d2fe' : '1px solid #e2e8f0',
          background: hasSelection ? '#eef2ff' : '#fff',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {label}
        {hasSelection && (
          <span style={{ fontSize: 10, background: '#4f46e5', color: '#fff', borderRadius: 8, padding: '0 5px', fontWeight: 700 }}>
            {selected.size}
          </span>
        )}
        <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" style={{ marginLeft: 2 }}>
          <path d="M1 2.5L4 6l3-3.5H1z" />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            background: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: 8,
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
            padding: '4px 0',
            zIndex: 50,
            minWidth: 140,
          }}
        >
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onToggle(opt.value)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 10px',
                border: 'none',
                background: selected.has(opt.value) ? '#eef2ff' : 'transparent',
                cursor: 'pointer',
                fontSize: 11,
                color: '#1e293b',
                fontFamily: 'inherit',
                textAlign: 'left',
              }}
            >
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  border: selected.has(opt.value) ? '2px solid #4f46e5' : '2px solid #cbd5e1',
                  background: selected.has(opt.value) ? '#4f46e5' : '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {selected.has(opt.value) && (
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="#fff">
                    <path d="M1.5 4L3 5.5L6.5 2" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              {opt.label}
            </button>
          ))}
          {hasSelection && (
            <>
              <div style={{ height: 1, background: '#e2e8f0', margin: '4px 0' }} />
              <button
                onClick={() => {
                  for (const v of selected) onToggle(v);
                  setOpen(false);
                }}
                style={{
                  width: '100%',
                  padding: '5px 10px',
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  fontSize: 11,
                  color: '#dc2626',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                }}
              >
                Clear all
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
