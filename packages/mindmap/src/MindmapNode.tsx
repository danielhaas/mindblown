import { useCallback, useEffect, useRef, useState } from 'react';
import type { Node, ComputedNodeValues } from '@mindblown/core';
import type { LayoutNode } from './layout.js';
import { OctocatIcon } from './icons/Octocat.js';

// ── Color palette ──────────────────────────────────────────────

const DEPTH_COLORS = [
  '#4f46e5', // root — indigo
  '#0891b2', // depth 1 — cyan
  '#059669', // depth 2 — emerald
  '#d97706', // depth 3 — amber
  '#dc2626', // depth 4 — red
  '#7c3aed', // depth 5 — violet
];

const HEALTH_COLORS: Record<string, string> = {
  on_track: '#059669',
  at_risk: '#d97706',
  behind: '#dc2626',
};

const PRIORITY_COLORS: Record<string, string> = {
  P0: '#dc2626',
  P1: '#ea580c',
  P2: '#2563eb',
  P3: '#6b7280',
};

function getNodeColor(depth: number): string {
  return DEPTH_COLORS[Math.min(depth, DEPTH_COLORS.length - 1)];
}

function getNodeBg(depth: number): string {
  if (depth === 0) return '#4f46e5';
  return '#ffffff';
}

function getNodeTextColor(depth: number): string {
  if (depth === 0) return '#ffffff';
  return '#1e293b';
}

// ── Progress Ring ──────────────────────────────────────────────

