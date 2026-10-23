/**
 * Wire helpers for repo contents (#550). GitHub and Gitea answer
 * `GET …/git/trees/{ref}` and `GET …/git/blobs/{sha}` with the same body
 * shape; only the paging differs (GitHub: one response, `truncated` past
 * its size cap; Gitea: `page`/`per_page`, `truncated` on every page but the
 * last — measured on 1.27, 2026-10-23).
 */

import type { RepoTreeFile } from './types.js';

export interface RawTree {
  sha: string;
  truncated?: boolean;
  tree: Array<{ path: string; type: string; sha: string; size?: number }>;
}

export interface RawBlob {
  content: string;
  encoding: string;
}

/** A branch name in a path: each segment escaped (`#`, `?`, `%`), the slashes kept. */
export function encodeRef(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

/** Files only — directories (`tree`) and submodules (`commit`) dropped. */
export function treeFiles(raw: RawTree): RepoTreeFile[] {
  return raw.tree
    .filter((e) => e.type === 'blob')
    .map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 }));
}

/**
 * Writes (#552). `PUT …/contents/{path}` `{ message, content, sha, branch }`
 * and `POST …/pulls` `{ title, body, head, base }` are the same on both
 * forges, request and response. A stale `sha` is 409 on GitHub and 422
 * "sha does not match" on Gitea (measured 1.27, 2026-10-23).
 */
export interface RawPutFile {
  content: { sha: string };
  commit: { sha: string };
}

export function contentsPath(owner: string, repo: string, path: string): string {
  return `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** A blob body as bytes. GitHub wraps its base64 at 60 columns. */
export function blobBytes(raw: RawBlob): Uint8Array {
  if (raw.encoding !== 'base64') return new TextEncoder().encode(raw.content);
  const bin = atob(raw.content.replace(/\s/g, ''));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
