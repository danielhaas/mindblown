/**
 * The commit this process runs — for `GET /api/version`, which a map's
 * deploy probe reads (services/deployProbe.ts), MindBlown's own included.
 *
 * Prod runs the TypeScript sources with tsx from a git checkout
 * (deploy/mindblown-api.service), so there is no build step to stamp:
 * HEAD is read once, at startup, and kept. A later `git pull` that hasn't
 * been restarted into is not what runs, so it is not reported.
 * `builtAt` is when this process loaded that commit.
 *
 * No git checkout (a container image, a tarball) → `commit: null`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface BuildInfo {
  /** Full sha of HEAD at startup; null when there is no checkout to read. */
  commit: string | null;
  /** ISO time this process loaded the commit. */
  builtAt: string;
}

const SHA = /^[0-9a-f]{40}$/;

async function readHead(): Promise<string | null> {
  try {
    const sha = (await run('git', ['rev-parse', 'HEAD'], { timeout: 10_000 })).stdout.trim();
    return SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

let pending: Promise<BuildInfo> | null = null;

/** Read once per process; every later call gets the same answer. */
export function buildInfo(): Promise<BuildInfo> {
  if (!pending) {
    const builtAt = new Date().toISOString();
    pending = readHead().then((commit) => ({ commit, builtAt }));
  }
  return pending;
}
