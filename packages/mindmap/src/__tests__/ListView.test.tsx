// @vitest-environment jsdom
/**
 * List view on a freshly loaded map (#641): the store's maxDepth is 1 after
 * loadMap, but the table shows the whole tree (collapse still applies), and
 * an empty Start/Due cell shows the scheduler's projected date.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { MindMap, Node } from '@mindblown/core';
import { computeTree } from '@mindblown/core';
import { makeNode, MAP_ID } from './needsYouFixtures.js';

vi.mock('../api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api.js')>();
  return { ...real, fetchSchedule: vi.fn() };
});

const api = await import('../api.js');
const { useMindmapStore } = await import('../store.js');
const { ListView } = await import('../ListView.js');
const { scheduleSpans } = await import('../scheduleSpans.js');

afterEach(cleanup);

const ROOT = makeNode('root', { parentId: null, text: 'Loke-Support', childrenIds: ['m1', 'm2'] });
const M1 = makeNode('m1', { text: 'M1 Milestone', childrenIds: ['epic'] });
const EPIC = makeNode('epic', { parentId: 'm1', text: 'Epic', childrenIds: ['task'] });
const TASK = makeNode('task', { parentId: 'epic', text: 'Deep task', startDate: '2026-12-01' });
const M2 = makeNode('m2', { text: 'M2 Milestone', childrenIds: ['hidden'], collapsed: true });
const HIDDEN = makeNode('hidden', { parentId: 'm2', text: 'Under a collapsed milestone' });
const ALL: Node[] = [ROOT, M1, EPIC, TASK, M2, HIDDEN];

beforeEach(() => {
  vi.mocked(api.fetchSchedule).mockResolvedValue({
    schedule: [
      { nodeId: 'task', computedStart: 0, computedEnd: 3, duration: 3 },
      { nodeId: 'm1', computedStart: 0, computedEnd: 3, duration: 3 },
    ],
    projectStartDate: '2026-11-02',
    unitsPerDay: 1,
    workingCalendar: null,
  } as never);
  const nodes = Object.fromEntries(ALL.map((n) => [n.id, n]));
  useMindmapStore.setState({
    currentMapId: MAP_ID,
    currentMap: { id: MAP_ID, name: 'Loke-Support', rootNodeId: 'root', phases: [] } as unknown as MindMap,
    nodes,
    rootNodeId: 'root',
    computed: computeTree(ALL),
    focusNodeId: null,
    maxDepth: 1, // what loadMap sets
  });
});

describe('ListView (#641)', () => {
  it('is not cut at the mindmap depth limit a map loads with', () => {
    render(<ListView />);
    expect(screen.getByText('M1 Milestone')).toBeTruthy();
    expect(screen.getByText('Epic')).toBeTruthy();
    expect(screen.getByText('Deep task')).toBeTruthy();
    // Collapse state still applies.
    expect(screen.queryByText('Under a collapsed milestone')).toBeNull();
  });

  it('shows projected dates where none were entered; manual dates win', async () => {
    render(<ListView />);
    // m1: offsets 0..3 from 2026-11-02 → 2026-11-02 to 2026-11-04 (last day inclusive).
    await waitFor(() => expect(screen.getAllByText('2026-11-04')).toHaveLength(2));
    const projected = screen.getAllByTestId('projected-date').map((e) => e.textContent);
    // m1 start + end, task end only (its start is manual).
    expect(projected.sort()).toEqual(['2026-11-02', '2026-11-04', '2026-11-04']);
    expect(screen.getByText('2026-12-01')).toBeTruthy();
  });
});

describe('scheduleSpans', () => {
  it('walks working days when the map has a working calendar', () => {
    const spans = scheduleSpans({
      // Two working days from Fri 2026-11-06: Fri and Mon, skipping the weekend.
      schedule: [{ nodeId: 'a', computedStart: 0, computedEnd: 2, duration: 2 }],
      projectStartDate: '2026-11-06',
      unitsPerDay: 1,
      workingCalendar: { holidays: [] },
    });
    expect(spans.get('a')).toEqual({ start: '2026-11-06', end: '2026-11-09' });
  });

  it('gives a zero-length bar a single day', () => {
    const spans = scheduleSpans({
      schedule: [{ nodeId: 'a', computedStart: 1, computedEnd: 1, duration: 0 }],
      projectStartDate: '2026-11-02',
      unitsPerDay: 1,
      workingCalendar: null,
    });
    expect(spans.get('a')).toEqual({ start: '2026-11-03', end: '2026-11-03' });
  });
});
