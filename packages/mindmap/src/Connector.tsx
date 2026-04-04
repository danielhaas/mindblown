import type { LayoutNode } from './layout.js';

interface ConnectorProps {
  parent: LayoutNode;
  child: LayoutNode;
}

/**
 * A smooth cubic bezier connector between a parent and child node.
 * Parent's right edge to child's left edge, with a natural curve.
 */
export function Connector({ parent, child }: ConnectorProps) {
  const startX = parent.x + parent.width;
  const startY = parent.y + parent.height / 2;
  const endX = child.x;
  const endY = child.y + child.height / 2;

  // Control points: horizontal offset proportional to the gap
  const dx = (endX - startX) * 0.5;
  const cp1x = startX + dx;
  const cp1y = startY;
  const cp2x = endX - dx;
  const cp2y = endY;

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
