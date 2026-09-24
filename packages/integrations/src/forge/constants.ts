/**
 * GitHub's public hosts. Together with `github.ts` this is the only place
 * in the codebase that spells them out; everything else receives them
 * through a `ForgeEndpoint`.
 */
import type { ForgeEndpoint } from './types.js';

export const GITHUB_API_BASE = 'https://api.github.com';
export const GITHUB_WEB_BASE = 'https://github.com';

/** The public github.com endpoint — the default for every binding that predates #367. */
export const GITHUB_ENDPOINT: ForgeEndpoint = {
  kind: 'github',
  apiBaseUrl: GITHUB_API_BASE,
  webBaseUrl: GITHUB_WEB_BASE,
};
