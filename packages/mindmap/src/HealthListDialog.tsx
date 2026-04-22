import { useEffect, useMemo } from 'react';
import type { HealthSignal, Node } from '@mindblown/core';
import { useMindmapStore } from './store.js';

const HEALTH_LABEL: Record<HealthSignal, { text: string; bg: string; fg: string }> = {
  on_track: { text: 'On Track', bg: '#dcfce7', fg: '#166534' },
  at_risk: { text: 'At Risk', bg: '#fef3c7', fg: '#92400e' },
  behind: { text: 'Behind', bg: '#fee2e2', fg: '#991b1b' },
};

interface Row {
  node: Node;
  breadcrumb: string;
  progress: number;
  effort: number;
  dueDate: string | null;
}

export function HealthListDialog({
  health,
  onClose,
}: {
  health: HealthSignal;
  onClose: () => void;
}) {
  const nodes = useMindmapStore((s) => s.nodes);
  const computed = useMindmapStore((s) => s.computed);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const setFocusNode = useMindmapStore((s) => s.setFocusNode);
  const getNodeBreadcrumb = useMindmapStore((s) => s.getNodeBreadcrumb);

  const label = HEALTH_LABEL[health];

  // Show leaf nodes in the requested health state — these are the
  // actionable items. Parent nodes inherit their health from leaves
  // so listing them too would be redundant.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const node of Object.values(nodes)) {
      if (node.childrenIds.length > 0) continue;
      const c = computed.get(node.id);
      if (!c || c.healthSignal !== health) continue;
      out.push({
        node,
        breadcrumb: getNodeBreadcrumb(node.id),
        progress: c.computedProgress,
        effort: c.computedEffort,
        dueDate: node.dueDate ?? null,
      });
    }
    out.sort((a, b) => {
      // Overdue first (earliest due date wins), then no-due-date last
      const aDue = a.dueDate ? Date.parse(a.dueDate) : Infinity;
      const bDue = b.dueDate ? Date.parse(b.dueDate) : Infinity;
      if (aDue !== bDue) return aDue - bDue;
      return a.node.text.localeCompare(b.node.text);
    });
    return out;
  }, [nodes, computed, health, getNodeBreadcrumb]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSelect = (id: string) => {
    setFocusNode(null);
    selectNode(id);
    onClose();
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: 560,
          maxWidth: '90vw',
          maxHeight: '80vh',
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '20px 24px 14px',
            borderBottom: '1px solid #f1f5f9',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1e293b' }}>
              {label.text}
            </h2>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 4,
                background: label.bg,
                color: label.fg,
              }}
            >
              {rows.length}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 18,
              color: '#94a3b8',
              fontFamily: 'inherit',
              padding: '0 4px',
            }}
          >
            x
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {rows.length === 0 ? (
            <div style={{ padding: '32px 24px', textAlign: 'center', color: '#64748b', fontSize: 13 }}>
              No leaf tasks are {label.text.toLowerCase()}.
            </div>
          ) : (
            rows.map((row) => (
              <button
                key={row.node.id}
                onClick={() => handleSelect(row.node.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  width: '100%',
                  padding: '10px 24px',
                  border: 'none',
                  borderBottom: '1px solid #f1f5f9',
                  background: 'transparent',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#f8fafc'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  {row.breadcrumb && (
                    <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.breadcrumb}
                    </div>
                  )}
                  <div style={{ fontSize: 13, color: '#1e293b', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.node.text || '(untitled)'}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: '#64748b', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
                  {row.dueDate && (
                    <span style={{ color: isOverdue(row.dueDate) ? '#991b1b' : '#64748b' }}>
                      due {formatDate(row.dueDate)}
                    </span>
                  )}
                  <span>{Math.round(row.progress)}% · {row.effort}d</span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function isOverdue(dueDate: string): boolean {
  return Date.parse(dueDate) < Date.now();
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
