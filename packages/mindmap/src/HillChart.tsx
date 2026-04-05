import { useCallback, useRef, useState } from 'react';
import { useMindmapStore } from './store.js';
import type { Node, ComputedNodeValues } from '@mindblown/core';

// ── Hill curve math ─────────────────────────────────────────────

const CHART_W = 800;
const CHART_H = 300;
const PADDING_X = 60;
const PADDING_Y = 40;
const CURVE_Y_TOP = PADDING_Y;
const CURVE_Y_BOTTOM = CHART_H - PADDING_Y;

/**
 * The hill curve: a sine-based arch.
 * position 0 = far left (bottom), 50 = top, 100 = far right (bottom).
 */
function hillY(position: number): number {
  const t = position / 100; // 0..1
  const normalizedY = Math.sin(t * Math.PI); // 0 -> 1 -> 0
  return CURVE_Y_BOTTOM - normalizedY * (CURVE_Y_BOTTOM - CURVE_Y_TOP);
}

function hillX(position: number): number {
  const t = position / 100;
  return PADDING_X + t * (CHART_W - 2 * PADDING_X);
}

/** Build the SVG path for the hill curve */
function buildHillPath(): string {
  const points: string[] = [];
  for (let p = 0; p <= 100; p += 1) {
    const x = hillX(p);
    const y = hillY(p);
    points.push(`${p === 0 ? 'M' : 'L'}${x},${y}`);
  }
  return points.join(' ');
}

// ── Health -> color mapping ──────────────────────────────────────

const HEALTH_COLORS: Record<string, string> = {
  on_track: '#22c55e',
  at_risk: '#f59e0b',
  behind: '#ef4444',
};

// ── Dot size based on effort ─────────────────────────────────────

function dotRadius(effort: number, maxEffort: number): number {
  if (maxEffort === 0) return 12;
  const min = 8;
  const max = 24;
  const ratio = effort / maxEffort;
  return min + ratio * (max - min);
}

// ── Component ────────────────────────────────────────────────────

interface BranchDot {
  node: Node;
  computed: ComputedNodeValues;
  hillPosition: number; // 0-100
}

