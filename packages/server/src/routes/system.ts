/**
 * System-wide routes — currently just the registration policy getter/setter.
 * Reads are open to authenticated users (so the login screen can explain why
 * signup is closed); writes are admin-only.
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  getRegistrationPolicy,
  setRegistrationPolicy,
  type RegistrationPolicy,
  getAiProviderSettings,
  setAiProviderSettings,
  type AiProviderSettings,
  type AiProviderPreference,
} from '../db/settings.js';
import { requireAdmin, hashPassword, markPasswordChanged } from '../auth.js';
import { db } from '../db/connection.js';
import { users } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/system/registration-policy ────────────────────────
  // Any authenticated user can read the policy so the login UI and admin
  // panel share one source of truth.
  app.get('/api/system/registration-policy', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
    }
    const policy = await getRegistrationPolicy();
    return policy;
  });

  // ── PUT /api/system/registration-policy ────────────────────────
  // Admin-only. `requireAdmin` rejects API-key auth even for admin users
  // (see auth.ts).
  app.put('/api/system/registration-policy', async (req, reply) => {
    if (!(await requireAdmin(req))) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Admin access required' },
      });
    }
    const body = req.body as Partial<RegistrationPolicy>;
    if (!body || !body.mode) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'mode is required' },
      });
    }
    const saved = await setRegistrationPolicy({
      mode: body.mode,
      allowlist: Array.isArray(body.allowlist) ? body.allowlist : [],
    });
    return saved;
  });

  // ── GET /api/system/ai-provider ────────────────────────────────
  // Any authenticated user can read the current preference (the chat panel
  // surfaces it as a status badge). Writes are admin-only below.
  app.get('/api/system/ai-provider', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
    }
    return await getAiProviderSettings();
  });

  // ── PUT /api/system/ai-provider ────────────────────────────────
  // Admin-only. `requireAdmin` rejects API-key auth even for admin users
  // (see auth.ts).
  app.put('/api/system/ai-provider', async (req, reply) => {
    if (!(await requireAdmin(req))) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Admin access required' },
      });
    }
    const body = req.body as Partial<AiProviderSettings>;
    const preference = body?.preference;
    if (
      preference !== 'auto' &&
      preference !== 'ollama' &&
      preference !== 'anthropic'
    ) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'preference must be one of: auto, ollama, anthropic',
        },
      });
    }
    const saved = await setAiProviderSettings({
      preference: preference as AiProviderPreference,
    });
    return saved;
  });

  // ── POST /api/system/reset-password ────────────────────────────
  // Admin-only. Sets a server-generated temporary password on the given
  // account and returns it once — there is no reset email; the admin hands
  // the temp password to the user out-of-band, who then changes it via
  // /api/auth/change-password.
  app.post('/api/system/reset-password', async (req, reply) => {
    if (!(await requireAdmin(req))) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Admin access required' },
      });
    }
    const body = req.body as { email?: string };
    const email = body?.email?.trim();
    if (!email) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'email is required' },
      });
    }
    // Case-insensitive: the admin types what the user told them. The
    // column is unique only case-sensitively, so two accounts may differ
    // in case alone — then refuse rather than reset a random one.
    const matches = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`)
      .limit(2);
    // Several match: the exact spelling picks one; otherwise refuse.
    const user = matches.length > 1 ? matches.find((m) => m.email === email) : matches[0];
    if (matches.length > 1 && !user) {
      return reply.status(409).send({
        error: { code: 'AMBIGUOUS_EMAIL', message: `Several accounts match ${email} when case is ignored — type one of them with its exact capitalisation` },
      });
    }
    if (!user) {
      return reply.status(404).send({
        error: { code: 'USER_NOT_FOUND', message: `No user with email ${email}` },
      });
    }
    const tempPassword = `mb-${randomBytes(9).toString('base64url')}`;
    const passwordHash = await hashPassword(tempPassword);
    await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
    // The panel promises access "stops working immediately": every
    // session and long-lived token of that user ends here (#315).
    await markPasswordChanged(user.id);
    return { email: user.email, tempPassword };
  });
}
