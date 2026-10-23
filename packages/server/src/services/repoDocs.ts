/**
 * Repo docs (#550): the markdown files of a map's connected repo, read
 * straight from the forge — nothing is copied into the database.
 *
 * Staying in sync rests on git's own addressing. A blob's sha changes
 * exactly when the file does, so blob text is cached by sha forever (an
 * LRU only bounds memory). The branch tree is the one thing that goes
 * stale: it is cached per map for `TREE_TTL_MS` so the tab's poll from
 * several viewers costs one forge call, and a push to the default branch
 * drops it at once (`onRepoPush`, called from the webhook) and tells open
 * Docs tabs to re-list.
 */

import { and, eq, sql } from 'drizzle-orm';
import { getRepoDefaultBranch, type ForgeClient, type RepoTreeFile } from '@mindblown/integrations';
import type { RepoDocsList, RepoDocText } from '@mindblown/tool-kit';
import { db } from '../db/connection.js';
import { maps } from '../db/schema.js';
import { getForgeContextForMap } from '../lib/githubContext.js';
import { broadcast } from '../ws.js';

export const DOC_PATH = /\.(md|markdown)$/i;

/** What `readRepoImage` serves — raster and SVG only; served with a sandboxing CSP. */
export const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

const TREE_TTL_MS = 15_000;
const BRANCH_TTL_MS = 10 * 60_000;
export const DOC_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const BLOB_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export class RepoDocsError extends Error {
  constructor(
    readonly status: 404 | 413 | 502,
    readonly code: 'NO_REPO' | 'NOT_FOUND' | 'TOO_LARGE' | 'FORGE_ERROR',
    message: string,
  ) {
    super(message);
  }
}

interface Snapshot {
  forge: ForgeClient;
  owner: string;
  repo: string;
  branch: string;
  treeSha: string;
  /** Docs and images only — the rest of the tree is never served, so never held. */
  files: Map<string, RepoTreeFile>;
  truncated: boolean;
}

const trees = new Map<string, { at: number; snap: Promise<Snapshot> }>();
const branches = new Map<string, { at: number; branch: string }>();
/** LRU by insertion order; `blobBytes` is the sum of what it holds. */
const blobs = new Map<string, Uint8Array>();
/** One forge read per blob, however many viewers miss at once. */
const blobsInFlight = new Map<string, Promise<Uint8Array>>();
let blobBytes = 0;

/** Test seam. */
export function _resetRepoDocsCacheForTests(): void {
  trees.clear();
  branches.clear();
  blobs.clear();
  blobsInFlight.clear();
  blobBytes = 0;
}

function imageType(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return Object.hasOwn(IMAGE_TYPES, ext) ? IMAGE_TYPES[ext] : undefined;
}

function forgeError(err: unknown): RepoDocsError {
  return new RepoDocsError(502, 'FORGE_ERROR', `Could not read the repo: ${err instanceof Error ? err.message : String(err)}`);
}

async function defaultBranch(forge: ForgeClient, owner: string, repo: string): Promise<string> {
  const key = `${forge.endpoint.apiBaseUrl}/${owner}/${repo}`.toLowerCase();
  const hit = branches.get(key);
  if (hit && Date.now() - hit.at < BRANCH_TTL_MS) return hit.branch;
  const branch = await getRepoDefaultBranch(owner, repo, forge);
  branches.set(key, { at: Date.now(), branch });
  return branch;
}

async function loadSnapshot(mapId: string): Promise<Snapshot> {
  let ctx: Awaited<ReturnType<typeof getForgeContextForMap>>;
  try {
    // Can throw too — an OAuth refresh, an App token mint.
    ctx = await getForgeContextForMap(mapId);
  } catch (err) {
    throw forgeError(err);
  }
  if (!ctx) throw new RepoDocsError(404, 'NO_REPO', 'This map has no repository connected');
  try {
    const branch = await defaultBranch(ctx.forge, ctx.owner, ctx.repo);
    const tree = await ctx.forge.getRepoTree(ctx.owner, ctx.repo, branch);
    return {
      forge: ctx.forge,
      owner: ctx.owner,
      repo: ctx.repo,
      branch,
      treeSha: tree.sha,
      files: new Map(tree.files.filter((f) => DOC_PATH.test(f.path) || imageType(f.path)).map((f) => [f.path, f])),
      truncated: tree.truncated,
    };
  } catch (err) {
    throw forgeError(err);
  }
}

function snapshot(mapId: string): Promise<Snapshot> {
  const now = Date.now();
  // Expired trees go, so maps nobody reads any more hold nothing.
  for (const [id, entry] of trees) if (now - entry.at >= TREE_TTL_MS) trees.delete(id);
  const hit = trees.get(mapId);
  if (hit) return hit.snap;
  const snap = loadSnapshot(mapId);
  trees.set(mapId, { at: Date.now(), snap });
  // A failure is not cached — the next read tries again.
  snap.catch(() => {
    if (trees.get(mapId)?.snap === snap) trees.delete(mapId);
  });
  return snap;
}

