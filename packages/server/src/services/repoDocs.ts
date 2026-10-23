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
import { ForgeApiError, getRepoDefaultBranch, type ForgeClient, type RepoTreeFile } from '@mindblown/integrations';
import type { ProposeDocEditInput, ProposeDocEditResult, RepoDocsList, RepoDocText } from '@mindblown/tool-kit';
import { db } from '../db/connection.js';
import { maps, users } from '../db/schema.js';
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
    readonly status: 400 | 404 | 409 | 413 | 422 | 502,
    readonly code: 'NO_REPO' | 'NOT_FOUND' | 'TOO_LARGE' | 'FORGE_ERROR' | 'CONFLICT' | 'NO_CHANGE' | 'NOT_UTF8',
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

/** `binding` = the map's repo binding the tree was read for — a rebind must not serve the old repo. */
const trees = new Map<string, { at: number; binding: string; snap: Promise<Snapshot> }>();
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

const branchKey = (forge: ForgeClient, owner: string, repo: string) => `${forge.endpoint.apiBaseUrl}/${owner}/${repo}`.toLowerCase();

async function defaultBranch(forge: ForgeClient, owner: string, repo: string): Promise<string> {
  const key = branchKey(forge, owner, repo);
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
    const { forge, owner, repo } = ctx;
    let branch = await defaultBranch(forge, owner, repo);
    let tree = await treeOrNull(forge, owner, repo, branch);
    if (!tree) {
      // No such branch: the cached default may have been renamed (a rename
      // sends no push) — ask the forge once more.
      branches.delete(branchKey(forge, owner, repo));
      const fresh = await defaultBranch(forge, owner, repo);
      if (fresh !== branch) {
        branch = fresh;
        tree = await treeOrNull(forge, owner, repo, branch);
      }
    }
    // Still none: an empty repo — its default branch has no commit yet.
    tree ??= { sha: '', files: [], truncated: false };
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

/** GitHub answers 409 for an empty repo, both forges 404 for a missing branch. */
async function treeOrNull(forge: ForgeClient, owner: string, repo: string, branch: string) {
  try {
    return await forge.getRepoTree(owner, repo, branch);
  } catch (err) {
    if (err instanceof ForgeApiError && (err.status === 404 || err.status === 409)) return null;
    throw err;
  }
}

/** Which repo the map is bound to right now — one primary-key read, no token minted. */
async function bindingOf(mapId: string): Promise<string> {
  const [row] = await db
    .select({ installation: maps.githubInstallationId, owner: maps.githubRepoOwner, name: maps.githubRepoName })
    .from(maps)
    .where(eq(maps.id, mapId));
  return row ? `${row.installation ?? ''}|${row.owner ?? ''}/${row.name ?? ''}`.toLowerCase() : '';
}

async function snapshot(mapId: string): Promise<Snapshot> {
  const binding = await bindingOf(mapId);
  const now = Date.now();
  // Expired trees go, so maps nobody reads any more hold nothing.
  for (const [id, entry] of trees) if (now - entry.at >= TREE_TTL_MS) trees.delete(id);
  // Synchronous from here: concurrent misses still share one load.
  const hit = trees.get(mapId);
  if (hit?.binding === binding) return hit.snap;
  const snap = loadSnapshot(mapId);
  trees.set(mapId, { at: Date.now(), binding, snap });
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
  let text: string;
  let utf8 = true;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Shown with U+FFFD; `utf8: false` tells editors a proposal is refused.
    text = new TextDecoder().decode(bytes);
    utf8 = false;
  }
  return { path, sha: file.sha, size: file.size, text, utf8, webUrl: webUrl(snap, path) };
}

/** The name the PR body credits — the user's display name, never the email (repos may be public). */
export async function proposerName(userId: string): Promise<string> {
  const [row] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.name?.trim() || 'a MindBlown user';
}

/** `docs/product-vision.md` at 2026-10-23T09:14:05Z → `mindblown/docs-product-vision-20261023-091405-a1b2`. */
export function editBranchName(path: string, now: Date, suffix: string): string {
  const stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.(md|markdown)$/i, '');
  const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'doc';
  const stamp = now.toISOString().slice(0, 19).replace(/-|:/g, '').replace('T', '-');
  return `mindblown/docs-${slug}-${stamp}-${suffix}`;
}

