import { useCallback, useMemo, useState } from 'react';
import { useMindmapStore } from './store.js';
import type { Node, NodeId, StatusDef, HealthSignal, Priority } from '@mindblown/core';

// ── Constants ────────────────────────────────────────────────────

const WIP_LIMIT = 8;

const PRIORITY_COLORS: Record<Priority, string> = {
  P0: '#dc2626',
  P1: '#f97316',
  P2: '#3b82f6',
  P3: '#9ca3af',
};

const HEALTH_BORDER: Record<HealthSignal, string> = {
  on_track: '#10b981',
  at_risk: '#f59e0b',
  behind: '#ef4444',
};

// ── Types ────────────────────────────────────────────────────────

interface KanbanColumn {
  id: string;
  name: string;
  color: string;
  cards: KanbanCard[];
}

interface KanbanCard {
  node: Node;
  breadcrumb: string;
  healthSignal: HealthSignal;
  computedProgress: number;
}

// ── Helpers ──────────────────────────────────────────────────────

function formatEffort(estimate: number | null, unit: string): string | null {
  if (estimate == null) return null;
  const abbrev = unit === 'hours' ? 'h' : unit === 'days' ? 'd' : 'pts';
  return `${estimate}${abbrev}`;
}

function getInitials(userId: string): string {
  // UserIds are opaque strings; show first 2 chars uppercased as initials
  return userId.slice(0, 2).toUpperCase();
}

function isOverdue(dueDate: string | null): boolean {
  if (!dueDate) return false;
  return new Date(dueDate) < new Date();
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const month = d.toLocaleString('en-US', { month: 'short' });
  return `${month} ${d.getDate()}`;
}

// ── Card Component ───────────────────────────────────────────────

