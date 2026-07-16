import { useMemo } from 'react';
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
      if (n.status === null) {
        unstatused.push(n);
      } else {
        if (!byStatus.has(n.status)) byStatus.set(n.status, []);
        byStatus.get(n.status)!.push(n);
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
            {col.nodes.map((n) => {
              const pct = Math.round(n.computedProgress ?? 0);
              return (
                <button
                  key={n.id}
                  className="mb-kanban-card"
                  onClick={() => onSelect(n.id)}
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
                    {n.assigneeIds.length > 0 && (
                      <span>· {n.assigneeIds.length}👤</span>
                    )}
                    {n.blockedReason && <span style={{ color: '#dc2626' }}>· blocked</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
