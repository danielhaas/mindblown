// @vitest-environment jsdom
/**
 * The Approvals page (`/?approvals`), the header count and the Fleet tab's
 * pointer. The API module is mocked; the components are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PendingApproval } from '@mindblown/core';

vi.mock('../api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api.js')>();
  return {
    ...real,
    fetchAllApprovals: vi.fn(),
    fetchApprovals: vi.fn(),
    approveTicket: vi.fn(),
    rejectTicket: vi.fn(),
  };
});

import * as api from '../api.js';
import { ApprovalsBadge, ApprovalsLink, ApprovalsPage, groupApprovals, isApprovalsPage } from '../ApprovalsView.js';
import { useMindmapStore } from '../store.js';
import { PENDING } from './needsYouFixtures.js';

const m = vi.mocked(api);

const row = (nodeId: string, mapId: string, mapName: string, extra: Partial<PendingApproval> = {}): PendingApproval => ({
  ...PENDING,
  nodeId,
  mapId,
  mapName,
  title: `Ticket ${nodeId}`,
  ...extra,
});

const BETA_1 = row('b1', 'mb', 'Beta');
const ALPHA_1 = row('a1', 'ma', 'Alpha');
const ALPHA_2 = row('a2', 'ma', 'Alpha', { canApprove: false });
const list = (items: PendingApproval[]) => ({ items, now: PENDING.createdAt });

beforeEach(() => {
  vi.clearAllMocks();
  m.fetchAllApprovals.mockResolvedValue(list([BETA_1, ALPHA_1, ALPHA_2]));
  useMindmapStore.setState({ currentMapId: null });
});
afterEach(cleanup);

describe('isApprovalsPage / groupApprovals', () => {
  it('reads the ?approvals flag', () => {
    expect(isApprovalsPage('?approvals')).toBe(true);
    expect(isApprovalsPage('?map=x&view=fleet')).toBe(false);
  });

  it('groups by project, projects by name, rows in server order', () => {
    const g = groupApprovals([BETA_1, ALPHA_1, ALPHA_2]);
    expect(g.map((x) => x.mapName)).toEqual(['Alpha', 'Beta']);
    expect(g[0].rows.map((r) => r.nodeId)).toEqual(['a1', 'a2']);
  });
});

describe('ApprovalsPage', () => {
  it('shows every project in its own card; rows the reader may not decide are read-only', async () => {
    render(<ApprovalsPage />);
    const groups = await screen.findAllByTestId('approval-group');
    expect(groups.map((g) => g.getAttribute('data-map-id'))).toEqual(['ma', 'mb']);
    expect(within(groups[0]).getAllByTestId('approve')).toHaveLength(1);
    expect(within(groups[1]).getAllByTestId('approve')).toHaveLength(1);
    expect(screen.getByText(/2 for you to decide/)).toBeTruthy();
    expect(m.fetchAllApprovals).toHaveBeenCalled();
    expect(m.fetchApprovals).not.toHaveBeenCalled();
  });

  it('a decided ticket leaves the list at once, with what was written under its project', async () => {
    m.approveTicket.mockResolvedValue({ approval: null, writes: [], ok: true });
    render(<ApprovalsPage />);
    const beta = (await screen.findAllByTestId('approval-group'))[1];
    // The refetch still carries it (the server is a beat behind): it must not come back.
    fireEvent.click(within(beta).getByTestId('approve'));
    await waitFor(() => expect(within(beta).getByText(/✓ Approved: Ticket b1/)).toBeTruthy());
    expect(m.approveTicket).toHaveBeenCalledWith('mb', 'b1', expect.objectContaining({ expectedRevision: 3 }));
    expect(within(beta).queryByTestId('approve')).toBeNull();
  });

  it('says so when nothing waits', async () => {
    m.fetchAllApprovals.mockResolvedValue(list([]));
    render(<ApprovalsPage />);
    expect(await screen.findByText('Nothing is waiting for approval.')).toBeTruthy();
  });
});

describe('ApprovalsBadge', () => {
  it('counts only the tickets the reader may decide, and links to the page', async () => {
    render(<ApprovalsBadge />);
    const badge = await screen.findByTestId('approvals-badge');
    expect(badge.textContent).toBe('2 to approve');
    expect(badge.getAttribute('href')).toBe('/?approvals');
  });

  it('renders nothing while none wait for this reader', async () => {
    m.fetchAllApprovals.mockResolvedValue(list([ALPHA_2]));
    const { container } = render(<ApprovalsBadge />);
    await waitFor(() => expect(m.fetchAllApprovals).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
});

describe('ApprovalsLink (Fleet tab)', () => {
  it('points to the page with the scope’s count — no decision buttons on the tab', async () => {
    m.fetchApprovals.mockResolvedValue(list([ALPHA_1, ALPHA_2]));
    render(<ApprovalsLink target={{ mapId: 'ma' }} />);
    const link = await screen.findByTestId('approvals-link');
    expect(m.fetchApprovals).toHaveBeenCalledWith({ mapId: 'ma' });
    expect(link.textContent).toContain('2 proposed tickets wait for approval');
    expect(within(link).getByText('Open Approvals →').getAttribute('href')).toBe('/?approvals');
    expect(screen.queryByTestId('approve')).toBeNull();
  });

  it('renders nothing while the scope has none', async () => {
    m.fetchApprovals.mockResolvedValue(list([]));
    const { container } = render(<ApprovalsLink target={{ mapId: 'ma' }} />);
    await waitFor(() => expect(m.fetchApprovals).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
});