function Card({
  card,
  effortUnit,
  selected,
  onClick,
  onDragStart,
}: {
  card: KanbanCard;
  effortUnit: string;
  selected: boolean;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
}) {
  const { node, breadcrumb, healthSignal, computedProgress } = card;
  const effort = formatEffort(node.effortEstimate, effortUnit);
  const overdue = isOverdue(node.dueDate);
  const borderColor = HEALTH_BORDER[healthSignal];
  const progress = node.percentComplete ?? computedProgress;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      style={{
        background: '#ffffff',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 6,
        cursor: 'grab',
        borderLeft: `3px solid ${borderColor}`,
        boxShadow: selected
          ? '0 0 0 2px #4f46e5, 0 1px 4px rgba(0,0,0,0.08)'
          : '0 1px 3px rgba(0,0,0,0.06)',
        transition: 'box-shadow 0.15s, transform 0.15s',
        userSelect: 'none' as const,
      }}
      onMouseOver={(e) => {
        if (!selected) e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
      }}
      onMouseOut={(e) => {
        if (!selected) e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.06)';
      }}
    >
      {/* Breadcrumb */}
      {breadcrumb && (
        <div
          style={{
            fontSize: 10,
            color: '#94a3b8',
            marginBottom: 4,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {breadcrumb}
        </div>
      )}

      {/* Title row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 6 }}>
        {/* Priority dot */}
        {node.priority && (
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: PRIORITY_COLORS[node.priority],
              flexShrink: 0,
              marginTop: 4,
            }}
            title={node.priority}
          />
        )}
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: '#1e293b',
            lineHeight: '1.3',
            flex: 1,
            wordBreak: 'break-word',
          }}
        >
          {node.text}
        </span>
      </div>

      {/* Progress bar */}
      {progress != null && progress > 0 && (
        <div
          style={{
            width: '100%',
            height: 3,
            borderRadius: 2,
            background: '#e2e8f0',
            overflow: 'hidden',
            marginBottom: 6,
          }}
        >
          <div
            style={{
              width: `${Math.min(100, Math.round(progress))}%`,
              height: '100%',
              borderRadius: 2,
              background: progress >= 100 ? '#059669' : '#4f46e5',
              transition: 'width 0.3s',
            }}
          />
        </div>
      )}

      {/* Meta row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'wrap',
        }}
      >
        {/* Effort badge */}
        {effort && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              background: '#eef2ff',
              color: '#4f46e5',
              padding: '1px 6px',
              borderRadius: 4,
            }}
          >
            {effort}
          </span>
        )}

        {/* Due date */}
        {node.dueDate && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 500,
              color: overdue ? '#dc2626' : '#64748b',
            }}
          >
            {formatDate(node.dueDate)}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Assignee initials */}
        {node.assigneeIds.length > 0 && (
          <div style={{ display: 'flex', gap: 2 }}>
            {node.assigneeIds.slice(0, 3).map((uid) => (
              <div
                key={uid}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: '#e2e8f0',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 9,
                  fontWeight: 700,
                  color: '#475569',
                }}
                title={uid}
              >
                {getInitials(uid)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Column Component ─────────────────────────────────────────────

function Column({
  column,
  effortUnit,
  selectedNodeId,
  swimlanes,
  nodes,
  onSelectNode,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  column: KanbanColumn;
  effortUnit: string;
  selectedNodeId: string | null;
  swimlanes: boolean;
  nodes: Record<string, Node>;
  onSelectNode: (id: string) => void;
  onDragStart: (e: React.DragEvent, nodeId: string) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, columnId: string) => void;
}) {
  const totalEffort = column.cards.reduce((sum, c) => sum + (c.node.effortEstimate ?? 0), 0);
  const overWip = column.cards.length > WIP_LIMIT;

  // Group by parent branch for swimlanes
  const grouped = useMemo(() => {
    if (!swimlanes) return null;
    const groups: Record<string, KanbanCard[]> = {};
    for (const card of column.cards) {
      // Use the first ancestor (direct parent) as the swimlane label
      const parent = card.node.parentId ? nodes[card.node.parentId] : null;
      const lane = parent ? parent.text : 'Root';
      if (!groups[lane]) groups[lane] = [];
      groups[lane].push(card);
    }
    return groups;
  }, [column.cards, swimlanes, nodes]);

  const renderCard = (card: KanbanCard) => (
    <Card
      key={card.node.id}
      card={card}
      effortUnit={effortUnit}
      selected={card.node.id === selectedNodeId}
      onClick={() => onSelectNode(card.node.id)}
      onDragStart={(e) => onDragStart(e, card.node.id)}
    />
  );

  return (
    <div
      style={{
        flex: '1 0 260px',
        maxWidth: 340,
        minWidth: 260,
        display: 'flex',
        flexDirection: 'column',
        background: '#f1f5f9',
        borderRadius: 10,
        overflow: 'hidden',
      }}
      onDragOver={onDragOver}
      onDrop={(e) => onDrop(e, column.id)}
    >
      {/* Column header */}
      <div
        style={{
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderBottom: overWip ? '2px solid #eab308' : '2px solid transparent',
        }}
      >
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: 3,
            background: column.color,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 13, fontWeight: 700, color: '#334155', flex: 1 }}>
          {column.name}
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: overWip ? '#92400e' : '#64748b',
            background: overWip ? '#fef3c7' : '#e2e8f0',
            padding: '1px 7px',
            borderRadius: 10,
          }}
          title={overWip ? `Over WIP limit (${WIP_LIMIT})` : undefined}
        >
          {column.cards.length}
        </span>
        {totalEffort > 0 && (
          <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 500 }}>
            {totalEffort}d
          </span>
        )}
        {overWip && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: '#92400e',
              background: '#fef3c7',
              padding: '1px 5px',
              borderRadius: 4,
            }}
            title={`WIP limit exceeded (${WIP_LIMIT})`}
          >
            WIP
          </span>
        )}
      </div>

      {/* Cards area */}
      <div
        style={{
          flex: 1,
          padding: 8,
          overflowY: 'auto',
          minHeight: 60,
        }}
      >
        {column.cards.length === 0 && (
          <div
            style={{
              padding: '20px 0',
              textAlign: 'center',
              fontSize: 11,
              color: '#94a3b8',
            }}
          >
            No items
          </div>
        )}

        {swimlanes && grouped
          ? Object.entries(grouped).map(([lane, cards]) => (
              <div key={lane} style={{ marginBottom: 8 }}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: '#94a3b8',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    padding: '4px 4px 6px',
                    borderBottom: '1px solid #e2e8f0',
                    marginBottom: 6,
                  }}
                >
                  {lane}
                </div>
                {cards.map(renderCard)}
              </div>
            ))
          : column.cards.map(renderCard)}
      </div>
    </div>
  );
}

// ── KanbanView ───────────────────────────────────────────────────

