import { useMemo, useState } from 'react';
import { groupDone, cardBlockState, hiddenFromBoard, kanbanColumnId, startedLabel, etaLabel, durationLabels, outsideGate, personHolds, type DoneGroupKey } from '../kanban.js';
import { computeIsBlocked, type NodeMap } from '@mindblown/core';
import type { MindMap, StatusDef } from '@mindblown/core';
import type { NodeWithComputed } from '../api.js';

interface Props {
  nodes: NodeWithComputed[];
  map: MindMap;
  onSelect: (nodeId: string) => void;
}

function priorityColor(p: string | null): string {
  switch (p) {
    case 'P0':
      return '#dc2626';
    case 'P1':
      return '#f97316';
    case 'P2':
      return '#0ea5e9';
    case 'P3':
      return '#94a3b8';
    default:
      return 'transparent';
  }
}

interface Column {
  key: string;
  name: string;
  color: string;
  status: StatusDef | null;
  nodes: NodeWithComputed[];
}

export function MobileKanbanView({ nodes, map, onSelect }: Props) {
  // Done columns: Today / This week / Earlier (collapsed) — see kanban.ts.
  // Per column (a map can have several done-category statuses); "Earlier"
  // starts collapsed.
  const [openGroups, setOpenGroups] = useState<Record<string, Partial<Record<DoneGroupKey, boolean>>>>({});
  const isOpen = (col: string, key: DoneGroupKey): boolean => openGroups[col]?.[key] ?? key !== 'earlier';
  const toggle = (col: string, key: DoneGroupKey) =>
    setOpenGroups((o) => ({ ...o, [col]: { ...o[col], [key]: !isOpen(col, key) } }));
  // Same rule as the Blocked panel: computeIsBlocked over the whole map.
  const nodeMap: NodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])) as NodeMap, [nodes]);
  const holds = useMemo(() => personHolds(nodes, map.statusWorkflow), [nodes, map.statusWorkflow]);
  const later = useMemo(() => outsideGate(nodes, map.dispatchGate ?? [], map.statusWorkflow), [nodes, map.dispatchGate, map.statusWorkflow]);

  const breadcrumbs = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const out = new Map<string, string>();
    for (const n of nodes) {
      const parent = n.parentId ? byId.get(n.parentId) : undefined;
      if (parent && parent.id !== map.rootNodeId) out.set(n.id, parent.text);
    }
    return out;
  }, [nodes, map.rootNodeId]);

  const columns: Column[] = useMemo(() => {
    const workflow = [...map.statusWorkflow].sort((a, b) => a.position - b.position);
    const byStatus = new Map<string, NodeWithComputed[]>();
    const unstatused: NodeWithComputed[] = [];

    for (const n of nodes) {
      if (n.id === map.rootNodeId) continue;
      // Parents are containers, not work items — a card for "Backend"
      // next to its own children only adds noise on a phone screen.
      if (n.childrenIds.length > 0) continue;
      if (hiddenFromBoard(n, workflow)) continue;
      const columnId = kanbanColumnId(n, workflow);
      if (columnId === null) {
        unstatused.push(n);
      } else {
        if (!byStatus.has(columnId)) byStatus.set(columnId, []);
        byStatus.get(columnId)!.push(n);
      }
    }

    const cols: Column[] = workflow.map((s) => ({
      key: s.id,
      name: s.name,
      color: s.color,
      status: s,
      nodes: (byStatus.get(s.id) ?? []).sort(
        (a, b) =>
          (a.priorityRank ?? Number.POSITIVE_INFINITY) -
          (b.priorityRank ?? Number.POSITIVE_INFINITY),
      ),
    }));
    cols.unshift({
      key: '__backlog__',
      name: 'No status',
      color: '#94a3b8',
      status: null,
      nodes: unstatused,
    });
    return cols;
  }, [nodes, map.rootNodeId, map.statusWorkflow]);

  return (
    <div className="mb-kanban-cols">
      {columns.map((col) => (
        <div key={col.key} className="mb-kanban-col">
          <div className="mb-kanban-col-header">
            <span style={{ color: col.color }}>● {col.name}</span>
            <span style={{ color: '#94a3b8', fontWeight: 400 }}>{col.nodes.length}</span>
          </div>
          <div className="mb-kanban-col-body">
            {col.nodes.length === 0 && (
              <div style={{ color: '#94a3b8', fontSize: 12, textAlign: 'center', padding: 14 }}>
                Empty
              </div>
            )}
            {(col.status?.category === 'done'
              ? groupDone(col.nodes, (n) => n.completedAt)
              : [{ key: null, label: '', items: col.nodes }]
            ).map((g) => (
              <div key={g.key ?? 'all'}>
                {g.key && (
                  <button
                    type="button"
                    className="mb-kanban-group"
                    aria-expanded={isOpen(col.key, g.key)}
                    onClick={() => toggle(col.key, g.key!)}
                    style={{
                      width: '100%', display: 'flex', gap: 6, padding: '6px 4px', background: 'none',
                      border: 'none', borderBottom: '1px solid #e2e8f0', fontSize: 11, fontWeight: 600,
                      color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', textAlign: 'left',
                    }}
                  >
                    <span>{isOpen(col.key, g.key) ? '▾' : '▸'}</span>
                    <span style={{ flex: 1 }}>{g.label}</span>
                    <span style={{ color: '#94a3b8' }}>{g.items.length}</span>
                  </button>
                )}
                {(!g.key || isOpen(col.key, g.key)) && g.items.map((n) => {
              const pct = Math.round(n.computedProgress ?? 0);
              const block = cardBlockState(
                n,
                computeIsBlocked(n, nodeMap).blockedBy,
                col.status?.category === 'done',
                (id) => nodeMap.get(id)?.text ?? id,
                holds.get(n.id) ?? null,
                later.get(n.id) ?? null,
              );
              const human = block?.kind === 'human';
              const isLater = block?.kind === 'later' || block?.kind === 'fleet';
              const inProgress = col.status?.category === 'in_progress';
              const started = inProgress ? startedLabel(n.startedAt) : null;
              const eta = inProgress ? etaLabel(n.expectedDoneAt) : null;
              const { took, planned, over } = durationLabels(n);
              return (
                <button
                  key={n.id}
                  className="mb-kanban-card"
                  onClick={() => onSelect(n.id)}
                  style={
                    human
                      ? { background: '#fffbeb', borderLeft: '3px solid #f59e0b' }
                      : isLater
                        ? { background: '#eef2ff', borderLeft: '3px solid #a5b4fc', opacity: 0.85 }
                        : block
                          ? { background: '#e2e8f0', opacity: 0.7 }
                          : undefined
                  }
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        background: priorityColor(n.priority),
                        marginTop: 5,
                        flexShrink: 0,
                      }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, color: '#0f172a' }}>{n.text}</div>
                      {breadcrumbs.has(n.id) && (
                        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                          {breadcrumbs.get(n.id)}
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#64748b' }}>
                    <span>{pct}%</span>
                    {started && <span title={started.full}>· {started.short}</span>}
                    {eta && (
                      <span title={eta.full} style={eta.overdue ? { color: '#dc2626', fontWeight: 600 } : undefined}>
                        · {eta.short}
                      </span>
                    )}
                    {took && <span style={over ? { color: '#dc2626', fontWeight: 600 } : undefined}>· {took}</span>}
                    {planned && <span>· {planned}</span>}
                    {n.assigneeIds.length > 0 && (
                      <span>· {n.assigneeIds.length}👤</span>
                    )}
                    {block && (
                      <span style={{ color: human ? '#92400e' : isLater ? '#3730a3' : '#475569', fontWeight: 600 }}>
                        · {block.detail.length > 64 ? `${block.detail.slice(0, 61)}…` : block.detail}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
