// @vitest-environment jsdom
/**
 * The detail view's "Needs you" section (#610), one test per state, plus
 * the phone sheet's Unblock. The API module is mocked; the components are
 * the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MindMap, Node } from '@mindblown/core';

vi.mock('../api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api.js')>();
  return {
    ...real,
    fetchAsks: vi.fn(),
    answerAsk: vi.fn(),
    fetchApprovals: vi.fn(),
    approveTicket: vi.fn(),
    rejectTicket: vi.fn(),
    fetchNode: vi.fn(),
    unblockNode: vi.fn(),
    updateNode: vi.fn(),
    fetchFleet: vi.fn(() => new Promise(() => {})),
    fetchMapMembers: vi.fn(async () => ({ members: [] })),
  };
});

import * as api from '../api.js';
import { NeedsYouSection } from '../NeedsYouSection.js';
import { MobileNodeDetailSheet } from '../mobile/MobileNodeDetailSheet.js';
import { useMindmapStore } from '../store.js';
import { ALL_NODES, APPROVE, ASK, BLOCKED, BRIEF, HELD, MAP_ID, PENDING, PLAIN, QUESTION, WORKFLOW } from './needsYouFixtures.js';

const m = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  m.fetchAsks.mockResolvedValue({ items: [ASK], counts: {} as never, pushedAt: ASK.pushedAt, meta: null, now: ASK.pushedAt });
  m.fetchApprovals.mockResolvedValue({ items: [PENDING], now: PENDING.createdAt });
  useMindmapStore.setState({ viewRole: 'all' as never, user: { id: 'u1', name: 'Daniel Haas', email: 'd@x' } as never });
});
afterEach(cleanup);

function section(node: Node, extra: Partial<Parameters<typeof NeedsYouSection>[0]> = {}) {
  const props = {
    mapId: MAP_ID,
    node,
    nodes: ALL_NODES,
    workflow: WORKFLOW,
    onUnblock: vi.fn(async () => true),
    onSaveBrief: vi.fn(async () => true),
    onOpenNode: vi.fn(),
    onOpenFleet: vi.fn(),
    ...extra,
  };
  render(<NeedsYouSection {...props} />);
  return props;
}

describe('NeedsYouSection', () => {
  it('waiting for approval: Approve / Edit & approve / Reject with reporter, trust and Read twice; Approve sends the row revision', async () => {
    m.approveTicket.mockResolvedValue({ approval: null, writes: [], ok: true });
    const onRefresh = vi.fn();
    section(APPROVE, { onRefresh });
    await screen.findByTestId('approve');
    expect(screen.getByText('Edit & approve')).toBeTruthy();
    expect(screen.getByText('Reject')).toBeTruthy();
    expect(screen.getByText(/from github:octo · outside/)).toBeTruthy();
    expect(screen.getByTestId('approval-hints').textContent).toContain('Read twice: asks for credentials');
    // The stamp's own merge choice is pre-ticked.
    expect((screen.getByLabelText('Stop at PR') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByTestId('approve'));
    await screen.findByTestId('needs-you-decided');
    expect(m.approveTicket).toHaveBeenCalledWith(MAP_ID, 'approve', { merge: 'pr-only', description: undefined, expectedRevision: 3 });
    expect(onRefresh).toHaveBeenCalled();
    expect(screen.queryByTestId('approve')).toBeNull();
  });

  it('reject sends the note and close-issue', async () => {
    m.rejectTicket.mockResolvedValue({ approval: null, writes: [], ok: true });
    section(APPROVE);
    fireEvent.click(await screen.findByText('Reject'));
    fireEvent.change(screen.getByLabelText('Reject note'), { target: { value: 'Out of scope' } });
    fireEvent.click(screen.getByLabelText(/Close the issue/));
    fireEvent.click(screen.getByTestId('confirm-reject'));
    await screen.findByTestId('needs-you-decided');
    expect(m.rejectTicket).toHaveBeenCalledWith(MAP_ID, 'approve', { note: 'Out of scope', closeIssue: true });
  });

  it('a person who may not decide sees the row read-only', async () => {
    m.fetchApprovals.mockResolvedValue({ items: [{ ...PENDING, canApprove: false }], now: '' });
    section(APPROVE);
    await screen.findByText(/Only people on the map's trusted list can decide/);
    expect(screen.queryByTestId('approve')).toBeNull();
  });

  it('open question: the question and an answer box, answered through answer_ask', async () => {
    m.answerAsk.mockResolvedValue({ ask: { ...ASK, status: 'answered', answeredBy: 'Dan', writes: [] }, plan: {} as never, ok: true, node: null });
    section(QUESTION);
    await screen.findByText(/Recharts or visx\?/);
    fireEvent.click(screen.getByRole('button', { name: 'Recharts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(m.answerAsk).toHaveBeenCalled());
    expect(m.answerAsk).toHaveBeenCalledWith(MAP_ID, 'ask-7', expect.objectContaining({ action: 'answered', decision: 'Recharts', by: 'Dan' }));
    // What was written stays where it was clicked, even once the asks refetch drops the row.
    await screen.findByText(/answered \(Dan\)/);
  });

  it('a question about another ticket is not shown here', async () => {
    section(PLAIN);
    await waitFor(() => expect(m.fetchAsks).toHaveBeenCalled());
    expect(screen.queryByTestId('needs-you')).toBeNull();
  });

  it('blocked: the reason and Unblock', async () => {
    const p = section(BLOCKED);
    expect(screen.getByTestId('needs-you-blocked').textContent).toContain('Needs the staging token');
    fireEvent.click(screen.getByTestId('needs-you-unblock'));
    await waitFor(() => expect(p.onUnblock).toHaveBeenCalledTimes(1));
  });

  it('needs a brief: the text is saved as the description', async () => {
    const p = section(BRIEF);
    const save = screen.getByTestId('needs-you-brief-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('needs-you-brief-text'), { target: { value: '  Add a locations table  ' } });
    fireEvent.click(save);
    await waitFor(() => expect(p.onSaveBrief).toHaveBeenCalledWith('Add a locations table'));
  });

  it('any other hold: the reason and where it is resolved', async () => {
    const p = section(HELD);
    expect(screen.getByTestId('needs-you-other').textContent).toContain('Needs a person: tagged needs-human');
    fireEvent.click(screen.getByText(/Resolve it on the Fleet tab/));
    expect(p.onOpenFleet).toHaveBeenCalled();
  });

  it('nothing waiting: no section', async () => {
    m.fetchAsks.mockResolvedValue({ items: [], counts: {} as never, pushedAt: null, meta: null, now: '' });
    section(PLAIN);
    await waitFor(() => expect(m.fetchAsks).toHaveBeenCalled());
    expect(screen.queryByTestId('needs-you')).toBeNull();
  });

  it('stakeholder lens: no Unblock button', () => {
    useMindmapStore.setState({ viewRole: 'stakeholder' as never });
    section(BLOCKED);
    expect(screen.getByTestId('needs-you-blocked')).toBeTruthy();
    expect(screen.queryByTestId('needs-you-unblock')).toBeNull();
  });
});

describe('MobileNodeDetailSheet — Needs you on the phone', () => {
  const map = { id: MAP_ID, name: 'Project', statusWorkflow: WORKFLOW, effortUnit: 'days', fleetId: null } as unknown as MindMap;
  const withComputed = (n: Node) => ({ ...n, computedProgress: 0, computedEffort: 0, healthSignal: 'on_track', actualEffort: null }) as never;

  it('a blocked card is unblocked from the sheet', async () => {
    const unblocked = { ...BLOCKED, blockedReason: null };
    m.unblockNode.mockResolvedValue({ node: unblocked, statusReset: false });
    m.fetchAsks.mockResolvedValue({ items: [], counts: {} as never, pushedAt: null, meta: null, now: '' });
    const onChanged = vi.fn();
    const byId = new Map(ALL_NODES.map((n) => [n.id, withComputed(n)]));
    render(<MobileNodeDetailSheet node={withComputed(BLOCKED)} map={map} byId={byId} onClose={() => {}} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('needs-you-unblock'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(unblocked));
    expect(m.unblockNode).toHaveBeenCalledWith(MAP_ID, 'blocked');
  });

  it('approving re-reads the node, so the card loses its badge', async () => {
    m.approveTicket.mockResolvedValue({ approval: null, writes: [], ok: true });
    const approved = { ...APPROVE, approval: { state: 'approved', merge: 'pr-only', by: 'u1', at: '2026-11-01T00:00:00.000Z' } } as Node;
    m.fetchNode.mockResolvedValue(approved);
    const onChanged = vi.fn();
    const byId = new Map(ALL_NODES.map((n) => [n.id, withComputed(n)]));
    render(<MobileNodeDetailSheet node={withComputed(APPROVE)} map={map} byId={byId} onClose={() => {}} onChanged={onChanged} />);
    fireEvent.click(await screen.findByTestId('approve'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(approved));
  });
});
