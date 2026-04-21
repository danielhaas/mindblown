import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import { db } from './db/connection.js';
import { users, pendingInvites } from './db/schema.js';
import { eq } from 'drizzle-orm';
import { resolvePendingInvites } from './db/permissions.js';

const scryptAsync = promisify(scrypt);

const JWT_SECRET = process.env.JWT_SECRET ?? 'mindblown-dev-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '7d';

// ── Password hashing ──────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [salt, key] = hash.split(':');
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  const keyBuffer = Buffer.from(key, 'hex');
  return timingSafeEqual(derivedKey, keyBuffer);
}

// ── JWT ───────────────────────────────────────────────────────────

export interface JwtPayload {
  userId: string;
  email: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Mint a long-expiry JWT for headless clients (MCP server, CLI scripts).
 * Same secret and payload shape as a session token, so the normal auth
 * middleware accepts it with no changes — it just lives for a year.
 */
export function signLongLivedToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '365d' });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

// ── Registration policy ──────────────────────────────────────────
//
// Policy lives in system_settings (see db/settings.ts) and is editable via
// the admin UI. Supported modes:
//
//   'open'         — anyone can register
//   'invite_only'  — only emails with a pending map invite can register
//   'allowlist'    — allowlist entries (exact email or "@domain") OR an
//                    existing pending invite can register
//
// Bootstrap escape hatch: if there are ZERO users in the database, the
// first registration is always allowed so you can create the initial
// account on a fresh deploy. That first user also gets is_admin=true.

import { getRegistrationPolicy } from './db/settings.js';

function isAllowlistedEmail(email: string, allowlist: string[]): boolean {
  const lower = email.toLowerCase();
  for (const raw of allowlist) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith('@')) {
      if (lower.endsWith(entry)) return true;
    } else if (entry === lower) {
      return true;
    }
  }
  return false;
}

async function hasPendingInvite(email: string): Promise<boolean> {
  const rows = await db
    .select({ id: pendingInvites.id })
    .from(pendingInvites)
    .where(eq(pendingInvites.email, email.toLowerCase()))
    .limit(1);
  return rows.length > 0;
}

async function canRegister(email: string): Promise<{ ok: boolean; reason?: string }> {
  // Bootstrap: if the users table is empty, the first registration is always
  // allowed (that user becomes the admin).
  const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
  if (!anyUser) return { ok: true };

  const policy = await getRegistrationPolicy();
  switch (policy.mode) {
    case 'open':
      return { ok: true };
    case 'invite_only':
      return (await hasPendingInvite(email))
        ? { ok: true }
        : { ok: false, reason: 'Registration is invite-only. Ask an admin to send you a map invite.' };
    case 'allowlist':
      if (isAllowlistedEmail(email, policy.allowlist)) return { ok: true };
      if (await hasPendingInvite(email)) return { ok: true };
      return {
        ok: false,
        reason: 'Registration is restricted. Ask an admin to add your email to the allowlist, or use an invite link.',
      };
  }
}

// ── Auth Routes ───────────────────────────────────────────────────

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/auth/register ─────────────────────────────────────
  app.post('/api/auth/register', async (req, reply) => {
    const body = req.body as { email?: string; password?: string; name?: string };

    if (!body.email || !body.password) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'email and password are required' },
      });
    }

    // Gate against the DB-backed registration policy.
    const gate = await canRegister(body.email);
    if (!gate.ok) {
      return reply.status(403).send({
        error: {
          code: 'REGISTRATION_CLOSED',
          message: gate.reason ?? 'Registration is closed.',
        },
      });
    }

    const name = body.name ?? body.email.split('@')[0];

    // Check if user already exists
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
    if (existing.length > 0) {
      return reply.status(409).send({
        error: { code: 'USER_EXISTS', message: 'A user with this email already exists' },
      });
    }

    const passwordHash = await hashPassword(body.password);

    // Bootstrap: if this is the first user, promote them to admin.
    const [anyAdmin] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, true))
      .limit(1);
    const isFirstAdmin = !anyAdmin;

    const [user] = await db.insert(users).values({
      email: body.email,
      name,
      passwordHash,
      isAdmin: isFirstAdmin,
    }).returning({
      id: users.id,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
      isAdmin: users.isAdmin,
      createdAt: users.createdAt,
    });

    // Resolve any pending map invites for this email
    const resolved = await resolvePendingInvites(user.email, user.id);
    if (resolved > 0) {
      console.log(`[auth] Resolved ${resolved} pending invite(s) for ${user.email}`);
    }

    const token = signToken({ userId: user.id, email: user.email });

    return reply.status(201).send({ user, token });
  });

  // ── POST /api/auth/login ───────────────────────────────────────
  app.post('/api/auth/login', async (req, reply) => {
    const body = req.body as { email?: string; password?: string };

    if (!body.email || !body.password) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'email and password are required' },
      });
    }

    const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);

    if (!user || !user.passwordHash) {
      return reply.status(401).send({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      });
    }

    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      });
    }

    // Resolve any pending map invites for this email
    const resolved = await resolvePendingInvites(user.email, user.id);
    if (resolved > 0) {
      console.log(`[auth] Resolved ${resolved} pending invite(s) for ${user.email}`);
    }

    const token = signToken({ userId: user.id, email: user.email });

    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        isAdmin: user.isAdmin,
        createdAt: user.createdAt,
      },
      token,
    });
  });

  // ── POST /api/auth/long-lived-token ───────────────────────────
  // Mint a 1-year JWT for the caller — intended for the MCP server and
  // other headless clients. Caller must already be authed via session
  // JWT (you can't trade one long-lived token for another).
  app.post('/api/auth/long-lived-token', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
    }
    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) {
      return reply.status(404).send({
        error: { code: 'USER_NOT_FOUND', message: 'User not found' },
      });
    }
    const token = signLongLivedToken({ userId: user.id, email: user.email });
    return reply.send({ token });
  });

  // ── GET /api/auth/me ───────────────────────────────────────────
  app.get('/api/auth/me', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;

    if (!userId) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
    }

    const [user] = await db.select({
      id: users.id,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
      isAdmin: users.isAdmin,
      createdAt: users.createdAt,
    }).from(users).where(eq(users.id, userId)).limit(1);

    if (!user) {
      return reply.status(404).send({
        error: { code: 'USER_NOT_FOUND', message: 'User not found' },
      });
    }

    return reply.send(user);
  });
}
