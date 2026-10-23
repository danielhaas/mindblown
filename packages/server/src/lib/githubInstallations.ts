import { and, eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { githubInstallations } from '../db/schema.js';

/**
 * Is this GitHub App installation recorded for the user? Rows are written
 * only after the user's own GitHub token listed the installation (install
 * callback in routes/auth-github.ts), so this is the ownership check for
 * anything that takes an installation id from a request.
 */
export async function userHasGithubInstallation(userId: string, installationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(and(eq(githubInstallations.userId, userId), eq(githubInstallations.installationId, installationId)))
    .limit(1);
  return !!row;
}
