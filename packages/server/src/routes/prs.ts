/**
 * Open-PRs read endpoint.
 *
 *   GET /api/prs/open?repo=<owner/name>
 *
 * Returns every node whose `linked_pr.state === 'open'` and (if `repo`
 * filter is supplied) `linked_pr.repo === repo`.
 *
 * Designed for autonomous consumers (e.g. `bin/kira-review` on the CRM
 * side) that previously polled the GitHub API for the same data. With
 * webhook ingest of `pull_request.*` + `pull_request_review.submitted`
 * + `check_suite.completed` writing `nodes.linked_pr`, MindBlown is
 * now the canonical source for PR lifecycle state and this endpoint
 * is the single read those consumers need per tick.
 *
 * Output shape (one element per node):
 *   {
 *     nodeId: string,
 *     externalIds: string[],   // GH issue refs the node mirrors
 *     linkedPr: LinkedPrState  // full snapshot incl. reviews/checks/files
 *   }
 *
 * Auth: requires a session/API-key authenticated user (req.userId).
 * The endpoint is read-only and returns no cross-user data because
 * MindBlown is single-tenant for now.
 */

import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { nodes } from '../db/schema.js';
import type { LinkedPrState, ExternalLink } from '@mindblown/core';

export async function prRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { repo?: string } }>(
    '/api/prs/open',
    async (req, reply) => {
      if (!req.userId) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
        });
      }

      const repo = req.query.repo;

      // Filter at the DB level — small index on linked_pr->>'state' would
      // help if the node count grows large, but for current sizes a seq
      // scan is fine (10s of thousands of rows total).
      const rows = await db
        .select({
          id: nodes.id,
          text: nodes.text,
          externalLinks: nodes.externalLinks,
          linkedPr: nodes.linkedPr,
        })
        .from(nodes)
        .where(sql`${nodes.linkedPr} IS NOT NULL AND ${nodes.linkedPr}->>'state' = 'open' AND ${nodes.deletedAt} IS NULL`);

      const out = [];
      for (const row of rows) {
        const linkedPr = row.linkedPr as LinkedPrState | null;
        if (!linkedPr) continue;
        if (repo && linkedPr.repo !== repo) continue;
        const links = (row.externalLinks as ExternalLink[]) ?? [];
        const externalIds = links
          .filter((l) => l.provider === 'github' && l.externalId)
          .map((l) => l.externalId as string);
        out.push({
          nodeId: row.id,
          nodeText: row.text,
          externalIds,
          linkedPr,
        });
      }

      return reply.send({ prs: out });
    },
  );
}
