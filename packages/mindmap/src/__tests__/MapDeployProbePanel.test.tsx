// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const store = vi.hoisted(() => ({
  map: { id: 'm1', deployProbe: null as string | null },
  update: vi.fn(async () => true),
}));
vi.mock('../store.js', () => ({
  useMindmapStore: (sel: (s: unknown) => unknown) => sel({ currentMap: store.map, updateMapSettings: store.update }),
}));

import { MapDeployProbePanel } from '../MapDeployProbePanel.js';

afterEach(() => {
  cleanup();
  store.update.mockClear();
  store.map = { id: 'm1', deployProbe: null };
});

describe('MapDeployProbePanel', () => {
  it('saves a probe URL', async () => {
    render(<MapDeployProbePanel />);
    fireEvent.change(screen.getByTestId('map-deploy-probe-url'), { target: { value: ' https://navy.example/api/version ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save probe' }));
    await vi.waitFor(() => expect(store.update).toHaveBeenCalledWith({ deployProbe: 'https://navy.example/api/version' }));
  });

  it('refuses what is not a URL, without saving', () => {
    render(<MapDeployProbePanel />);
    fireEvent.change(screen.getByTestId('map-deploy-probe-url'), { target: { value: 'navy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save probe' }));
    expect(screen.getByText(/is not a URL/)).toBeTruthy();
    expect(store.update).not.toHaveBeenCalled();
  });

  it('"Not deployed" stores none; unticking clears it', async () => {
    render(<MapDeployProbePanel />);
    fireEvent.click(screen.getByTestId('map-deploy-probe-none'));
    await vi.waitFor(() => expect(store.update).toHaveBeenCalledWith({ deployProbe: 'none' }));
    cleanup();
    store.map = { id: 'm1', deployProbe: 'none' };
    render(<MapDeployProbePanel />);
    expect((screen.getByTestId('map-deploy-probe-none') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('map-deploy-probe-none'));
    await vi.waitFor(() => expect(store.update).toHaveBeenLastCalledWith({ deployProbe: null }));
  });
});
