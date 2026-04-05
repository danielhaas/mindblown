import type { LayoutNode } from './layout.js';

interface ConnectorProps {
  parent: LayoutNode;
  child: LayoutNode;
}

/**
 * A smooth cubic bezier connector between a parent and child node.
 * Adapts to different layout orientations automatically.
 */
export function Connector({ parent, child }: ConnectorProps) {
  const parentCx = parent.x + parent.width / 2;
  const parentCy = parent.y + parent.height / 2;
  const childCx = child.x + child.width / 2;
  const childCy = child.y + child.height / 2;

  // Determine orientation based on relative positions
  const isVertical = Math.abs(childCy - parentCy) > Math.abs(childCx - parentCx);

  let startX: number, startY: number, endX: number, endY: number;
  let cp1x: number, cp1y: number, cp2x: number, cp2y: number;

  if (isVertical) {
    // Top-to-bottom or org chart: connect bottom of parent to top of child
    const goingDown = childCy > parentCy;
    startX = parentCx;
    startY = goingDown ? parent.y + parent.height : parent.y;
    endX = childCx;
    endY = goingDown ? child.y : child.y + child.height;

    const dy = (endY - startY) * 0.5;
    cp1x = startX;
    cp1y = startY + dy;
    cp2x = endX;
    cp2y = endY - dy;
  } else {
    // Left-to-right or radial: connect right of parent to left of child
    const goingRight = childCx > parentCx;
    startX = goingRight ? parent.x + parent.width : parent.x;
    startY = parentCy;
    endX = goingRight ? child.x : child.x + child.width;
    endY = childCy;

    const dx = (endX - startX) * 0.5;
    cp1x = startX + dx;
    cp1y = startY;
    cp2x = endX - dx;
    cp2y = endY;
  }

  const d = `M ${startX} ${startY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${endX} ${endY}`;

  return (
    <path
      d={d}
      fill="none"
      stroke="#cbd5e1"
      strokeWidth={1.5}
      strokeLinecap="round"
      opacity={0.7}
    >
      <animate
        attributeName="stroke-dashoffset"
        from="200"
        to="0"
        dur="0.5s"
        fill="freeze"
      />
      <animate
        attributeName="opacity"
        from="0"
        to="0.7"
        dur="0.3s"
        fill="freeze"
      />
    </path>
  );
}