/**
 * Propose an edit to one doc (#552): a fresh branch off the default
 * branch, one commit with the new text, a pull request back. The default
 * branch is never written. `baseSha` is the blob the editor loaded; if
 * the doc moved on since, nothing is created and the caller gets 409 —
 * the forge enforces the same rule on the commit itself, as a backstop
 * for a push that lands in between.
 */
export async function proposeRepoDocEdit(
  mapId: string,
  input: ProposeDocEditInput,
  proposedBy: string,
): Promise<ProposeDocEditResult> {
  const { path, text, baseSha } = input;
  // Judge staleness against the branch as it is now, not a cached tree.
  trees.delete(mapId);
  const snap = await snapshot(mapId);
  const file = DOC_PATH.test(path) ? snap.files.get(path) : undefined;
  if (!file) throw new RepoDocsError(404, 'NOT_FOUND', `No document '${path}' on ${snap.branch}`);
  if (file.sha !== baseSha) {
    throw new RepoDocsError(409, 'CONFLICT', `'${path}' changed on ${snap.branch} since it was opened — reload it and apply the edit again`);
  }
  const current = await blob(snap, file);
  // The editor saw decoded text: a doc that is not UTF-8 would come back
  // with U+FFFD where its bytes were — refuse rather than corrupt it.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(current);
  } catch {
    throw new RepoDocsError(422, 'NOT_UTF8', `'${path}' is not UTF-8 text — edit it in the repo instead`);
  }
  // Decoding drops a leading BOM; put it back so the PR doesn't remove it.
  const bom = current[0] === 0xef && current[1] === 0xbb && current[2] === 0xbf;
  const content = new TextEncoder().encode(bom && !text.startsWith('﻿') ? `﻿${text}` : text);
  if (content.length > DOC_MAX_BYTES) throw new RepoDocsError(413, 'TOO_LARGE', `The new text is larger than ${DOC_MAX_BYTES / 1024 / 1024} MB`);
  if (current.length === content.length && current.every((b, i) => b === content[i])) {
    throw new RepoDocsError(400, 'NO_CHANGE', 'The text is unchanged — nothing to propose');
  }

  const branch = editBranchName(path, new Date(), Math.random().toString(16).slice(2, 6));
  // The summary's first line is the title; all of it is the commit message.
  const summary = input.message?.trim() || `docs: update ${path}`;
  const title = summary.split('\n')[0].trim().slice(0, 200);
  const { forge, owner, repo } = snap;
  try {
    await forge.createBranch(owner, repo, branch, snap.branch);
  } catch (err) {
    throw forgeWriteError(err, `${owner}/${repo}`);
  }
  try {
    const commit = await forge.putFile(owner, repo, { path, branch, content, blobSha: baseSha, message: summary });
    const pr = await forge.createPullRequest(owner, repo, {
      title,
      head: branch,
      base: snap.branch,
      body: `Edited in the MindBlown Docs tab by ${proposedBy}.\n\nOne file: \`${path}\`.`,
    });
    return { path, branch, commitSha: commit.commitSha, pullRequest: pr };
  } catch (err) {
    // Leave no orphan branch behind; the error is the answer either way.
    // (A PR that timed out but was created loses its head here and closes —
    // a retry then opens a fresh one, which beats a dangling branch.)
    await forge.deleteBranch(owner, repo, branch).catch((cleanupErr) => {
      console.warn(`[docs] could not delete orphan branch ${owner}/${repo}:${branch}:`, cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
    });
    if (err instanceof ForgeApiError && err.status === 409) {
      throw new RepoDocsError(409, 'CONFLICT', `'${path}' changed on ${snap.branch} while the edit was being saved — reload it and apply the edit again`);
    }
    throw forgeWriteError(err, `${owner}/${repo}`);
  }
}

function forgeWriteError(err: unknown, repo: string): RepoDocsError {
  if (err instanceof ForgeApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
    return new RepoDocsError(502, 'FORGE_ERROR', `The repo connection has no write access to ${repo} (branches, contents and pull requests) — ${err.message}`);
  }
  return new RepoDocsError(502, 'FORGE_ERROR', `Could not write to the repo: ${err instanceof Error ? err.message : String(err)}`);
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
