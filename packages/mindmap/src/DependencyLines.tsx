import { useCallback, useEffect, useRef, useState } from 'react';
import type { Node, DependencyType } from '@mindblown/core';
import type { LayoutNode } from './layout.js';
import { useMindmapStore } from './store.js';

// ── Types ─────────────────────────────────────────────────────────

interface DependencyLinesProps {
  layoutMap: Map<string, LayoutNode>;
  nodes: Record<string, Node>;
  svgRef: React.RefObject<SVGSVGElement | null>;
  viewState: { panX: number; panY: number; zoom: number };
}

interface DependencyEdge {
  sourceId: string; // the predecessor (targetNodeId in the Dependency)
  dependentId: string; // the node that has the dependency
  type: DependencyType;
  lag: number;
}

// ── Dependency type badge colors ──────────────────────────────────

const DEP_TYPE_COLORS: Record<DependencyType, string> = {
  FS: '#f59e0b',
  SS: '#3b82f6',
  FF: '#8b5cf6',
  SF: '#ef4444',
};

const DEP_LINE_COLOR = '#f59e0b'; // amber

// ── Helper: compute a curved path that avoids the tree connectors ─

function computeDependencyPath(
  source: LayoutNode,
  target: LayoutNode,
): string {
  // Source: right edge center of the predecessor node
  const sx = source.x + source.width;
  const sy = source.y + source.height / 2;

  // Target: left edge center of the dependent node
  const tx = target.x;
  const ty = target.y + target.height / 2;

  // Use a quadratic curve offset vertically to avoid overlapping with tree connectors
  const dx = tx - sx;
  const dy = ty - sy;

  // Offset the curve upward or downward to avoid tree connectors
  // Use a larger vertical offset than the standard tree bezier
  const verticalOffset = Math.sign(dy || 1) * Math.max(40, Math.abs(dy) * 0.3);

  // For dependencies going left-to-right, curve above/below
  if (dx > 0) {
    const cp1x = sx + dx * 0.25;
    const cp1y = sy - verticalOffset;
    const cp2x = sx + dx * 0.75;
    const cp2y = ty - verticalOffset;
    return `M ${sx} ${sy} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${tx} ${ty}`;
  }

  // For backwards dependencies (right-to-left), make a wider arc
  const arcHeight = Math.max(60, Math.abs(dy) * 0.5 + 30);
  const goUp = sy > ty ? 1 : -1;
  const cp1x = sx + 40;
  const cp1y = sy - goUp * arcHeight;
  const cp2x = tx - 40;
  const cp2y = ty - goUp * arcHeight;
  return `M ${sx} ${sy} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${tx} ${ty}`;
}

// ── Context menu component ────────────────────────────────────────

function DependencyContextMenu({
  x,
  y,
  onRemove,
  onClose,
}: {
  x: number;
  y: number;
  onRemove: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as HTMLElement)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <foreignObject x={x - 60} y={y - 16} width={160} height={40}>
      <div
        ref={menuRef}
        style={{
          background: '#ffffff',
          border: '1px solid #e2e8f0',
          borderRadius: 6,
          boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
          padding: '4px 0',
          fontSize: 13,
          fontFamily: 'inherit',
        }}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          style={{
            display: 'block',
            width: '100%',
            padding: '6px 12px',
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            color: '#dc2626',
            fontSize: 13,
          }}
          onMouseEnter={(e) => {
            (e.target as HTMLButtonElement).style.background = '#fef2f2';
          }}
          onMouseLeave={(e) => {
            (e.target as HTMLButtonElement).style.background = 'none';
          }}
        >
          Remove dependency
        </button>
      </div>
    </foreignObject>
  );
}

// ── Dependency mode indicator ─────────────────────────────────────

