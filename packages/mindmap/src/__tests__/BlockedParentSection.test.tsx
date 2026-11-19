// @vitest-environment jsdom
/** Why a parent is blocked (#651): count, root cause, the full list. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Node } from '@mindblown/core';
import { makeNode } from './needsYouFixtures.js';
import { BlockedParentSection } from '../BlockedParentSection.js';

afterEach(cleanup);

const fs = (id: string) => [{ targetNodeId: id, type: 'FS' as const, lag: 0 }];

describe('BlockedParentSection', () => {
  it('names the external predecessor with its milestone and counts the tasks waiting on it', () => {
    const nodes: Node[] = [
      makeNode('root', { parentId: null, childrenIds: ['m1', 'm2'] }),
      makeNode('m1', { text: 'M1', childrenIds: ['setup', 'deploy'] }),
      makeNode('m2', { text: 'M2', childrenIds: ['vm'] }),
      makeNode('vm', { parentId: 'm2', text: '[External] VM', percentComplete: 0 }),
      makeNode('setup', { parentId: 'm1', text: 'Set-up script', dependencies: fs('vm') }),
      makeNode('deploy', { parentId: 'm1', text: 'Deploy', dependencies: fs('setup') }),
    ];
    const map = new Map(nodes.map((n) => [n.id, n]));
    const onSelect = vi.fn();
    render(<BlockedParentSection parent={map.get('m1')!} nodeMap={map} onSelect={onSelect} />);
    expect(screen.getByTestId('blocked-parent-count').textContent).toBe('2 tasks blocked');
    expect(screen.getByTestId('blocked-parent-causes').textContent).toBe("2 tasks waiting on 'M2 › [External] VM'");
    fireEvent.click(screen.getByText('M2 › [External] VM'));
    expect(onSelect).toHaveBeenCalledWith('vm');
    expect(screen.getByText(/doesn't hold the fleet/)).toBeTruthy();
  });
});
