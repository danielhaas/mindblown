import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMindmapStore } from './store.js';
import { computeLayout, computeBounds } from './layout.js';
import { MindmapNode } from './MindmapNode.js';
import { Connector } from './Connector.js';
import { DependencyLines } from './DependencyLines.js';
import type { LayoutNode } from './layout.js';

// ── Pan & Zoom state ───────────────────────────────────────────

interface ViewState {
  panX: number;
  panY: number;
  zoom: number;
}

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;
const DRAG_THRESHOLD = 5; // px of movement before drag starts

// ── Drag state ────────────────────────────────────────────────

interface DragState {
  nodeId: string;
  startClientX: number;
  startClientY: number;
  currentClientX: number;
  currentClientY: number;
  isDragging: boolean; // true once threshold exceeded
  originX: number; // original layout x
  originY: number; // original layout y
}

interface DropTarget {
  type: 'parent' | 'between';
  parentId: string;
  index: number;
}

// ── Helper: check if nodeId is ancestor of potentialDescendantId ─

function isAncestor(
  nodeId: string,
  potentialDescendantId: string,
  nodes: Record<string, { parentId: string | null; childrenIds: string[] }>,
): boolean {
  const queue = [nodeId];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const node = nodes[current];
    if (!node) continue;
    for (const childId of node.childrenIds) {
      if (childId === potentialDescendantId) return true;
      queue.push(childId);
    }
  }
  return false;
}