function DependencyModeIndicator({
  sourceLayout,
}: {
  sourceLayout: LayoutNode;
}) {
  const { x, y, width, height } = sourceLayout;
  return (
    <>
      {/* Pulsing border around the source node */}
      <rect
        x={x - 3}
        y={y - 3}
        width={width + 6}
        height={height + 6}
        rx={11}
        ry={11}
        fill="none"
        stroke={DEP_LINE_COLOR}
        strokeWidth={2.5}
        opacity={0.8}
      >
        <animate
          attributeName="opacity"
          values="0.4;1;0.4"
          dur="1.2s"
          repeatCount="indefinite"
        />
        <animate
          attributeName="stroke-width"
          values="2;3.5;2"
          dur="1.2s"
          repeatCount="indefinite"
        />
      </rect>
      {/* Tooltip */}
      <g transform={`translate(${x + width / 2}, ${y - 18})`}>
        <rect
          x={-55}
          y={-10}
          width={110}
          height={20}
          rx={4}
          fill="#78350f"
          opacity={0.9}
        />
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={11}
          fill="#fef3c7"
          fontWeight={500}
          style={{ pointerEvents: 'none' }}
        >
          Click target node...
        </text>
      </g>
    </>
  );
}

// ── Main DependencyLines component ────────────────────────────────