async function blob(snap: Snapshot, file: RepoTreeFile): Promise<Uint8Array> {
  const key = `${snap.owner}/${snap.repo}@${file.sha}`.toLowerCase();
  const hit = blobs.get(key);
  if (hit) {
    blobs.delete(key);
    blobs.set(key, hit);
    return hit;
  }
  const pending = blobsInFlight.get(key);
  if (pending) return pending;
  const read = snap.forge.getBlob(snap.owner, snap.repo, file.sha).then(
    (bytes) => {
      blobs.set(key, bytes);
      blobBytes += bytes.length;
      for (const [k, v] of blobs) {
        if (blobBytes <= BLOB_CACHE_MAX_BYTES) break;
        blobs.delete(k);
        blobBytes -= v.length;
      }
      return bytes;
    },
    (err) => {
      throw forgeError(err);
    },
  );
  blobsInFlight.set(key, read);
  // Settled either way → the next miss reads again (a failure is not kept).
  void read.then(
    () => blobsInFlight.delete(key),
    () => blobsInFlight.delete(key),
  );
  return read;
}

function webUrl(snap: Snapshot, path?: string): string {
  const repoUrl = `${snap.forge.endpoint.webBaseUrl}/${snap.owner}/${snap.repo}`;
  if (path === undefined) return repoUrl;
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const branch = encodeURIComponent(snap.branch);
  return snap.forge.endpoint.kind === 'gitea'
    ? `${repoUrl}/src/branch/${branch}/${encoded}`
    : `${repoUrl}/blob/${branch}/${encoded}`;
}

export async function listRepoDocs(mapId: string): Promise<RepoDocsList> {
  const snap = await snapshot(mapId);
  const docs = [...snap.files.values()]
    .filter((f) => DOC_PATH.test(f.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, sha, size }) => ({ path, sha, size }));
  return {
    repo: { owner: snap.owner, name: snap.repo, branch: snap.branch, webUrl: webUrl(snap) },
    treeSha: snap.treeSha,
    docs,
    truncated: snap.truncated,
  };
}

/** Only a path the current tree lists as a doc is read — never an arbitrary blob of the repo. */
export async function readRepoDoc(mapId: string, path: string): Promise<RepoDocText> {
  const snap = await snapshot(mapId);
  const file = DOC_PATH.test(path) ? snap.files.get(path) : undefined;
  if (!file) throw new RepoDocsError(404, 'NOT_FOUND', `No document '${path}' on ${snap.branch}`);
  if (file.size > DOC_MAX_BYTES) throw new RepoDocsError(413, 'TOO_LARGE', `'${path}' is larger than ${DOC_MAX_BYTES / 1024 / 1024} MB`);
  const bytes = await blob(snap, file);
  return { path, sha: file.sha, size: file.size, text: new TextDecoder().decode(bytes), webUrl: webUrl(snap, path) };
}

/** An image a doc embeds by a relative path. */
export async function readRepoImage(mapId: string, path: string): Promise<{ bytes: Uint8Array; contentType: string; sha: string }> {
  const contentType = imageType(path);
  const snap = await snapshot(mapId);
  const file = contentType ? snap.files.get(path) : undefined;
  if (!contentType || !file) throw new RepoDocsError(404, 'NOT_FOUND', `No image '${path}' on ${snap.branch}`);
  if (file.size > IMAGE_MAX_BYTES) throw new RepoDocsError(413, 'TOO_LARGE', `'${path}' is larger than ${IMAGE_MAX_BYTES / 1024 / 1024} MB`);
  return { bytes: await blob(snap, file), contentType, sha: file.sha };
}

/**
 * A push landed on `owner/name`. On its default branch, every map bound
 * to the repo drops its cached tree and its open Docs tabs re-list.
 * Payload fields are the same on GitHub and Gitea (`ref`,
 * `repository.default_branch`).
 */
export async function onRepoPush(fullName: string, payload: { ref?: unknown; repository?: { default_branch?: unknown } }): Promise<number> {
  const [owner, name] = fullName.split('/');
  if (!owner || !name) return 0;
  const branch = payload.repository?.default_branch;
  if (typeof branch === 'string' && payload.ref !== `refs/heads/${branch}`) return 0;
  // The default branch may just have been renamed — ask again.
  const suffix = `/${owner}/${name}`.toLowerCase();
  for (const key of branches.keys()) if (key.endsWith(suffix)) branches.delete(key);
  const rows = await db
    .select({ id: maps.id })
    .from(maps)
    .where(and(eq(sql`lower(${maps.githubRepoOwner})`, owner.toLowerCase()), eq(sql`lower(${maps.githubRepoName})`, name.toLowerCase())));
  for (const { id } of rows) {
    trees.delete(id);
    broadcast(id, { type: 'docs:updated' });
  }
  return rows.length;
}