export function MindmapEditor() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<ViewState>({ panX: 0, panY: 0, zoom: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const nodes = useMindmapStore((s) => s.nodes);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);
  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);
  const editingNodeId = useMindmapStore((s) => s.editingNodeId);
  const computed = useMindmapStore((s) => s.computed);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const startEditing = useMindmapStore((s) => s.startEditing);
  const addNode = useMindmapStore((s) => s.addNode);
  const updateNode = useMindmapStore((s) => s.updateNode);
  const deleteNode = useMindmapStore((s) => s.deleteNode);
  const toggleCollapse = useMindmapStore((s) => s.toggleCollapse);
  const moveNode = useMindmapStore((s) => s.moveNode);

  // ── Drag-and-drop state ───────────────────────────────────────

  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [invalidDrop, setInvalidDrop] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  // ── Layout computation ─────────────────────────────────────

  const layoutNodes = useMemo(() => rootNodeId ? computeLayout(rootNodeId, nodes) : [], [rootNodeId, nodes]);

  const layoutMap = useMemo(() => {
    const map = new Map<string, LayoutNode>();
    for (const ln of layoutNodes) {
      map.set(ln.id, ln);
    }
    return map;
  }, [layoutNodes]);

  // ── Fit to view on first render ────────────────────────────

  const hasInitialized = useRef<string | null>(null);
  useEffect(() => {
    if (hasInitialized.current === rootNodeId || layoutNodes.length === 0) return;
    hasInitialized.current = rootNodeId;

    const svg = svgRef.current;
    if (!svg) return;

    const bounds = computeBounds(layoutNodes);
    const svgRect = svg.getBoundingClientRect();
    const padding = 80;

    const scaleX = (svgRect.width - padding * 2) / (bounds.width + padding);
    const scaleY = (svgRect.height - padding * 2) / (bounds.height + padding);
    const zoom = Math.min(1, Math.min(scaleX, scaleY));

    const centerX = bounds.minX + bounds.width / 2;
    const centerY = bounds.minY + bounds.height / 2;

    setView({
      zoom,
      panX: svgRect.width / 2 - centerX * zoom,
      panY: svgRect.height / 2 - centerY * zoom,
    });
  }, [layoutNodes]);

  // ── Convert client coords to SVG coords ───────────────────

  const clientToSvg = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      return {
        x: (clientX - rect.left - view.panX) / view.zoom,
        y: (clientY - rect.top - view.panY) / view.zoom,
      };
    },
    [view.panX, view.panY, view.zoom],
  );

  // ── Find drop target based on cursor position ─────────────

  const findDropTarget = useCallback(
    (svgX: number, svgY: number, dragNodeId: string): { target: DropTarget | null; invalid: boolean } => {
      // Check each layout node to see if cursor is over it
      for (const ln of layoutNodes) {
        if (ln.id === dragNodeId) continue;

        const inX = svgX >= ln.x && svgX <= ln.x + ln.width;
        const inY = svgY >= ln.y && svgY <= ln.y + ln.height;

        if (inX && inY) {
          // Check if dropping onto own descendant (invalid)
          if (isAncestor(dragNodeId, ln.id, nodes)) {
            return { target: { type: 'parent', parentId: ln.id, index: 0 }, invalid: true };
          }

          // Determine if dropping between siblings (top/bottom half) or as child
          const node = nodes[ln.id];
          if (!node) continue;

          // If cursor is in the top 25% or bottom 25%, treat as "between siblings"
          const relY = svgY - ln.y;
          const fraction = relY / ln.height;

          if (node.parentId && fraction < 0.25) {
            // Insert before this sibling
            const parent = nodes[node.parentId];
            if (parent) {
              const idx = parent.childrenIds.indexOf(ln.id);
              return { target: { type: 'between', parentId: node.parentId, index: Math.max(0, idx) }, invalid: false };
            }
          } else if (node.parentId && fraction > 0.75) {
            // Insert after this sibling
            const parent = nodes[node.parentId];
            if (parent) {
              const idx = parent.childrenIds.indexOf(ln.id);
              return { target: { type: 'between', parentId: node.parentId, index: idx + 1 }, invalid: false };
            }
          } else {
            // Drop as child of this node
            return {
              target: { type: 'parent', parentId: ln.id, index: node.childrenIds.length },
              invalid: false,
            };
          }
        }
      }

      return { target: null, invalid: false };
    },
    [layoutNodes, nodes],
  );

  // ── Drag initiation from node ──────────────────────────────

  const handleNodeDragStart = useCallback(
    (nodeId: string, startX: number, startY: number) => {
      // Don't allow dragging the root
      if (nodeId === rootNodeId) return;
      const ln = layoutMap.get(nodeId);
      if (!ln) return;

      setDrag({
        nodeId,
        startClientX: startX,
        startClientY: startY,
        currentClientX: startX,
        currentClientY: startY,
        isDragging: false,
        originX: ln.x,
        originY: ln.y,
      });
    },
    [rootNodeId, layoutMap],
  );

  // ── Pan handling ───────────────────────────────────────────

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only pan on background click or middle-mouse
      if (e.button === 1 || (e.button === 0 && e.target === svgRef.current)) {
        e.preventDefault();
        setIsPanning(true);
        panStart.current = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY };
      }
    },
    [view.panX, view.panY],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Handle drag-and-drop
      if (drag) {
        const dx = e.clientX - drag.startClientX;
        const dy = e.clientY - drag.startClientY;

        if (!drag.isDragging) {
          // Check threshold
          if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
            setDrag({ ...drag, isDragging: true, currentClientX: e.clientX, currentClientY: e.clientY });
          }
          return;
        }

        setDrag({ ...drag, currentClientX: e.clientX, currentClientY: e.clientY });

        // Find drop target
        const svgPos = clientToSvg(e.clientX, e.clientY);
        const { target, invalid } = findDropTarget(svgPos.x, svgPos.y, drag.nodeId);
        setDropTarget(target);
        setInvalidDrop(invalid);
        return;
      }

      // Handle panning
      if (!isPanning || !panStart.current) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      setView((v) => ({
        ...v,
        panX: panStart.current!.panX + dx,
        panY: panStart.current!.panY + dy,
      }));
    },
    [isPanning, drag, clientToSvg, findDropTarget],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      // Handle drop
      if (drag?.isDragging) {
        if (dropTarget && !invalidDrop) {
          const dragNode = nodes[drag.nodeId];
          if (dragNode?.parentId) {
            // Adjust index if moving within the same parent
            let adjustedIndex = dropTarget.index;
            if (dropTarget.parentId === dragNode.parentId) {
              const currentIdx = nodes[dragNode.parentId].childrenIds.indexOf(drag.nodeId);
              if (currentIdx < adjustedIndex) {
                adjustedIndex = Math.max(0, adjustedIndex - 1);
              }
            }
            moveNode(drag.nodeId, dropTarget.parentId, adjustedIndex);
          }
        } else if (!dropTarget && !invalidDrop) {
          // Freeform placement — update node x/y
          const svgPos = clientToSvg(e.clientX, e.clientY);
          const ln = layoutMap.get(drag.nodeId);
          if (ln) {
            updateNode(drag.nodeId, {
              x: svgPos.x - ln.width / 2,
              y: svgPos.y - ln.height / 2,
            });
          }
        }

        setDrag(null);
        setDropTarget(null);
        setInvalidDrop(false);
        return;
      }

      setDrag(null);
      setIsPanning(false);
      panStart.current = null;
    },
    [drag, dropTarget, invalidDrop, nodes, moveNode, updateNode, clientToSvg, layoutMap],
  );

  // ── Zoom handling (native listener to avoid passive event issue) ──

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const zoomFactor = e.deltaY > 0 ? 0.92 : 1.08;

      setView((v) => {
        const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * zoomFactor));
        const scale = newZoom / v.zoom;
        return {
          zoom: newZoom,
          panX: mouseX - (mouseX - v.panX) * scale,
          panY: mouseY - (mouseY - v.panY) * scale,
        };
      });
    };

    svg.addEventListener('wheel', handleWheel, { passive: false });
    return () => svg.removeEventListener('wheel', handleWheel);
  }, []);

  // ── Click on background → deselect ─────────────────────────

  const handleBackgroundClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === svgRef.current && !drag?.isDragging) {
        selectNode(null);
      }
    },
    [selectNode, drag],
  );

  // ── Keyboard shortcuts ─────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when editing text
      if (editingNodeId) {
        if (e.key === 'Escape') {
          startEditing(null);
          e.preventDefault();
        }
        return;
      }

      if (!selectedNodeId) return;

      switch (e.key) {
        case 'Tab': {
          e.preventDefault();
          addNode(selectedNodeId);
          break;
        }
        case 'Enter': {
          e.preventDefault();
          addNode(selectedNodeId, 'New node', true);
          break;
        }
        case 'Delete':
        case 'Backspace': {
          e.preventDefault();
          deleteNode(selectedNodeId);
          break;
        }
        case ' ': {
          e.preventDefault();
          toggleCollapse(selectedNodeId);
          break;
        }
        case 'F2': {
          e.preventDefault();
          startEditing(selectedNodeId);
          break;
        }
        case 'Escape': {
          selectNode(null);
          break;
        }
        case 'ArrowLeft': {
          e.preventDefault();
          const selNode = nodes[selectedNodeId];
          if (selNode?.parentId) selectNode(selNode.parentId);
          break;
        }
        case 'ArrowRight': {
          e.preventDefault();
          const selNodeR = nodes[selectedNodeId];
          if (selNodeR && selNodeR.childrenIds.length > 0 && !selNodeR.collapsed) {
            selectNode(selNodeR.childrenIds[0]);
          }
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const selNodeU = nodes[selectedNodeId];
          if (selNodeU?.parentId) {
            const par = nodes[selNodeU.parentId];
            if (par) {
              const idx = par.childrenIds.indexOf(selectedNodeId);
              if (idx > 0) selectNode(par.childrenIds[idx - 1]);
            }
          }
          break;
        }
        case 'ArrowDown': {
          e.preventDefault();
          const selNodeD = nodes[selectedNodeId];
          if (selNodeD?.parentId) {
            const par = nodes[selNodeD.parentId];
            if (par) {
              const idx = par.childrenIds.indexOf(selectedNodeId);
              if (idx < par.childrenIds.length - 1) selectNode(par.childrenIds[idx + 1]);
            }
          }
          break;
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedNodeId, editingNodeId, nodes, addNode, deleteNode, toggleCollapse, selectNode, startEditing]);

  // ── Build connector edges ──────────────────────────────────

  const connectors = useMemo(() => {
    const edges: Array<{
      parentLayout: LayoutNode;
      childLayout: LayoutNode;
    }> = [];

    for (const ln of layoutNodes) {
      if (ln.parentId) {
        const parentLayout = layoutMap.get(ln.parentId);
        if (parentLayout) {
          edges.push({ parentLayout, childLayout: ln });
        }
      }
    }

    return edges;
  }, [layoutNodes, layoutMap]);

  // ── Compute drag ghost position ────────────────────────────

  const dragGhost = useMemo(() => {
    if (!drag?.isDragging) return null;
    const ln = layoutMap.get(drag.nodeId);
    if (!ln) return null;

    const svgPos = clientToSvg(drag.currentClientX, drag.currentClientY);
    return {
      x: svgPos.x - ln.width / 2,
      y: svgPos.y - ln.height / 2,
      width: ln.width,
      height: ln.height,
      text: nodes[drag.nodeId]?.text ?? '',
    };
  }, [drag, layoutMap, clientToSvg, nodes]);

  // ── Compute drop indicator position ────────────────────────

  const dropIndicator = useMemo(() => {
    if (!dropTarget || !drag?.isDragging || invalidDrop) return null;

    if (dropTarget.type === 'between') {
      const parentLn = layoutMap.get(dropTarget.parentId);
      if (!parentLn) return null;
      const parentNode = nodes[dropTarget.parentId];
      if (!parentNode) return null;

      const children = parentNode.childrenIds.filter((cid) => cid !== drag.nodeId);
      let indicatorY: number;

      if (children.length === 0 || dropTarget.index === 0) {
        const firstChild = children[0] ? layoutMap.get(children[0]) : null;
        indicatorY = firstChild ? firstChild.y - 7 : parentLn.y + parentLn.height / 2;
      } else if (dropTarget.index >= children.length) {
        const lastChild = layoutMap.get(children[children.length - 1]);
        indicatorY = lastChild ? lastChild.y + lastChild.height + 7 : parentLn.y + parentLn.height / 2;
      } else {
        const above = layoutMap.get(children[dropTarget.index - 1]);
        const below = layoutMap.get(children[dropTarget.index]);
        if (above && below) {
          indicatorY = (above.y + above.height + below.y) / 2;
        } else {
          indicatorY = parentLn.y + parentLn.height / 2;
        }
      }

      const childX = parentLn.x + parentLn.width + 60;
      return { x: childX, y: indicatorY, width: 160 };
    }

    return null;
  }, [dropTarget, drag, invalidDrop, layoutMap, nodes]);

  // ── Render ─────────────────────────────────────────────────

  const cursorStyle = drag?.isDragging
    ? 'grabbing'
    : isPanning
      ? 'grabbing'
      : 'default';

  return (
    <svg
      ref={svgRef}
      style={{
        width: '100%',
        height: '100%',
        cursor: cursorStyle,
        outline: 'none',
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={handleBackgroundClick}
      tabIndex={0}
    >
      {/* Definitions for drop shadows and filters */}
      <defs>
        <filter id="node-shadow" x="-8%" y="-8%" width="116%" height="130%">
          <feDropShadow dx="0" dy="1" stdDeviation="3" floodColor="#000" floodOpacity="0.08" />
        </filter>
        <filter id="node-shadow-selected" x="-8%" y="-8%" width="116%" height="130%">
          <feDropShadow dx="0" dy="2" stdDeviation="5" floodColor="#4f46e5" floodOpacity="0.2" />
        </filter>
        <filter id="drag-target-glow" x="-15%" y="-15%" width="130%" height="130%">
          <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#3b82f6" floodOpacity="0.35" />
        </filter>
      </defs>

      <g transform={`translate(${view.panX}, ${view.panY}) scale(${view.zoom})`}>
        {/* Connectors (render behind nodes) */}
        {connectors.map(({ parentLayout, childLayout }) => (
          <Connector
            key={`${parentLayout.id}-${childLayout.id}`}
            parent={parentLayout}
            child={childLayout}
          />
        ))}

        {/* Dependency lines (above connectors, below nodes) */}
        <DependencyLines
          layoutMap={layoutMap}
          nodes={nodes}
          svgRef={svgRef}
          viewState={view}
        />

        {/* Drop indicator line */}
        {dropIndicator && (
          <g>
            <line
              x1={dropIndicator.x}
              y1={dropIndicator.y}
              x2={dropIndicator.x + dropIndicator.width}
              y2={dropIndicator.y}
              stroke="#3b82f6"
              strokeWidth={2.5}
              strokeLinecap="round"
            />
            <circle cx={dropIndicator.x} cy={dropIndicator.y} r={4} fill="#3b82f6" />
            <circle cx={dropIndicator.x + dropIndicator.width} cy={dropIndicator.y} r={4} fill="#3b82f6" />
          </g>
        )}

        {/* Nodes */}
        {layoutNodes.map((ln) => {
          const isBeingDragged = drag?.isDragging && drag.nodeId === ln.id;
          const isTargetNode = dropTarget && !invalidDrop && dropTarget.type === 'parent' && dropTarget.parentId === ln.id;
          const isInvalidTarget = dropTarget && invalidDrop && dropTarget.parentId === ln.id;

          return (
            <MindmapNode
              key={ln.id}
              layout={ln}
              node={nodes[ln.id]}
              computedValues={computed.get(ln.id)}
              isSelected={ln.id === selectedNodeId}
              isEditing={ln.id === editingNodeId}
              isDragging={isBeingDragged ?? false}
              isDragTarget={isTargetNode ?? false}
              isDragInvalid={isInvalidTarget ?? false}
              onSelect={() => selectNode(ln.id)}
              onDoubleClick={() => startEditing(ln.id)}
              onTextChange={(text) => {
                updateNode(ln.id, { text });
                startEditing(null);
              }}
              onEditCancel={() => startEditing(null)}
              onDragStart={handleNodeDragStart}
            />
          );
        })}

        {/* Drag ghost */}
        {dragGhost && (
          <g style={{ pointerEvents: 'none' }}>
            <rect
              x={dragGhost.x}
              y={dragGhost.y}
              width={dragGhost.width}
              height={dragGhost.height}
              rx={8}
              ry={8}
              fill="#ffffff"
              stroke="#4f46e5"
              strokeWidth={2}
              strokeDasharray="4 3"
              opacity={0.75}
            />
            <text
              x={dragGhost.x + dragGhost.width / 2}
              y={dragGhost.y + dragGhost.height / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={13}
              fontWeight={500}
              fill="#4f46e5"
              opacity={0.8}
              style={{ userSelect: 'none' }}
            >
              {dragGhost.text.length > 28 ? dragGhost.text.slice(0, 26) + '...' : dragGhost.text}
            </text>
          </g>
        )}
      </g>
    </svg>
  );
}
