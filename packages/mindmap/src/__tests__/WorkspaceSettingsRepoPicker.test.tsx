// @vitest-environment jsdom
/**
 * Workspace settings' per-map repo picker lists the repos of every GitHub
 * App installation (personal account and each org), and saves the picked
 * repo with the installation that reaches it — not the first one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

describe('WorkspaceSettings repo picker', () => {
  it('lists repos from every installation', async () => {
    render(<WorkspaceSettings onClose={() => {}} mapId="map1" />);
    await screen.findByRole('option', { name: /LOKE-Future\/loke-support/ });
    expect(screen.getByRole('option', { name: /dan\/own/ })).toBeTruthy();
    expect(m.getGitHubRepositories).toHaveBeenCalledWith('11');
    expect(m.getGitHubRepositories).toHaveBeenCalledWith('22');
  });

  it('saves an org repo with the org installation', async () => {
    const onClose = vi.fn();
    render(<WorkspaceSettings onClose={onClose} mapId="map1" />);
    await screen.findByRole('option', { name: /LOKE-Future\/loke-support/ });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'LOKE-Future/loke-support' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(m.updateMap).toHaveBeenCalledWith('map1', {
      githubInstallationId: '22',
      githubRepoOwner: 'LOKE-Future',
      githubRepoName: 'loke-support',
    }));
  });

  it('still lists the other installations when one fails', async () => {
    m.getGitHubRepositories.mockImplementation(async (id?: string) => {
      if (id === '11') throw new Error('boom');
      return { installationId: id!, repositories: [repo(2, 'LOKE-Future', 'loke-support')] };
    });
    render(<WorkspaceSettings onClose={() => {}} mapId="map1" />);
    await screen.findByRole('option', { name: /LOKE-Future\/loke-support/ });
  });
});
