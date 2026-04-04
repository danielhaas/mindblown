import { useMindmapStore } from './store.js';
import { MindmapEditor } from './MindmapEditor.js';

// ── Health badge colors ────────────────────────────────────────

const HEALTH_LABEL: Record<string, { text: string; bg: string; fg: string }> = {
  on_track: { text: 'On Track', bg: '#dcfce7', fg: '#166534' },
  at_risk: { text: 'At Risk', bg: '#fef3c7', fg: '#92400e' },
  behind: { text: 'Behind', bg: '#fee2e2', fg: '#991b1b' },
};

export function App() {
  const nodes = useMindmapStore((s) => s.nodes);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);
  const computed = useMindmapStore((s) => s.computed);
  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);

  const rootNode = nodes[rootNodeId];
  const rootComputed = computed.get(rootNodeId);
  const progress = rootComputed?.computedProgress ?? 0;
  const effort = rootComputed?.computedEffort ?? 0;
  const health = rootComputed?.healthSignal ?? 'on_track';
  const healthInfo = HEALTH_LABEL[health];

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
          padding: '0 20px',
          borderBottom: '1px solid #e2e8f0',
          background: '#ffffff',
          zIndex: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: '#1e293b',
              letterSpacing: '-0.01em',
            }}
          >
            {rootNode?.text ?? 'MindBlown'}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
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

          {/* Keyboard hint */}
          <span style={{ fontSize: 11, color: '#cbd5e1' }}>
            {selectedNodeId
              ? 'Tab: child | Enter: sibling | Space: collapse | Del: delete'
              : 'Click a node to start'}
          </span>
        </div>
      </div>

      {/* Editor canvas */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <MindmapEditor />
      </div>
    </div>
  );
}
