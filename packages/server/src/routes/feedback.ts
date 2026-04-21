/**
 * Feedback → GitHub Issue bridge. Authenticated users can file a bug
 * report from the app; we post it to a single repo owned by the
 * operator (not the user's connected repo), using a dedicated PAT.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { users } from '../db/schema.js';

interface TicketBody {
  title?: string;
  description?: string;
  page?: string;
}

export async function feedbackRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/feedback/ticket', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
    }

    const body = (req.body ?? {}) as TicketBody;
    const title = (body.title ?? '').trim();
    const description = (body.description ?? '').trim();
    const page = (body.page ?? '').trim();

    if (!title) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Title is required' },
      });
    }

    const githubToken = process.env.FEEDBACK_GITHUB_PAT;
    const githubRepo = process.env.FEEDBACK_GITHUB_REPO;
    if (!githubToken || !githubRepo) {
      return reply.status(503).send({
        error: { code: 'NOT_CONFIGURED', message: 'Feedback integration not configured' },
      });
    }

    const [user] = await db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const bodyParts: string[] = [];
    if (description) bodyParts.push(description);
    bodyParts.push('---');
    if (page) bodyParts.push(`**URL:** ${page}`);
    if (user) bodyParts.push(`**Submitted by:** ${user.name} (${user.email})`);
    const issueBody = bodyParts.join('\n');

    try {
      const res = await fetch(`https://api.github.com/repos/${githubRepo}/issues`, {
        method: 'POST',
        headers: {
          Authorization: `token ${githubToken}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'mindblown-feedback',
        },
        body: JSON.stringify({
          title,
          body: issueBody,
          labels: ['user-feedback'],
        }),
      });

      if (res.status !== 201) {
        const text = await res.text().catch(() => '');
        app.log.error({ status: res.status, body: text }, 'GitHub issue creation failed');
        return reply.status(502).send({
          error: { code: 'GITHUB_ERROR', message: `GitHub API error (${res.status})` },
        });
      }

      const issue = (await res.json()) as { number: number; html_url: string };
      return {
        success: true,
        issueNumber: issue.number,
        url: issue.html_url,
      };
    } catch (err) {
      app.log.error({ err }, 'Failed to reach GitHub API');
      return reply.status(502).send({
        error: { code: 'GITHUB_UNREACHABLE', message: 'Could not connect to GitHub' },
      });
    }
  });
}
