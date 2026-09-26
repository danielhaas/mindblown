/**
 * Promote an existing node to a new issue on the map's forge and link it
 * back. Shared by POST /nodes/:id/github/create and the ticket-intake
 * accept step (#387), so both file the issue the same way.
 *
 * Attribution: when the acting user has their own identity on the map's
 * forge (Gitea sign-in, or a GitHub sign-in whose token may open issues),
 * the issue is filed as that person; otherwise, or when the personal
 * token is refused (no write access to the repo, expired and not
 * refreshable), it falls back to the repo binding — the App installation
 * or the token the repo was connected with. The caller learns which.
 */

import { createGitHubIssue, createForgeClient, githubForge, type ForgeClient } from '@mindblown/integrations';
import type { Node as CoreNode } from '@mindblown/core';
import * as nodeDb from '../db/nodes.js';
import { getGitHubContextForMap, getForgeEndpointForMap } from '../lib/githubContext.js';
import { stampMirrorHash } from '../lib/descriptionMirror.js';
import { broadcast } from '../ws.js';

export class NoForgeIntegrationError extends Error {
  readonly code = 'NO_INTEGRATION' as const;
  constructor() {
    super('GitHub not configured for this map. Link a repo in settings first.');
    this.name = 'NoForgeIntegrationError';
  }
}

export interface IssueAuthor {
  /** `user`: filed with the acting person's own token. `binding`: the repo's App / connect token. */
  as: 'user' | 'binding';
  /** The forge login the issue shows, when known (user path only). */
  login: string | null;
  /** Why a personal identity was not used, when the caller asked for one. */
  fallbackReason?: string;
}

export interface CreatedForgeIssue {
  node: CoreNode;
  issue: { number: number; html_url: string; title: string };
  author: IssueAuthor;
}

function sameOrigin(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * A client acting as the user on the map's forge, or null with the reason
 * when the user has no usable identity there.
 */
export async function userForgeForMap(
  mapId: string,
  userId: string,
): Promise<{ forge: ForgeClient; login: string } | { forge: null; reason: string }> {
  const endpoint = await getForgeEndpointForMap(mapId);
  // Loaded here, not at module top: the identity modules pull the
  // identities table into the import graph, and the webhook route suites
  // mock the schema partially — they only exercise the binding path.
  const [{ findGiteaIdentity, giteaAccessTokenFor, giteaOAuthApp }, { findGithubIdentity, githubAccessTokenFor, githubTokenUsableForIssues }] =
    await Promise.all([import('../lib/giteaOAuth.js'), import('../lib/githubIdentity.js')]);
  if (endpoint.kind === 'gitea') {
    const identity = await findGiteaIdentity(userId);
    if (!identity) return { forge: null, reason: 'no Gitea sign-in for this user' };
    const app = giteaOAuthApp();
    if (!app) return { forge: null, reason: 'Gitea OAuth is not configured on this server' };
    if (!sameOrigin(app.instanceUrl, endpoint.webBaseUrl)) {
      return { forge: null, reason: `the user's Gitea sign-in is on ${app.instanceUrl}, the repo on ${endpoint.webBaseUrl}` };
    }
    const token = await giteaAccessTokenFor(identity);
    return {
      forge: createForgeClient({ kind: 'gitea', apiBaseUrl: endpoint.apiBaseUrl, webBaseUrl: endpoint.webBaseUrl, token }),
      login: identity.githubLogin,
    };
  }
  if (endpoint.kind === 'github') {
    const identity = await findGithubIdentity(userId);
    if (!identity) return { forge: null, reason: 'no GitHub sign-in for this user' };
    const usable = githubTokenUsableForIssues(identity);
    if (!usable.ok) return { forge: null, reason: usable.reason };
    // Refreshes an expired App user token; throws when it cannot, which
    // the caller turns into a binding fallback with the reason.
    const token = await githubAccessTokenFor(identity);
    return { forge: githubForge(token), login: identity.githubLogin };
  }
  return { forge: null, reason: `unsupported forge kind ${String(endpoint.kind)}` };
}

export async function createForgeIssueForNode(
  mapId: string,
  node: CoreNode,
  opts: { actorUserId?: string | null } = {},
): Promise<CreatedForgeIssue> {
  const ghCtx = await getGitHubContextForMap(mapId);
  if (!ghCtx) throw new NoForgeIntegrationError();

  let forge: ForgeClient = ghCtx.forge;
  let author: IssueAuthor = { as: 'binding', login: null };
  if (opts.actorUserId) {
    try {
      const mine = await userForgeForMap(mapId, opts.actorUserId);
      if (mine.forge) {
        forge = mine.forge;
        author = { as: 'user', login: mine.login };
      } else {
        author.fallbackReason = mine.reason;
      }
    } catch (err) {
      // An expired, non-refreshable token is the typical case — the repo
      // binding still works, and the caller sees why the name is not theirs.
      author.fallbackReason = err instanceof Error ? err.message : String(err);
    }
  }

  let created: Awaited<ReturnType<typeof createGitHubIssue>>;
  try {
    created = await createGitHubIssue(node, ghCtx.owner, ghCtx.repo, forge);
  } catch (err) {
    if (author.as !== 'user') throw err;
    // The person's token was refused (no write access to this repo, revoked
    // …): file as the binding rather than lose the issue, and say so.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[forge-issue] filing as ${author.login} failed (${reason}); falling back to the repo binding`);
    created = await createGitHubIssue(node, ghCtx.owner, ghCtx.repo, ghCtx.forge);
    author = { as: 'binding', login: null, fallbackReason: reason };
  }
  const { issue, externalLink } = created;

  // The description is NODE-authored (pushed TO the forge, not mirrored
  // from it) — stamp the link as "mirror wrote nothing" so the
  // issues.edited guard treats it as curated from day one instead of
  // falling back to the prior-body equality check, which a forge-side
  // edit would misread as a mirror one round-trip later.
  const existingLinks = [...node.externalLinks, stampMirrorHash(externalLink, null)];
  const updated = await nodeDb.updateNode(node.id, { externalLinks: existingLinks });
  if (!updated) throw new Error(`Node ${node.id} vanished while linking issue #${issue.number}`);

  broadcast(mapId, { type: 'node:updated', nodeId: node.id, fields: ['externalLinks'], node: updated });

  return {
    node: updated,
    issue: { number: issue.number, html_url: issue.html_url, title: issue.title },
    author,
  };
}