export function HillChart() {
  const nodes = useMindmapStore((s) => s.nodes);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);
  const computed = useMindmapStore((s) => s.computed);
  const updateNode = useMindmapStore((s) => s.updateNode);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);

  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  // Get top-level branches (direct children of root)
  const branches: BranchDot[] = [];
  if (rootNodeId && nodes[rootNodeId]) {
    const root = nodes[rootNodeId];
    let maxEffort = 0;

    // First pass: collect and find max effort
    const rawBranches: { node: Node; computed: ComputedNodeValues; hillPosition: number }[] = [];
    for (const childId of root.childrenIds) {
      const child = nodes[childId];
      const comp = computed.get(childId);
      if (!child || !comp) continue;

      const hp = (child.customFields?.hillPosition as number) ?? 0;
      rawBranches.push({ node: child, computed: comp, hillPosition: hp });
      if (comp.computedEffort > maxEffort) maxEffort = comp.computedEffort;
    }

    for (const b of rawBranches) {
      branches.push(b);
    }
  }

  const maxEffort = branches.length > 0 ? Math.max(...branches.map((b) => b.computed.computedEffort)) : 0;

  // Convert SVG client coordinates to hill position (0-100)
  const clientToHillPosition = useCallback(
    (clientX: number): number => {
      if (!svgRef.current) return 0;
      const rect = svgRef.current.getBoundingClientRect();
      const svgX = ((clientX - rect.left) / rect.width) * CHART_W;
      const t = (svgX - PADDING_X) / (CHART_W - 2 * PADDING_X);
      return Math.max(0, Math.min(100, Math.round(t * 100)));
    },
    [],
  );

  // Drag handlers
  const handlePointerDown = useCallback(
    (nodeId: string, e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragging(nodeId);
      (e.target as Element).setPointerCapture(e.pointerId);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      const pos = clientToHillPosition(e.clientX);
      // Optimistic update of the custom field
      const node = nodes[dragging];
      if (node) {
        updateNode(dragging, {
          customFields: { ...node.customFields, hillPosition: pos },
        });
      }
    },
    [dragging, clientToHillPosition, nodes, updateNode],
  );

  const handlePointerUp = useCallback(() => {
    setDragging(null);
  }, []);

  const hillPath = buildHillPath();

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: '#f8fafc',
        overflow: 'auto',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '16px 24px 8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1e293b' }}>Hill Chart</h2>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#94a3b8' }}>
            Drag dots along the hill. Left = figuring it out, Right = making it happen.
          </p>
        </div>
        {/* Legend */}
        <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#64748b' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
            On Track
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />
            At Risk
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
            Behind
          </span>
        </div>
      </div>

      {/* Chart */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          style={{
            width: '100%',
            maxWidth: 900,
            height: 'auto',
            maxHeight: '100%',
            userSelect: 'none',
          }}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          {/* Background */}
          <rect x="0" y="0" width={CHART_W} height={CHART_H} fill="#f8fafc" rx="8" />

          {/* Grid lines */}
          {[0.25, 0.5, 0.75].map((t) => (
            <line
              key={t}
              x1={PADDING_X + t * (CHART_W - 2 * PADDING_X)}
              y1={PADDING_Y - 10}
              x2={PADDING_X + t * (CHART_W - 2 * PADDING_X)}
              y2={CURVE_Y_BOTTOM + 10}
              stroke="#e2e8f0"
              strokeWidth="1"
              strokeDasharray="4,4"
            />
          ))}

          {/* Center divider (top of hill) */}
          <line
            x1={hillX(50)}
            y1={PADDING_Y - 10}
            x2={hillX(50)}
            y2={CURVE_Y_BOTTOM + 10}
            stroke="#cbd5e1"
            strokeWidth="1.5"
            strokeDasharray="6,4"
          />

          {/* Phase labels */}
          <text
            x={hillX(25)}
            y={CURVE_Y_BOTTOM + 30}
            textAnchor="middle"
            fill="#94a3b8"
            fontSize="12"
            fontWeight="600"
          >
            Figuring it out
          </text>
          <text
            x={hillX(75)}
            y={CURVE_Y_BOTTOM + 30}
            textAnchor="middle"
            fill="#94a3b8"
            fontSize="12"
            fontWeight="600"
          >
            Making it happen
          </text>

          {/* Hill curve */}
          <path d={hillPath} fill="none" stroke="#cbd5e1" strokeWidth="2.5" strokeLinecap="round" />

          {/* Shaded area under curve */}
          <path
            d={`${hillPath} L${hillX(100)},${CURVE_Y_BOTTOM} L${hillX(0)},${CURVE_Y_BOTTOM} Z`}
            fill="#f1f5f9"
            opacity="0.6"
          />

          {/* Dots */}
          {branches.map((branch) => {
            const cx = hillX(branch.hillPosition);
            const cy = hillY(branch.hillPosition);
            const r = dotRadius(branch.computed.computedEffort, maxEffort);
            const color = HEALTH_COLORS[branch.computed.healthSignal] ?? '#94a3b8';
            const isSelected = branch.node.id === selectedNodeId;
            const isDragging = branch.node.id === dragging;
            const isHovered = branch.node.id === hovered;

            return (
              <g key={branch.node.id}>
                {/* Drop shadow */}
                {(isHovered || isDragging) && (
                  <circle cx={cx} cy={cy} r={r + 4} fill={color} opacity="0.2" />
                )}

                {/* Selection ring */}
                {isSelected && (
                  <circle
                    cx={cx}
                    cy={cy}
                    r={r + 3}
                    fill="none"
                    stroke="#4f46e5"
                    strokeWidth="2"
                    strokeDasharray="4,2"
                  />
                )}

                {/* Main dot */}
                <circle
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill={color}
                  stroke="#fff"
                  strokeWidth="2"
                  style={{ cursor: 'grab', transition: isDragging ? 'none' : 'cx 0.15s, cy 0.15s' }}
                  onPointerDown={(e) => handlePointerDown(branch.node.id, e)}
                  onPointerEnter={() => setHovered(branch.node.id)}
                  onPointerLeave={() => setHovered(null)}
                  onClick={() => selectNode(branch.node.id)}
                />

                {/* Progress text inside dot */}
                <text
                  x={cx}
                  y={cy + 1}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="#fff"
                  fontSize={Math.max(8, r * 0.7)}
                  fontWeight="700"
                  style={{ pointerEvents: 'none' }}
                >
                  {Math.round(branch.computed.computedProgress)}%
                </text>

                {/* Label */}
                <text
                  x={cx}
                  y={cy - r - 8}
                  textAnchor="middle"
                  fill="#334155"
                  fontSize="11"
                  fontWeight="600"
                  style={{ pointerEvents: 'none' }}
                >
                  {branch.node.text.length > 20
                    ? branch.node.text.slice(0, 18) + '...'
                    : branch.node.text}
                </text>

                {/* Effort label below */}
                <text
                  x={cx}
                  y={cy + r + 14}
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize="9"
                  style={{ pointerEvents: 'none' }}
                >
                  {branch.computed.computedEffort}d
                </text>
              </g>
            );
          })}

          {/* Empty state */}
          {branches.length === 0 && (
            <text
              x={CHART_W / 2}
              y={CHART_H / 2}
              textAnchor="middle"
              fill="#94a3b8"
              fontSize="14"
            >
              No top-level branches to display. Add children to the root node.
            </text>
          )}
        </svg>
      </div>
    </div>
  );
}
