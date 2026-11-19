// @vitest-environment jsdom
/** Note to the agent (claude-fleet#92): the box shows only while a fleet claim is held, posts a fleet-note, shows sent / picked up. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  canEdit: true,
  mapId: 'm1' as string | null,
  fetchComments: vi.fn(),
  createComment: vi.fn(),
}));

vi.mock('../useCanEditMap.js', () => ({ useCanEditMap: () => mocks.canEdit }));
vi.mock('../store.js', () => ({ useMindmapStore: (sel: (s: { currentMapId: string | null }) => unknown) => sel({ currentMapId: mocks.mapId }) }));
vi.mock('../api.js', () => ({ fetchComments: mocks.fetchComments, createComment: mocks.createComment }));

import { NoteToAgentButton, NoteToAgentSection, noteTime } from '../NoteToAgent.js';
import type { CardPhase } from '../useTicketPhases.js';

const working: CardPhase = { text: 'Agent working · 3m', tone: 'active', prNumber: null, agentRunning: true };
const prOpen: CardPhase = { text: 'Waiting for CI', tone: 'waiting', prNumber: 12, agentRunning: false };

const note = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  nodeId: 'n1',
  userId: 'u1',
  userName: 'Dan',
  text: 'Use v2',
  kind: 'fleet-note',
  deliveredAt: null,
  createdAt: '2026-11-19T10:02:00.000Z',
  updatedAt: '2026-11-19T10:02:00.000Z',
  ...over,
});

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.canEdit = true;
  mocks.mapId = 'm1';
  mocks.fetchComments.mockResolvedValue([]);
});

describe('NoteToAgentSection', () => {
  it('is not shown without a fleet claim', () => {
    render(<NoteToAgentSection mapId="m1" nodeId="n1" phase={undefined} />);
    expect(screen.queryByTestId('note-to-agent')).toBeNull();
    expect(mocks.fetchComments).not.toHaveBeenCalled();
  });

  it('is not shown to a viewer without edit', () => {
    mocks.canEdit = false;
    render(<NoteToAgentSection mapId="m1" nodeId="n1" phase={working} />);
    expect(screen.queryByTestId('note-to-agent')).toBeNull();
  });

  it('is shown on an open PR before the merge too', async () => {
    render(<NoteToAgentSection mapId="m1" nodeId="n1" phase={prOpen} />);
    expect(screen.getByTestId('note-to-agent')).toBeTruthy();
    await waitFor(() => expect(mocks.fetchComments).toHaveBeenCalledWith('m1', 'n1', 'fleet-note'));
  });

  it('posts a fleet-note, shows it as sent, then picked up when the worker acknowledges', async () => {
    mocks.createComment.mockResolvedValue(note());
    render(<NoteToAgentSection mapId="m1" nodeId="n1" phase={working} />);
    fireEvent.change(screen.getByTestId('note-to-agent-text'), { target: { value: '  Use v2  ' } });
    fireEvent.click(screen.getByTestId('note-to-agent-send'));
    await waitFor(() => expect(screen.getByTestId('note-to-agent-status').textContent).toBe(`sent ${noteTime('2026-11-19T10:02:00.000Z')}`));
    expect(mocks.createComment).toHaveBeenCalledWith('m1', 'n1', 'Use v2', 'fleet-note');

    // The worker's PATCH arrives as comment:updated over the socket — without the author name.
    act(() => {
      window.dispatchEvent(
        new CustomEvent('ws:comment', {
          detail: { type: 'comment:updated', nodeId: 'n1', comment: { ...note({ deliveredAt: '2026-11-19T10:03:00.000Z' }), userName: undefined } },
        }),
      );
    });
    expect(screen.getByTestId('note-to-agent-status').textContent).toBe(`picked up at ${noteTime('2026-11-19T10:03:00.000Z')}`);
    expect(screen.getByTestId('note-to-agent-item').textContent).toContain('Dan');
  });
});

describe('NoteToAgentButton (Kanban card)', () => {
  it('only while a fleet claim is held, and for an editor', () => {
    const { rerender } = render(<NoteToAgentButton nodeId="n1" phase={null} />);
    expect(screen.queryByTestId('note-to-agent-card')).toBeNull();
    rerender(<NoteToAgentButton nodeId="n1" phase={working} />);
    expect(screen.getByTestId('note-to-agent-card')).toBeTruthy();
    mocks.canEdit = false;
    rerender(<NoteToAgentButton nodeId="n1" phase={prOpen} />);
    expect(screen.queryByTestId('note-to-agent-card')).toBeNull();
  });

  it('asks for the text and posts a fleet-note', async () => {
    mocks.createComment.mockResolvedValue(note());
    vi.spyOn(window, 'prompt').mockReturnValue(' Use v2 ');
    render(<NoteToAgentButton nodeId="n1" phase={working} />);
    fireEvent.click(screen.getByTestId('note-to-agent-card'));
    await waitFor(() => expect(screen.getByTestId('note-to-agent-card').textContent).toBe('Note sent'));
    expect(mocks.createComment).toHaveBeenCalledWith('m1', 'n1', 'Use v2', 'fleet-note');
  });
});
