// @vitest-environment jsdom
/**
 * The "+N" pill (children hidden by the depth limit) and the "+" circle
 * (branch folded by hand) open what they hide on click — and the click
 * doesn't also select or start a drag on the node underneath.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MindmapNode } from '../MindmapNode.js';
import type { LayoutNode } from '../layout.js';
import { PLAIN } from './needsYouFixtures.js';

afterEach(cleanup);

function renderNode(opts: { collapsed: boolean; hasHiddenChildren: boolean; hiddenDescendantCount: number }) {
  const layout: LayoutNode = {
    id: PLAIN.id, x: 0, y: 0, width: 160, height: 40, parentId: null,
    depth: 1, hasChildren: true, collapsed: opts.collapsed,
  };
  const h = {
    onShowHidden: vi.fn(),
    onExpand: vi.fn(),
    onSelect: vi.fn(),
    onDoubleClick: vi.fn(),
    onDragStart: vi.fn(),
  };
  render(
    <svg>
      <MindmapNode
        layout={layout}
        node={{ ...PLAIN, collapsed: opts.collapsed }}
        isSelected={false}
        isEditing={false}
        hasHiddenChildren={opts.hasHiddenChildren}
        hiddenDescendantCount={opts.hiddenDescendantCount}
        onTextChange={() => {}}
        onEditCancel={() => {}}
        {...h}
      />
    </svg>,
  );
  return h;
}

/** A real click as a mouse delivers it: down, up, click. */
function click(el: Element) {
  fireEvent.mouseDown(el, { button: 0 });
  fireEvent.mouseUp(el, { button: 0 });
  fireEvent.click(el, { button: 0 });
}

describe('MindmapNode expand affordances', () => {
  it('"+N" pill: clicking the pill or its label shows the hidden nodes, without selecting', () => {
    const h = renderNode({ collapsed: false, hasHiddenChildren: true, hiddenDescendantCount: 12 });
    const pill = screen.getByTestId('node-show-hidden');
    expect(pill.querySelector('title')?.textContent).toBe('Show 12 hidden nodes');

    for (const target of [pill.querySelector('rect')!, pill.querySelector('text')!, pill.querySelector('polygon')!]) {
      click(target);
    }
    expect(h.onShowHidden).toHaveBeenCalledTimes(3);
    expect(h.onSelect).not.toHaveBeenCalled();
    expect(h.onDragStart).not.toHaveBeenCalled();
    expect(screen.queryByTestId('node-expand')).toBeNull();
  });

  it('"+" circle: clicking the circle or the "+" unfolds the branch, without selecting', () => {
    const h = renderNode({ collapsed: true, hasHiddenChildren: false, hiddenDescendantCount: 0 });
    const btn = screen.getByTestId('node-expand');
    expect(btn.querySelector('title')?.textContent).toBe('Expand');

    click(btn.querySelector('circle')!);
    click(btn.querySelector('text')!);
    expect(h.onExpand).toHaveBeenCalledTimes(2);
    expect(h.onSelect).not.toHaveBeenCalled();
    expect(h.onDragStart).not.toHaveBeenCalled();
    expect(screen.queryByTestId('node-show-hidden')).toBeNull();
  });

  it('a click on the node body still selects it', () => {
    const h = renderNode({ collapsed: false, hasHiddenChildren: true, hiddenDescendantCount: 3 });
    const body = screen.getByTestId('node-show-hidden').parentElement!.querySelector(':scope > rect')!;
    click(body);
    expect(h.onSelect).toHaveBeenCalledTimes(1);
    expect(h.onShowHidden).not.toHaveBeenCalled();
  });
});
