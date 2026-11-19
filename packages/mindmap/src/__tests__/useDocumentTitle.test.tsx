// @vitest-environment jsdom
/** Browser tab title: `MB: <map name>` while a map is open, `MindBlown` otherwise. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useMindmapStore } from '../store.js';
import type { MindMap } from '@mindblown/core';
import { useDocumentTitle, useMapDocumentTitle } from '../useDocumentTitle.js';

function Shell() {
  useMapDocumentTitle();
  return null;
}

function MobileShell({ name }: { name: string | null }) {
  useDocumentTitle(name);
  return null;
}

const map = (id: string, name: string) => ({ id, name }) as unknown as MindMap;

describe('useMapDocumentTitle', () => {
  beforeEach(() => {
    document.title = 'MindBlown';
    useMindmapStore.setState({ currentMapId: null, currentMap: null });
  });
  afterEach(cleanup);

  it('shows the open map, follows rename and switch, and falls back when the map is left', () => {
    render(<Shell />);
    expect(document.title).toBe('MindBlown');

    act(() => useMindmapStore.setState({ currentMapId: 'm1', currentMap: map('m1', 'Roadmap') }));
    expect(document.title).toBe('MB: Roadmap');

    act(() => useMindmapStore.setState({ currentMap: map('m1', 'Roadmap 2027') }));
    expect(document.title).toBe('MB: Roadmap 2027');

    act(() => useMindmapStore.setState({ currentMapId: 'm2', currentMap: map('m2', 'Hiring') }));
    expect(document.title).toBe('MB: Hiring');

    act(() => useMindmapStore.setState({ currentMapId: null, currentMap: null }));
    expect(document.title).toBe('MindBlown');
  });

  it('restores the default title on unmount', () => {
    useMindmapStore.setState({ currentMapId: 'm1', currentMap: map('m1', 'Roadmap') });
    const { unmount } = render(<Shell />);
    expect(document.title).toBe('MB: Roadmap');
    unmount();
    expect(document.title).toBe('MindBlown');
  });
});

describe('useDocumentTitle (mobile)', () => {
  afterEach(cleanup);

  it('names the picked map and returns to MindBlown on the map list', () => {
    const { rerender } = render(<MobileShell name="Roadmap" />);
    expect(document.title).toBe('MB: Roadmap');
    rerender(<MobileShell name={null} />);
    expect(document.title).toBe('MindBlown');
  });
});