export function DependencyLines({
  layoutMap,
  nodes,
  svgRef,
  viewState,
}: DependencyLinesProps) {
  const updateNode = useMindmapStore((s) => s.updateNode);

  // Dependency creation mode
  const [depSourceId, setDepSourceId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    dependentId: string;
    targetNodeId: string;
  } | null>(null);

  // Expose dependency mode setter via store-like mechanism
  // We use a ref + window event for cross-component communication
  const depSourceRef = useRef(depSourceId);
  depSourceRef.current = depSourceId;

  // Listen for Alt+click to start dependency mode
  useEffect(() => {
    const startHandler = (e: CustomEvent<{ nodeId: string }>) => {
      if (depSourceRef.current) {
        // Already in dep mode — Alt+click again cancels or re-selects source
        if (depSourceRef.current === e.detail.nodeId) {
          setDepSourceId(null);
        } else {
          setDepSourceId(e.detail.nodeId);
        }
      } else {
        setDepSourceId(e.detail.nodeId);
      }
    };

    window.addEventListener('dependency-mode-start' as any, startHandler as any);
    return () => window.removeEventListener('dependency-mode-start' as any, startHandler as any);
  }, []);

  // Listen for normal clicks to complete dependency (target selection)
  useEffect(() => {
    const targetHandler = (e: CustomEvent<{ nodeId: string }>) => {
      if (!depSourceRef.current) return; // Not in dependency mode, ignore

      const sourceId = depSourceRef.current;
      const targetId = e.detail.nodeId;

      if (sourceId === targetId) {
        // Clicking source node cancels
        setDepSourceId(null);
        return;
      }

      // Add dependency: target node depends on source node
      const targetNode = nodes[targetId];
      if (targetNode) {
        const alreadyExists = targetNode.dependencies.some(
          (d) => d.targetNodeId === sourceId,
        );
        if (!alreadyExists) {
          const newDeps = [
            ...targetNode.dependencies,
            { targetNodeId: sourceId, type: 'FS' as DependencyType, lag: 0 },
          ];
          updateNode(targetId, { dependencies: newDeps });
        }
      }
      setDepSourceId(null);
    };

    window.addEventListener('dependency-mode-target' as any, targetHandler as any);
    return () => window.removeEventListener('dependency-mode-target' as any, targetHandler as any);
  }, [nodes, updateNode]);

  // Escape cancels dependency mode
  useEffect(() => {
    if (!depSourceId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDepSourceId(null);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [depSourceId]);

  // Build dependency edges
  const edges: DependencyEdge[] = [];
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (!node.dependencies || node.dependencies.length === 0) continue;
    for (const dep of node.dependencies) {
      // Only render if both ends are visible in the layout
      if (layoutMap.has(nodeId) && layoutMap.has(dep.targetNodeId)) {
        edges.push({
          sourceId: dep.targetNodeId,
          dependentId: nodeId,
          type: dep.type,
          lag: dep.lag,
        });
      }
    }
  }

  const handleRemoveDependency = useCallback(
    (dependentId: string, targetNodeId: string) => {
      const node = nodes[dependentId];
      if (!node) return;
      const newDeps = node.dependencies.filter(
        (d) => d.targetNodeId !== targetNodeId,
      );
      updateNode(dependentId, { dependencies: newDeps });
      setContextMenu(null);
    },
    [nodes, updateNode],
  );

  const handleContextMenu = useCallback(
    (
      e: React.MouseEvent,
      dependentId: string,
      targetNodeId: string,
    ) => {
      e.preventDefault();
      e.stopPropagation();
      // Convert screen coordinates to SVG coordinates
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const svgX = (e.clientX - rect.left - viewState.panX) / viewState.zoom;
      const svgY = (e.clientY - rect.top - viewState.panY) / viewState.zoom;
      setContextMenu({ x: svgX, y: svgY, dependentId, targetNodeId });
    },
    [svgRef, viewState],
  );

  const sourceLayout = depSourceId ? layoutMap.get(depSourceId) : null;

  return (
    <>
      {/* Arrowhead marker definition */}
      <defs>
        <marker
          id="dep-arrowhead"
          markerWidth="8"
          markerHeight="6"
          refX="7"
          refY="3"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <polygon
            points="0 0, 8 3, 0 6"
            fill={DEP_LINE_COLOR}
            opacity={0.85}
          />
        </marker>
      </defs>

      {/* Dependency lines */}
      {edges.map((edge) => {
        const source = layoutMap.get(edge.sourceId);
        const target = layoutMap.get(edge.dependentId);
        if (!source || !target) return null;

        const path = computeDependencyPath(source, target);

        // Midpoint for label
        const midX =
          (source.x + source.width + target.x) / 2;
        const midY =
          (source.y + source.height / 2 + target.y + target.height / 2) / 2;

        // Offset midpoint to match the curve
        const verticalOffset =
          Math.sign((target.y - source.y) || 1) *
          Math.max(40, Math.abs(target.y - source.y) * 0.3);
        const labelY = midY - verticalOffset * 0.5;

        const typeColor = DEP_TYPE_COLORS[edge.type] || DEP_LINE_COLOR;

        return (
          <g key={`dep-${edge.sourceId}-${edge.dependentId}`}>
            {/* Invisible wider path for easier right-click targeting */}
            <path
              d={path}
              fill="none"
              stroke="transparent"
              strokeWidth={12}
              style={{ cursor: 'context-menu' }}
              onContextMenu={(e) =>
                handleContextMenu(e, edge.dependentId, edge.sourceId)
              }
            />
            {/* Visible dashed line */}
            <path
              d={path}
              fill="none"
              stroke={DEP_LINE_COLOR}
              strokeWidth={1.8}
              strokeDasharray="6 4"
              strokeLinecap="round"
              opacity={0.75}
              markerEnd="url(#dep-arrowhead)"
              style={{ pointerEvents: 'none' }}
            />
            {/* Type label badge at midpoint */}
            <g transform={`translate(${midX}, ${labelY})`}>
              <rect
                x={-14}
                y={-9}
                width={28}
                height={18}
                rx={4}
                fill={typeColor}
                opacity={0.9}
              />
              <text
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={9}
                fontWeight={700}
                fill="#ffffff"
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {edge.type}
              </text>
            </g>
          </g>
        );
      })}

      {/* Dependency mode indicator */}
      {depSourceId && sourceLayout && (
        <DependencyModeIndicator sourceLayout={sourceLayout} />
      )}

      {/* Context menu */}
      {contextMenu && (
        <DependencyContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onRemove={() =>
            handleRemoveDependency(
              contextMenu.dependentId,
              contextMenu.targetNodeId,
            )
          }
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}

