/**
 * Promote an existing node to a new issue on the map's forge and link it
 * back. Shared by POST /nodes/:id/github/create and the ticket-intake
 * accept step (#387), so both file the issue the same way.
 */

import { createGitHubIssue } from '@mindblown/integrations';
import type { Node as CoreNode } from '@mindblown/core';
import * as nodeDb from '../db/nodes.js';
import { getGitHubContextForMap } from '../lib/githubContext.js';
import { stampMirrorHash } from '../lib/descriptionMirror.js';
import { broadcast } from '../ws.js';

export class NoForgeIntegrationError extends Error {
  readonly code = 'NO_INTEGRATION' as const;
  constructor() {
    super('GitHub not configured for this map. Link a repo in settings first.');
    this.name = 'NoForgeIntegrationError';
  }
}

export interface CreatedForgeIssue {
  node: CoreNode;
  issue: { number: number; html_url: string; title: string };
}

export async function createForgeIssueForNode(
  mapId: string,
  node: CoreNode,
): Promise<CreatedForgeIssue> {
  const ghCtx = await getGitHubContextForMap(mapId);
  if (!ghCtx) throw new NoForgeIntegrationError();

  const { issue, externalLink } = await createGitHubIssue(node, ghCtx.owner, ghCtx.repo, ghCtx.forge);

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
  };
}
