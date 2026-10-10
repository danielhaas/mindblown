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

/**
 * Upper bound for one forge HTTP call when the caller passes no signal of
 * its own (#312). Generous — a 100-item issue page answers in well under a
 * second — it only exists so a hung connection cannot stall a request
 * handler or a sync tick indefinitely.
 */
export const FORGE_REQUEST_TIMEOUT_MS = 30_000;
