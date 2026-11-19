// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchDeployDrift: vi.fn(),
}));

import * as api from '../api.js';
import { DeployDriftBanner, waitedLabel } from '../DeployDriftBanner.js';

afterEach(cleanup);

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

describe('DeployDriftBanner', () => {
  it('shows count, wait and the commits on click', async () => {
    vi.mocked(api.fetchDeployDrift).mockResolvedValue({
      drift: {
        sha: 'abcdef1234567890', undeployed: 2, undeployedSince: hoursAgo(19), checkedAt: hoursAgo(0),
        commits: [
          { sha: '1', at: hoursAgo(19), subject: 'feat(fleet): waiting_on_humans (#634)' },
          { sha: '2', at: hoursAgo(1), subject: 'fix(scheduler): blockers first (#638)' },
        ],
      },
      probeError: null,
    });
    render(<DeployDriftBanner mapId="m1" />);
    const btn = await screen.findByRole('button', { name: /2 merged changes not deployed — oldest waiting 19 h/ });
    expect(screen.getByText('prod runs abcdef12')).toBeTruthy();
    expect(screen.queryByText(/waiting_on_humans/)).toBeNull();
    fireEvent.click(btn);
    expect(screen.getByText('feat(fleet): waiting_on_humans (#634)')).toBeTruthy();
    expect(api.fetchDeployDrift).toHaveBeenCalledWith('m1');
  });

  it('renders nothing when nothing waits, for other maps (null), or on error', async () => {
    for (const r of [
      async () => ({ drift: { sha: 'a', undeployed: 0, undeployedSince: null, checkedAt: 'x', commits: [] }, probeError: null }),
      async () => ({ drift: null, probeError: null }),
      async () => {
        throw new Error('down');
      },
    ]) {
      vi.mocked(api.fetchDeployDrift).mockImplementationOnce(r as never);
      const { container, unmount } = render(<DeployDriftBanner mapId="m1" />);
      await waitFor(() => expect(api.fetchDeployDrift).toHaveBeenCalled());
      await new Promise((res) => setTimeout(res, 0));
      expect(container.innerHTML).toBe('');
      unmount();
    }
  });

  it("says when the map's probe failed", async () => {
    vi.mocked(api.fetchDeployDrift).mockResolvedValue({ drift: null, probeError: 'probe answered HTTP 404' });
    render(<DeployDriftBanner mapId="m1" />);
    expect((await screen.findByTestId('deploy-probe-error')).textContent).toContain('probe answered HTTP 404');
  });

  it('labels the wait in hours, then days', () => {
    const now = new Date('2026-11-19T12:00:00Z');
    expect(waitedLabel('2026-11-19T11:30:00Z', now)).toBe('under an hour');
    expect(waitedLabel('2026-11-18T17:00:00Z', now)).toBe('19 h');
    expect(waitedLabel('2026-11-16T12:00:00Z', now)).toBe('3 days');
  });
});
