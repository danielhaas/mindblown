// @vitest-environment jsdom
/**
 * Workspace settings' per-map repo picker lists the repos of every GitHub
 * App installation (personal account and each org), and saves the picked
 * repo with the installation that reaches it — not the first one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api.js')>();
  return {
    ...real,
    getGitHubInstallStatus: vi.fn(),
    getGitHubRepositories: vi.fn(),
    updateMap: vi.fn(async () => ({})),
  };
});
// The other panels fetch their own data; they are not under test here.
const { Empty } = vi.hoisted(() => ({ Empty: () => null }));
vi.mock('../RegistrationPolicyPanel.js', () => ({ RegistrationPolicyPanel: Empty }));
vi.mock('../ChangePasswordPanel.js', () => ({ ChangePasswordPanel: Empty }));
vi.mock('../DigestMailPanel.js', () => ({ DigestMailPanel: Empty }));
vi.mock('../AdminPasswordResetPanel.js', () => ({ AdminPasswordResetPanel: Empty }));
vi.mock('../ClaudeConnectPanel.js', () => ({ ClaudeConnectPanel: Empty }));
vi.mock('../SettingsApiKeys.js', () => ({ SettingsApiKeys: Empty }));
vi.mock('../AiProviderPanel.js', () => ({ AiProviderPanel: Empty }));
vi.mock('../MapAiPolicyPanel.js', () => ({ MapAiPolicyPanel: Empty }));
vi.mock('../MapArchivePanel.js', () => ({ MapArchivePanel: Empty }));
vi.mock('../MapFleetPanel.js', () => ({ MapFleetPanel: Empty }));
vi.mock('../MapTrustPolicyPanel.js', () => ({ MapTrustPolicyPanel: Empty }));

import * as api from '../api.js';
import { WorkspaceSettings } from '../WorkspaceSettings.js';
import { useMindmapStore } from '../store.js';

const m = vi.mocked(api);

const repo = (id: number, owner: string, name: string) => ({
  id, owner, name, fullName: `${owner}/${name}`, private: true, htmlUrl: '', description: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  useMindmapStore.setState({ currentMap: { id: 'map1' } as never, loadMap: vi.fn() as never });
  m.getGitHubInstallStatus.mockResolvedValue({
    connected: true,
    identity: { githubLogin: 'dan', avatarUrl: null, githubUserId: '1' },
    installations: [
      { installationId: '11', accountLogin: 'dan', accountType: 'User' },
      { installationId: '22', accountLogin: 'LOKE-Future', accountType: 'Organization' },
    ],
    appConfigured: true,
  } as never);
  m.getGitHubRepositories.mockImplementation(async (id?: string) => ({
    installationId: id!,
    repositories: id === '11' ? [repo(1, 'dan', 'own')] : [repo(2, 'LOKE-Future', 'loke-support')],
  }));
});
afterEach(cleanup);

/** Waits for the picker, opens its list and returns the search box. */
async function openPicker() {
  const box = await screen.findByRole('combobox');
  fireEvent.focus(box);
  return box;
}

describe('WorkspaceSettings repo picker', () => {
  it('lists repos from every installation, grouped by owner', async () => {
    render(<WorkspaceSettings onClose={() => {}} mapId="map1" />);
    await openPicker();
    expect(screen.getByRole('option', { name: /LOKE-Future\/loke-support/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /dan\/own/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'No repo linked' })).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'LOKE-Future' })).getByRole('option').textContent).toMatch(/loke-support/);
    expect(m.getGitHubRepositories).toHaveBeenCalledWith('11');
    expect(m.getGitHubRepositories).toHaveBeenCalledWith('22');
  });

  it('saves an org repo with the org installation', async () => {
    const onClose = vi.fn();
    render(<WorkspaceSettings onClose={onClose} mapId="map1" />);
    await openPicker();
    fireEvent.mouseDown(screen.getByRole('option', { name: /LOKE-Future\/loke-support/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(m.updateMap).toHaveBeenCalledWith('map1', {
      githubInstallationId: '22',
      githubRepoOwner: 'LOKE-Future',
      githubRepoName: 'loke-support',
    }));
  });

  it('filters by owner/name as you type, case-insensitively', async () => {
    render(<WorkspaceSettings onClose={() => {}} mapId="map1" />);
    const box = await openPicker();
    fireEvent.change(box, { target: { value: 'loke-SUP' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['LOKE-Future/loke-support (private)']);
    fireEvent.change(box, { target: { value: 'dan/' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['dan/own (private)']);
  });

  it('picks with arrow keys and Enter, closes with Esc', async () => {
    render(<WorkspaceSettings onClose={() => {}} mapId="map1" />);
    const box = await openPicker();
    fireEvent.change(box, { target: { value: 'o' } });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect((box as HTMLInputElement).value).toBe('LOKE-Future/loke-support');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(m.updateMap).toHaveBeenCalledWith('map1', expect.objectContaining({ githubInstallationId: '22' })));

    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('hints at installing the App when nothing matches', async () => {
    render(<WorkspaceSettings onClose={() => {}} mapId="map1" />);
    const box = await openPicker();
    fireEvent.change(box, { target: { value: 'acme/' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/No repo matches — is the MindBlown GitHub App installed on that org\?/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Install the App' }).getAttribute('href'))
      .toBe('https://github.com/apps/mindblown-by-project-li/installations/new');
  });

  it('still lists the other installations when one fails', async () => {
    m.getGitHubRepositories.mockImplementation(async (id?: string) => {
      if (id === '11') throw new Error('boom');
      return { installationId: id!, repositories: [repo(2, 'LOKE-Future', 'loke-support')] };
    });
    render(<WorkspaceSettings onClose={() => {}} mapId="map1" />);
    await openPicker();
    expect(screen.getByRole('option', { name: /LOKE-Future\/loke-support/ })).toBeTruthy();
  });
});
