import { CommentsPanel } from './CommentsPanel.js';

/**
 * Map-wide chat surface. Piggybacks on the existing per-node Comments
 * system by scoping it to the root node — root-level comments become
 * the conversation everyone on the map sees. No new schema, no new
 * WebSocket events; the realtime broadcast that already drives node
 * comments updates this panel too.
 */
export function MapChatPanel({
  mapId,
  rootNodeId,
  onClose,
  onMinimise,
}: {
  mapId: string;
  rootNodeId: string;
  onClose: () => void;
  onMinimise?: () => void;
}) {
  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Map chat</span>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {onMinimise && (
            <button
              onClick={onMinimise}
              style={minimiseBtnStyle}
              aria-label="Minimise"
              title="Minimise"
            >
              −
            </button>
          )}
          <button onClick={onClose} style={closeBtnStyle} aria-label="Close" title="Close">
            &times;
          </button>
        </div>
      </div>
      <div style={bodyStyle}>
        <CommentsPanel
          mapId={mapId}
          nodeId={rootNodeId}
          maxHeight="100%"
          hideHeader
        />
      </div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  right: 0,
  top: 0,
  bottom: 0,
  width: 380,
  background: '#fff',
  borderLeft: '1px solid #e2e8f0',
  display: 'flex',
  flexDirection: 'column',
  zIndex: 1500,
  boxShadow: '-4px 0 16px rgba(0,0,0,0.08)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '12px 16px',
  borderBottom: '1px solid #e2e8f0',
  background: '#f8fafc',
};

const closeBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  fontSize: 20,
  color: '#94a3b8',
  cursor: 'pointer',
  padding: '0 4px',
  lineHeight: 1,
};

const minimiseBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  fontSize: 20,
  color: '#94a3b8',
  cursor: 'pointer',
  padding: '0 6px',
  lineHeight: 1,
};

const bodyStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  padding: '12px 16px',
  minHeight: 0,
};
