import { listUserInstallationRepositories, type GitHubRepo } from '@mindblown/integrations';
import { findGithubIdentity, githubAccessTokenFor } from './githubIdentity.js';

export interface InstallationAccessError {
  status: number;
  code: string;
  message: string;
}

/**
 * The repos of a GitHub App installation that this user can reach, asked
 * of GitHub with the user's own token. This is the ownership check for
 * anything that takes an installation id or a repo from a request: stored
 * `github_installations` rows are a list for the UI, not proof (rows from
 * before the install callback verified them may name anyone's
 * installation), and an installation the user can reach may hold repos
 * they cannot.
 */
export async function userInstallationRepos(
  userId: string,
  installationId: string,
): Promise<{ repos: GitHubRepo[] } | InstallationAccessError> {
  const identity = await findGithubIdentity(userId);
  if (!identity) {
    return { status: 403, code: 'GITHUB_NOT_CONNECTED', message: 'Connect your GitHub account first' };
  }
  let token: string;
  try {
    token = await githubAccessTokenFor(identity);
  } catch {
    return { status: 403, code: 'GITHUB_NOT_CONNECTED', message: 'Your GitHub sign-in expired — connect GitHub again' };
  }
  try {
    return { repos: await listUserInstallationRepositories(token, installationId) };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401) {
      return { status: 403, code: 'GITHUB_NOT_CONNECTED', message: 'Your GitHub sign-in expired — connect GitHub again' };
    }
    if (status === 403 || status === 404) {
      return { status: 403, code: 'FORBIDDEN', message: 'That GitHub App installation is not connected to your account' };
    }
    console.error('[github] Listing the user\'s installation repos failed:', err);
    return { status: 502, code: 'GITHUB_ERROR', message: 'Failed to list repositories from GitHub' };
  }
}