export function KanbanView() {
  const nodes = useMindmapStore((s) => s.nodes);
  const currentMap = useMindmapStore((s) => s.currentMap);
  const computed = useMindmapStore((s) => s.computed);
  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const updateNode = useMindmapStore((s) => s.updateNode);
  const getLeafNodes = useMindmapStore((s) => s.getLeafNodes);
  const getNodeBreadcrumb = useMindmapStore((s) => s.getNodeBreadcrumb);

  const [swimlanes, setSwimlanes] = useState(false);
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);

  // Build status columns from map's statusWorkflow
  const statusColumns: StatusDef[] = useMemo(() => {
    if (!currentMap?.statusWorkflow || currentMap.statusWorkflow.length === 0) {
      return [
        { id: 'todo', name: 'Todo', category: 'todo', color: '#94a3b8', position: 0 },
        { id: 'in_progress', name: 'In Progress', category: 'in_progress', color: '#3b82f6', position: 1 },
        { id: 'done', name: 'Done', category: 'done', color: '#10b981', position: 2 },
      ];
    }
    return [...currentMap.statusWorkflow].sort((a, b) => a.position - b.position);
  }, [currentMap]);

  const effortUnit = currentMap?.effortUnit ?? 'days';

  // Build columns with cards
  const columns: KanbanColumn[] = useMemo(() => {
    const leafNodes = getLeafNodes();

    // Bucket leaves by status
    const buckets: Record<string, KanbanCard[]> = {};
    const unset: KanbanCard[] = [];

    // Initialize buckets
    for (const s of statusColumns) {
      buckets[s.id] = [];
    }

    for (const node of leafNodes) {
      const cv = computed.get(node.id as NodeId);
      const card: KanbanCard = {
        node,
        breadcrumb: getNodeBreadcrumb(node.id as NodeId),
        healthSignal: cv?.healthSignal ?? 'on_track',
        computedProgress: cv?.computedProgress ?? 0,
      };

      if (!node.status) {
        unset.push(card);
      } else {
        // Match by status name (case-insensitive) or id
        const match = statusColumns.find(
          (s) => s.id === node.status || s.name.toLowerCase() === node.status!.toLowerCase(),
        );
        if (match) {
          buckets[match.id].push(card);
        } else {
          unset.push(card);
        }
      }
    }

    const result: KanbanColumn[] = [];

    // Add "Unset" column first if there are unset cards
    if (unset.length > 0) {
      result.push({
        id: '__unset__',
        name: 'Unset',
        color: '#cbd5e1',
        cards: unset,
      });
    }

    for (const s of statusColumns) {
      result.push({
        id: s.id,
        name: s.name,
        color: s.color,
        cards: buckets[s.id],
      });
    }

    return result;
  }, [statusColumns, getLeafNodes, getNodeBreadcrumb, computed]);

  // Drag and drop handlers
  const handleDragStart = useCallback((e: React.DragEvent, nodeId: string) => {
    setDragNodeId(nodeId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', nodeId);
    // Make the drag image slightly transparent
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.5';
      requestAnimationFrame(() => {
        if (e.currentTarget instanceof HTMLElement) {
          e.currentTarget.style.opacity = '1';
        }
      });
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, columnId: string) => {
      e.preventDefault();
      const nodeId = e.dataTransfer.getData('text/plain');
      if (!nodeId) return;

      setDragNodeId(null);

      // Determine the new status value
      let newStatus: string | null = null;
      if (columnId === '__unset__') {
        newStatus = null;
      } else {
        const col = statusColumns.find((s) => s.id === columnId);
        newStatus = col?.name ?? null;
      }

      // Update the node
      const node = nodes[nodeId];
      if (node && node.status !== newStatus) {
        updateNode(nodeId, { status: newStatus });
      }
    },
    [statusColumns, nodes, updateNode],
  );

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: '#f8fafc',
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          padding: '8px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          borderBottom: '1px solid #e2e8f0',
          background: '#ffffff',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>Kanban Board</span>
        <div style={{ flex: 1 }} />
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            color: '#64748b',
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <input
            type="checkbox"
            checked={swimlanes}
            onChange={(e) => setSwimlanes(e.target.checked)}
            style={{ accentColor: '#4f46e5' }}
          />
          Swimlanes
        </label>
      </div>

      {/* Columns */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          gap: 10,
          padding: 12,
          overflowX: 'auto',
          overflowY: 'hidden',
          alignItems: 'flex-start',
        }}
      >
        {columns.map((col) => (
          <Column
            key={col.id}
            column={col}
            effortUnit={effortUnit}
            selectedNodeId={selectedNodeId}
            swimlanes={swimlanes}
            nodes={nodes}
            onSelectNode={selectNode}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          />
        ))}
      </div>
    </div>
  );
}