function ProgressRing({
  progress,
  size = 16,
  stroke = 2.5,
}: {
  progress: number;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - progress / 100);

  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#e2e8f0"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={progress >= 100 ? '#059669' : '#4f46e5'}
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Avatar Circle ──────────────────────────────────────────────

function AvatarCircle({ userId, index, scale = 1 }: { userId: string; index: number; scale?: number }) {
  const colors = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6'];
  const color = colors[index % colors.length];
  const initials = userId.slice(-2).toUpperCase();

  return (
    <g transform={`translate(${index * 14 * scale}, 0)`}>
      <circle cx={8 * scale} cy={8 * scale} r={8 * scale} fill={color} />
      <text
        x={8 * scale}
        y={8 * scale}
        textAnchor="middle"
        dominantBaseline="central"
        fill="white"
        fontSize={7 * scale}
        fontWeight="600"
      >
        {initials}
      </text>
    </g>
  );
}

// ── Claim Badge ────────────────────────────────────────────────

/**
 * Renders a small colored pill showing the claiming session ID.
 * Positioned at the top-right corner of the node rect.
 */
function ClaimBadge({ sessionId, nodeX, nodeY, nodeWidth, nodeHeight, scale = 1 }: {
  sessionId: string;
  nodeX: number;
  nodeY: number;
  nodeWidth: number;
  nodeHeight: number;
  scale?: number;
}) {
  // Truncate to last 8 chars so it stays readable at small sizes
  const label = sessionId.length > 8 ? '…' + sessionId.slice(-8) : sessionId;
  const badgeWidth = (label.length * 6 + 12) * scale;
  const badgeHeight = 13 * scale;
  const badgeX = nodeX + nodeWidth - badgeWidth - 2 * scale;
  // #119: clamp to canvas top — if placing the badge above the node
  // would put it at y<0, flip it under the node instead so it never
  // gets clipped by the SVG viewport.
  const ABOVE_Y = nodeY - 14 * scale;
  const badgeY = ABOVE_Y < 0 ? nodeY + nodeHeight + 1 * scale : ABOVE_Y;

  return (
    <g>
      <title>Claimed by session: {sessionId}</title>
      <rect
        x={badgeX}
        y={badgeY}
        width={badgeWidth}
        height={badgeHeight}
        rx={6 * scale}
        fill="#f59e0b"
        opacity={0.92}
      />
      <text
        x={badgeX + badgeWidth / 2}
        y={badgeY + badgeHeight / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={8 * scale}
        fontWeight={600}
        fill="#fff"
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        {label}
      </text>
    </g>
  );
}

// ── Scope Chips ────────────────────────────────────────────────

/**
 * Renders small grey chips for each scope tag below the node.
 * Chips are placed horizontally, wrapping isn't attempted — only the
 * first N chips that fit within nodeWidth are shown.
 */
function ScopeChips({ scopes, nodeX, nodeY, nodeWidth, nodeHeight, claimedBadgeBelow, scale = 1 }: {
  scopes: string[];
  nodeX: number;
  nodeY: number;
  nodeWidth: number;
  nodeHeight: number;
  /** True when the claim badge was clamped below the node. Chips then
   * stack under the badge (badge first, chips below it) so the stack
   * stays in the same visual order as the default above-node layout. */
  claimedBadgeBelow: boolean;
  scale?: number;
}) {
  if (scopes.length === 0) return null;

  const CHIP_HEIGHT = 12 * scale;
  const CHIP_PAD_X = 5 * scale;
  const CHIP_GAP = 4 * scale;
  const ABOVE_Y = nodeY - 16 * scale - CHIP_HEIGHT;
  // #119: clamp to canvas top — when the default above-node placement
  // would render at y<0, render under the node. If the claim badge
  // also got clamped, leave room for it (badge height ~13 + 2 gap).
  const belowOffset = claimedBadgeBelow ? nodeHeight + (1 + 13 + 2) * scale : nodeHeight + 1 * scale;
  const CHIP_Y = ABOVE_Y < 0 ? nodeY + belowOffset : ABOVE_Y;

  let xCursor = nodeX;
  const chips: Array<{ label: string; x: number; width: number }> = [];

  for (const scope of scopes) {
    const chipWidth = scope.length * 5.5 * scale + CHIP_PAD_X * 2;
    if (xCursor + chipWidth > nodeX + nodeWidth) break; // overflow → stop
    chips.push({ label: scope, x: xCursor, width: chipWidth });
    xCursor += chipWidth + CHIP_GAP;
  }

  if (chips.length === 0) return null;

  return (
    <g>
      {chips.map((chip) => (
        <g key={chip.label}>
          <title>Scope: {chip.label}</title>
          <rect
            x={chip.x}
            y={CHIP_Y}
            width={chip.width}
            height={CHIP_HEIGHT}
            rx={5 * scale}
            fill="#e0e7ff"
            stroke="#a5b4fc"
            strokeWidth={0.5}
          />
          <text
            x={chip.x + chip.width / 2}
            y={CHIP_Y + CHIP_HEIGHT / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={7.5 * scale}
            fontWeight={500}
            fill="#3730a3"
            style={{ pointerEvents: 'none', userSelect: 'none' }}
          >
            {chip.label}
          </text>
        </g>
      ))}
    </g>
  );
}

// ── Main Node Component ────────────────────────────────────────

interface MindmapNodeProps {
  layout: LayoutNode;
  node: Node;
  computedValues?: ComputedNodeValues;
  isSelected: boolean;
  isEditing: boolean;
  isDragTarget?: boolean;
  isDragInvalid?: boolean;
  isDragging?: boolean;
  hasHiddenChildren?: boolean;
  hiddenDescendantCount?: number;
  /**
   * When true, render the GitHub-Inbox marker (octocat) on this node.
   * Set from the editor when `node.id === map.githubInboxNodeId`.
   */
  isGithubInbox?: boolean;
  /**
   * When true, render an orange conflict-warning border.
   * Set by the editor when this todo node's scopes overlap with an
   * in-flight (claimed / in_progress) node's scopes (#111).
   */
  hasConflict?: boolean;
  /**
   * When set, render a small indigo badge on the top-left signalling
   * that the node has more children than is comfortable to read at a
   * glance, and clicking it should offer an AI grouping pass.
   * Editor sets this from `nodeData.childrenIds.length` once it's past
   * the threshold; the click handler opens RefineModal.
   */
  wideFanoutCount?: number;
  /**
   * Multiplier applied to label font sizes (and the inline-edit input).
   * Defaults to 1; the editor wires this from the user's text-size pref so
   * label legibility scales without changing the viewport zoom. Layout
   * already grew node boxes by the same factor (see computeLayout(scale)),
   * so the text fits.
   */
  textScale?: number;
  onRefineClick?: () => void;
  onSelect: (shiftKey: boolean) => void;
  onDoubleClick: () => void;
  onTextChange: (text: string) => void;
  onEditCancel: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onDragStart?: (nodeId: string, startX: number, startY: number) => void;
}

export function MindmapNode({
  layout,
  node,
  computedValues,
  isSelected,
  isEditing,
  isDragTarget = false,
  isDragInvalid = false,
  isDragging = false,
  hasHiddenChildren = false,
  hiddenDescendantCount = 0,
  isGithubInbox = false,
  hasConflict = false,
  wideFanoutCount,
  textScale = 1,
  onRefineClick,
  onSelect,
  onDoubleClick,
  onTextChange,
  onEditCancel,
  onContextMenu,
  onDragStart,
}: MindmapNodeProps) {
  const { x, y, width, height, depth, collapsed, hasChildren } = layout;
  const borderRadius = depth === 0 ? 12 : 8;
  const borderColor = getNodeColor(depth);
  const bgColor = getNodeBg(depth);
  const textColor = getNodeTextColor(depth);

  // Health signal border override
  let healthBorderColor: string | null = null;
  if (computedValues && computedValues.healthSignal !== 'on_track') {
    healthBorderColor = HEALTH_COLORS[computedValues.healthSignal];
  }

  const strokeColor = isDragInvalid
    ? '#dc2626'
    : isDragTarget
      ? '#3b82f6'
      : isSelected
        ? '#4f46e5'
        : hasConflict
          ? '#f59e0b'
          : healthBorderColor || (depth === 0 ? '#4f46e5' : '#e2e8f0');
  const strokeWidth = isDragTarget || isDragInvalid
    ? 2.5
    : isSelected
      ? 2.5
      : hasConflict
        ? 2
        : depth === 0 ? 0 : 1.5;

  // Computed values
  const progress = computedValues?.computedProgress ?? 0;
  const effort = computedValues?.computedEffort ?? 0;
  const showProgress = node.percentComplete != null || (hasChildren && effort > 0);
  const showPriority = node.priority != null;
  const showAssignees = node.assigneeIds.length > 0;
  const githubLink = node.externalLinks.find((l) => l.provider === 'github');

  // ── Inline editing ─────────────────────────────────────────

  const inputRef = useRef<HTMLInputElement>(null);
  const [editText, setEditText] = useState(node.text);

  useEffect(() => {
    if (isEditing) {
      setEditText(node.text);
      // Focus after the foreignObject renders
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isEditing, node.text]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const trimmed = editText.trim();
        if (trimmed) onTextChange(trimmed);
        else onEditCancel();
      } else if (e.key === 'Escape') {
        onEditCancel();
      }
    },
    [editText, onTextChange, onEditCancel],
  );

  const handleBlur = useCallback(() => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== node.text) {
      onTextChange(trimmed);
    } else {
      onEditCancel();
    }
  }, [editText, node.text, onTextChange, onEditCancel]);

  // ── Annotations offset ────────────────────────────────────

  const annotationY = y + height + 4 * textScale;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();

      if (e.button === 0) {
        // Alt+click: enter dependency mode (first click sets source)
        // Any click dispatches dependency-target event so that if we're
        // already in dependency mode, the target selection completes
        if (e.altKey) {
          const event = new CustomEvent('dependency-mode-start', {
            detail: { nodeId: node.id },
          });
          window.dispatchEvent(event);
          return;
        }

        // Dispatch target selection event (DependencyLines ignores if not in dep mode)
        const targetEvent = new CustomEvent('dependency-mode-target', {
          detail: { nodeId: node.id },
        });
        window.dispatchEvent(targetEvent);

        onSelect(e.shiftKey);
        if (onDragStart && !e.shiftKey) {
          onDragStart(node.id, e.clientX, e.clientY);
        }
      }
    },
    [node.id, onSelect, onDragStart],
  );

  const nodeOpacity = isDragging ? 0.4 : 1;

  return (
    <g
      style={{
        cursor: isDragging ? 'grabbing' : 'pointer',
        opacity: nodeOpacity,
      }}
      onMouseDown={handleMouseDown}
      onContextMenu={onContextMenu}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick();
      }}
    >
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={borderRadius}
        ry={borderRadius}
        fill={bgColor}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        filter={isSelected ? 'url(#node-shadow-selected)' : 'url(#node-shadow)'}
      >
        {/* Subtle entrance animation */}
        <animate
          attributeName="opacity"
          from="0"
          to="1"
          dur="0.3s"
          fill="freeze"
        />
      </rect>

      {/* Collapse indicator */}
      {collapsed && !hasHiddenChildren && (
        <g transform={`translate(${x + width - 8 * textScale}, ${y + height / 2})`}>
          <circle r={8 * textScale} fill="#f1f5f9" stroke="#cbd5e1" strokeWidth="1" />
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={11 * textScale}
            fontWeight="700"
            fill="#64748b"
          >
            +
          </text>
        </g>
      )}

      {/* Hidden children badge (depth limit reached) */}
      {hasHiddenChildren && hiddenDescendantCount > 0 && (() => {
        const badgeW = (hiddenDescendantCount >= 100 ? 52 : hiddenDescendantCount >= 10 ? 46 : 40) * textScale;
        const badgeH = 20 * textScale;
        return (
        <g transform={`translate(${x + width + 6 * textScale}, ${y + height / 2 - badgeH / 2})`}>
          <rect
            x={0}
            y={0}
            width={badgeW}
            height={badgeH}
            rx={10 * textScale}
            fill="#eef2ff"
            stroke="#c7d2fe"
            strokeWidth={1}
          />
          <text
            x={badgeW / 2}
            y={badgeH / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={10 * textScale}
            fontWeight={600}
            fill="#4f46e5"
            style={{ pointerEvents: 'none', userSelect: 'none' }}
          >
            +{hiddenDescendantCount}
          </text>
          {/* Small expand arrow hint */}
          <polygon
            points={`${badgeW + 2 * textScale},${7 * textScale} ${badgeW + 7 * textScale},${10 * textScale} ${badgeW + 2 * textScale},${13 * textScale}`}
            fill="#4f46e5"
            opacity={0.5}
          />
        </g>
        );
      })()}

      {/* Strikethrough for done nodes */}
      {progress >= 100 && (
        <line
          x1={x + 12 * textScale}
          y1={y + height / 2}
          x2={x + width - 12 * textScale}
          y2={y + height / 2}
          stroke="#94a3b8"
          strokeWidth={1.5}
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* Priority dot */}
      {showPriority && node.priority && (
        <circle
          cx={x + (showProgress ? 32 : 14) * textScale}
          cy={y + height / 2}
          r={4 * textScale}
          fill={PRIORITY_COLORS[node.priority] || '#6b7280'}
        />
      )}

      {/* GitHub link indicator (top-right corner) */}
      {githubLink && (
        <g
          style={{ cursor: 'pointer' }}
          onClick={(e) => {
            e.stopPropagation();
            window.open(githubLink.url, '_blank', 'noopener,noreferrer');
          }}
        >
          <title>{githubLink.externalId}</title>
          <OctocatIcon
            x={x + width - 14 * textScale}
            y={y + 3 * textScale}
            size={11 * textScale}
            color={githubLink.syncEnabled ? '#1f2937' : '#9ca3af'}
          />
        </g>
      )}

      {/* Wide-fanout warning — small clickable badge on the top-left
          that opens the Refine Structure modal. Only renders when the
          editor explicitly sets wideFanoutCount past the threshold. */}
      {wideFanoutCount != null && wideFanoutCount > 0 && (
        <g
          style={{ cursor: 'pointer' }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRefineClick?.();
          }}
        >
          <title>
            {wideFanoutCount} children — click for grouping suggestions
          </title>
          <circle
            cx={x + 8 * textScale}
            cy={y + 8 * textScale}
            r={7 * textScale}
            fill="#eef2ff"
            stroke="#6366f1"
            strokeWidth={1}
          />
          <text
            x={x + 8 * textScale}
            y={y + 8 * textScale}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={9 * textScale}
            fontWeight={700}
            fill="#4338ca"
            style={{ pointerEvents: 'none', userSelect: 'none' }}
          >
            ⋯
          </text>
        </g>
      )}

      {/* GitHub Inbox marker — surfaces the auto-import landing zone. */}
      {isGithubInbox && !githubLink && (
        <g>
          <title>GitHub Inbox — auto-imported issues land here</title>
          <OctocatIcon
            x={x + width - 14 * textScale}
            y={y + 3 * textScale}
            size={11 * textScale}
            color="#4f46e5"
          />
        </g>
      )}

      {/* Node text or edit input */}
      {isEditing ? (
        <foreignObject
          x={x + 4 * textScale}
          y={y + 2 * textScale}
          width={width - 8 * textScale}
          height={height - 4 * textScale}
        >
          <input
            ref={inputRef}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: `${(depth === 0 ? 16 : 15) * textScale}px`,
              fontWeight: depth === 0 ? '700' : '500',
              color: textColor,
              fontFamily: 'inherit',
              textAlign: 'center',
              padding: '0 4px',
            }}
          />
        </foreignObject>
      ) : (
        <text
          x={x + width / 2}
          y={y + height / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={(depth === 0 ? 16 : 15) * textScale}
          fontWeight={depth === 0 ? 700 : hasChildren ? 600 : 400}
          fill={progress >= 100 ? '#94a3b8' : textColor}
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          {node.text.length > 28 ? node.text.slice(0, 26) + '...' : node.text}
        </text>
      )}

      {/* Assignee avatars (below node) */}
      {showAssignees && (
        <g transform={`translate(${x + 4 * textScale}, ${annotationY})`}>
          {node.assigneeIds.slice(0, 3).map((uid, i) => (
            <AvatarCircle key={uid} userId={uid} index={i} scale={textScale} />
          ))}
        </g>
      )}

      {/* Progress % and remaining effort (below node, right-aligned) */}
      {effort > 0 && (
        <text
          x={x + width - 8 * textScale}
          y={annotationY + 8 * textScale}
          textAnchor="end"
          fontSize={10 * textScale}
          fill={progress >= 100 ? '#059669' : '#64748b'}
          fontWeight={500}
          style={{ pointerEvents: 'none' }}
        >
          {Math.round(progress)}%
          {progress < 100 && (
            <tspan fill="#94a3b8">
              {' · '}{Math.ceil(effort * (1 - progress / 100))}d left
            </tspan>
          )}
        </text>
      )}

      {/* Orchestration substrate (#111) ─────────────────────── */}

      {/* Scope chips — rendered above the node (clamped under when near canvas top) */}
      {node.scopes && node.scopes.length > 0 && (
        <ScopeChips
          scopes={node.scopes}
          nodeX={x}
          nodeY={y}
          nodeWidth={width}
          nodeHeight={height}
          claimedBadgeBelow={!!node.claimedBySession && y - 14 * textScale < 0}
          scale={textScale}
        />
      )}

      {/* Claim badge — amber pill in the top-right corner (clamped under when near canvas top) */}
      {node.claimedBySession && (
        <ClaimBadge
          sessionId={node.claimedBySession}
          nodeX={x}
          nodeY={y}
          nodeWidth={width}
          nodeHeight={height}
          scale={textScale}
        />
      )}
    </g>
  );
}
