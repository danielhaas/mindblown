import { useMemo } from 'react';
import { useMindmapStore } from './store.js';

export function Breadcrumb() {
  const focusNodeId = useMindmapStore((s) => s.focusNodeId);
  const getFocusBreadcrumb = useMindmapStore((s) => s.getFocusBreadcrumb);
  const setFocusNode = useMindmapStore((s) => s.setFocusNode);
  const nodes = useMindmapStore((s) => s.nodes);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);

  const crumbs = useMemo(
    () => getFocusBreadcrumb(),
    [getFocusBreadcrumb, focusNodeId, nodes, rootNodeId],
  );

  // Don't show if we're at root (no drill-down active)
  if (!focusNodeId || crumbs.length <= 1) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '4px 16px',
        background: '#f8fafc',
        borderBottom: '1px solid #e2e8f0',
        fontSize: 12,
        minHeight: 28,
        overflow: 'hidden',
      }}
    >
      {/* Home icon — go to root */}
      <button
        onClick={() => setFocusNode(null)}
        title="Back to root"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '2px 4px',
          borderRadius: 4,
          display: 'flex',
          alignItems: 'center',
          color: '#64748b',
          transition: 'background 0.15s, color 0.15s',
          flexShrink: 0,
        }}
        onMouseOver={(e) => {
          e.currentTarget.style.background = '#e2e8f0';
          e.currentTarget.style.color = '#1e293b';
        }}
        onMouseOut={(e) => {
          e.currentTarget.style.background = 'none';
          e.currentTarget.style.color = '#64748b';
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1.5l-6 5V14h4v-4h4v4h4V6.5l-6-5z" />
        </svg>
      </button>

      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={crumb.id} style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
            {/* Separator */}
            {i > 0 && (
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                style={{ flexShrink: 0, color: '#cbd5e1' }}
              >
                <path
                  d="M4.5 2.5L7.5 6L4.5 9.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}

            {isLast ? (
              <span
                style={{
                  fontWeight: 600,
                  color: '#1e293b',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {crumb.text}
              </span>
            ) : (
              <button
                onClick={() => {
                  // Navigate to this crumb; if it's the root node, go to null
                  const target = crumb.id === rootNodeId ? null : crumb.id;
                  setFocusNode(target);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '1px 4px',
                  borderRadius: 3,
                  fontSize: 12,
                  fontWeight: 500,
                  color: '#4f46e5',
                  fontFamily: 'inherit',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: 160,
                  transition: 'background 0.15s',
                }}
                onMouseOver={(e) => (e.currentTarget.style.background = '#eef2ff')}
                onMouseOut={(e) => (e.currentTarget.style.background = 'none')}
                title={crumb.text}
              >
                {crumb.text}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
