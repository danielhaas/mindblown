// @vitest-environment jsdom
/**
 * The new-project wizard's repo step: a searchable picker over the repos of
 * every GitHub App installation (#615). Typing narrows the list, nothing
 * matching points at installing the App, and the picked repo is saved with
 * the installation that reaches it (#612).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api.js')>();
  return {
    ...real,
    getGitHubInstallStatus: vi.fn(),
    getGiteaAuthStatus: vi.fn(async () => ({ configured: false, connected: false })),
    getGitHubRepositories: vi.fn(),
    importGitHubIssues: vi.fn(async () => ({ imported: 0 })),
  };
});

import * as api from '../api.js';
import { ProjectSetupWizard } from '../ProjectSetupWizard.js';
import { useMindmapStore } from '../store.js';

const m = vi.mocked(api);
const updateMapSettings = vi.fn(async (_: unknown) => true);

const repo = (id: number, owner: string, name: string) => ({
  id, owner, name, fullName: `${owner}/${name}`, private: true, htmlUrl: '', description: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  useMindmapStore.setState({
    currentMap: { id: 'map1', name: 'Shop', workspaceId: 'ws1' } as never,
    nodes: {},
    user: { id: 'u1' } as never,
    loadMap: vi.fn(async () => {}) as never,
    updateMapSettings: updateMapSettings as never,
  });
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
    repositories: id === '11'
      ? [repo(1, 'dan', 'own'), repo(3, 'dan', 'notes')]
      : [repo(2, 'LOKE-Future', 'loke-support')],
  }));
});
afterEach(cleanup);

async function openPicker() {
  const box = await screen.findByTestId('setup-repo-select');
  await waitFor(() => expect((box as HTMLInputElement).disabled).toBe(false));
  fireEvent.focus(box);
  return box;
}

const optionNames = () => screen.queryAllByRole('option').map((o) => o.textContent);

describe('ProjectSetupWizard repo picker', () => {
  it('lists every installation\'s repos grouped by owner and narrows as you type', async () => {
    render(<ProjectSetupWizard step="repo" onStep={() => {}} onClose={() => {}} />);
    const box = await openPicker();
    expect(optionNames()).toEqual(['dan/own', 'dan/notes', 'LOKE-Future/loke-support']);
    expect(within(screen.getByRole('group', { name: 'dan' })).getAllByRole('option')).toHaveLength(2);

    fireEvent.change(box, { target: { value: 'NOT' } });
    expect(optionNames()).toEqual(['dan/notes']);
    fireEvent.change(box, { target: { value: 'loke' } });
    expect(optionNames()).toEqual(['LOKE-Future/loke-support']);
  });

  it('hints at installing the App when nothing matches', async () => {
    render(<ProjectSetupWizard step="repo" onStep={() => {}} onClose={() => {}} />);
    const box = await openPicker();
    fireEvent.change(box, { target: { value: 'acme' } });
    expect(optionNames()).toEqual([]);
    expect(screen.getByTestId('repo-combobox-empty').textContent)
      .toMatch(/No repo matches — is the MindBlown GitHub App installed on that org\?/);
    expect(screen.getByRole('link', { name: 'Install the App' }).getAttribute('href'))
      .toBe('https://github.com/apps/mindblown-by-project-li/installations/new');
  });

  it('picks with the keyboard and connects with the org installation', async () => {
    render(<ProjectSetupWizard step="repo" onStep={() => {}} onClose={() => {}} />);
    const box = await openPicker();
    fireEvent.change(box, { target: { value: 'support' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(screen.getByTestId('setup-repo-connect'));
    await waitFor(() => expect(updateMapSettings).toHaveBeenCalledWith(expect.objectContaining({
      githubInstallationId: '22',
      githubRepoOwner: 'LOKE-Future',
      githubRepoName: 'loke-support',
    })));
  });
});
