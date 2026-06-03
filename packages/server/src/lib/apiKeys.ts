/**
 * API key generation, hashing, and validation.
 *
 * Plaintext format: `mb_<32-char base64url>` (≈ 192 bits of entropy).
 * Only the scrypt hash is persisted — same encoding as the existing
 * password_hash column, so we reuse hashPassword/verifyPassword.
 *
 * Hot-path validation hits a 60s in-memory TTL+FIFO cache keyed on the
 * SHA-256 hash of the plaintext so a Claude Code session firing a
 * dozen tool calls per minute doesn't burn a fresh scrypt verification
 * each time. We also coalesce last_used_at bumps to at most one DB
 * UPDATE per minute per key — without the coalescing, every cache hit
 * still fires a fire-and-forget UPDATE, defeating most of the speedup.
 *
 * Why the SHA-256 hashed Map key (instead of using the plaintext
 * directly)? So a heap dump or accidental `for…of validationCache`
 * iteration over the cache doesn't surface every active key. The scrypt
 * hash in the DB is salted-and-slow precisely to make at-rest secrets
 * useless to an attacker; mirroring that here is cheap.
 *
 * Cache entries are evicted on revoke (via invalidateApiKeyCache) and
 * on TTL expiry. Eviction order under pressure is insertion-order
 * (FIFO — Map preserves insertion order, and cacheGet does not re-insert
 * on hit, so this is TTL+FIFO, not LRU).
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, or, gt } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { apiKeys } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../auth.js';

const KEY_PREFIX_LENGTH = 8;
const PLAINTEXT_BYTES = 24; // 24 bytes → 32 base64url chars
export const API_KEY_PREFIX = 'mb_';
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 1000;
/** How often we permit ourselves to bump last_used_at for a given key. */
const LAST_USED_BUMP_INTERVAL_MS = 60_000;

interface CachedHit {
  userId: string;
  apiKeyId: string;
  expiresAt: number;
}

/**
 * SHA-256 the plaintext before using it as a Map key. Deterministic so
 * cache hits + invalidation still work, but prevents plaintext keys
 * from sitting in memory for the 60s TTL window.
 */
function cacheKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

// Map insertion order is the eviction order; we keep size bounded.
// Keyed on SHA-256(plaintext), NOT plaintext itself.
const validationCache = new Map<string, CachedHit>();

/**
 * Last-seen timestamp per api_keys.id for coalescing last_used_at UPDATEs.
 * Without this, every cache hit fires a DB UPDATE — fast in the happy
 * path, but a per-request slow leak under DB stalls and pointless work.
 */
const lastUsedBumpAt = new Map<string, number>();

/**
 * In-flight bump set: keys currently mid-UPDATE. Concurrent requests for
 * the same api_keys row only schedule one DB write at a time. Cleared
 * in the .then/.catch of the fire-and-forget promise.
 */
const inFlightBumps = new Set<string>();

function cacheGet(plaintext: string): CachedHit | null {
  const k = cacheKey(plaintext);
  const hit = validationCache.get(k);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    validationCache.delete(k);
    return null;
  }
  return hit;
}

function cacheSet(plaintext: string, value: { userId: string; apiKeyId: string }): void {
  if (validationCache.size >= CACHE_MAX_ENTRIES) {
    // Evict the oldest entry (Map preserves insertion order).
    const firstKey = validationCache.keys().next().value;
    if (firstKey !== undefined) validationCache.delete(firstKey);
  }
  validationCache.set(cacheKey(plaintext), {
    ...value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/** Invalidate any cached plaintext lookups bound to a given api_keys row. */
export function invalidateApiKeyCache(apiKeyId: string): void {
  for (const [k, hit] of validationCache.entries()) {
    if (hit.apiKeyId === apiKeyId) validationCache.delete(k);
  }
  // Also drop the bump-coalescing entry so any future cache hit gets a
  // fresh UPDATE rather than incorrectly skipping based on stale state.
  lastUsedBumpAt.delete(apiKeyId);
}

export function clearApiKeyCache(): void {
  validationCache.clear();
  lastUsedBumpAt.clear();
  inFlightBumps.clear();
}

/**
 * Test-only handles into the validation cache. Not part of the public
 * API; the prefix `__` and the `_for_tests` suffix are both load-bearing
 * for readers grep'ing the codebase. Used by the TTL/FIFO suite under
 * src/lib/__tests__/apiKeys.test.ts.
 */
export const __cacheForTests = {
  set(plaintext: string, value: { userId: string; apiKeyId: string }): void {
    cacheSet(plaintext, value);
  },
  get(plaintext: string): CachedHit | null {
    return cacheGet(plaintext);
  },
  size(): number {
    return validationCache.size;
  },
};

/** Generate a fresh plaintext key. NEVER persisted — only its hash is. */
export function generatePlaintextKey(): string {
  return API_KEY_PREFIX + randomBytes(PLAINTEXT_BYTES).toString('base64url');
}

/** First-8 of the plaintext, used as a UI-displayable stub and lookup hint. */
export function prefixOf(plaintext: string): string {
  return plaintext.slice(0, KEY_PREFIX_LENGTH);
}

/**
 * Create a new API key row for the given user.
 * Returns the plaintext (caller must show ONCE) and the row metadata.
 */
export async function createApiKey(
  userId: string,
  name: string,
  expiresInDays?: number,
): Promise<{
  id: string;
  name: string;
  key: string;
  prefix: string;
  createdAt: Date;
  expiresAt: Date | null;
}> {
  const plaintext = generatePlaintextKey();
  const keyHash = await hashPassword(plaintext);
  const keyPrefix = prefixOf(plaintext);
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const [row] = await db
    .insert(apiKeys)
    .values({ userId, name, keyHash, keyPrefix, expiresAt })
    .returning({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      createdAt: apiKeys.createdAt,
      expiresAt: apiKeys.expiresAt,
    });

  return {
    id: row.id,
    name: row.name,
    key: plaintext,
    prefix: row.keyPrefix,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/** List the caller's API keys. Plaintext is NEVER returned — that ship sailed. */
export async function listApiKeysForUser(userId: string): Promise<
  Array<{
    id: string;
    name: string;
    prefix: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
  }>
> {
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.keyPrefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt));
  return rows;
}

/** Soft-revoke a key. Returns true if the key existed AND belongs to the user. */
export async function revokeApiKey(userId: string, apiKeyId: string): Promise<boolean> {
  const result = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, apiKeyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  if (result.length === 0) return false;
  invalidateApiKeyCache(apiKeyId);
  return true;
}

export interface ValidApiKey {
  userId: string;
  apiKeyId: string;
}

/**
 * Validate a plaintext key. Returns { userId, apiKeyId } on success, null on failure.
 *
 * On a cache miss we look up candidate rows by key_prefix (cheap indexed
 * query — multiple matches are rare but possible), scrypt-compare each
 * until we find one that matches a NON-revoked NON-expired row, and
 * fire a best-effort UPDATE to bump last_used_at.
 */
export async function validateApiKey(plaintext: string): Promise<ValidApiKey | null> {
  if (!plaintext.startsWith(API_KEY_PREFIX)) return null;
  if (plaintext.length < API_KEY_PREFIX.length + 16) return null;

  const cached = cacheGet(plaintext);
  if (cached) {
    // Cache hit — still bump last_used_at so dormant-key detection works.
    bumpLastUsed(cached.apiKeyId);
    return { userId: cached.userId, apiKeyId: cached.apiKeyId };
  }

  const prefix = prefixOf(plaintext);
  const now = new Date();
  const candidates = await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      keyHash: apiKeys.keyHash,
    })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.keyPrefix, prefix),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
      ),
    );

  for (const row of candidates) {
    try {
      if (await verifyPassword(plaintext, row.keyHash)) {
        cacheSet(plaintext, { userId: row.userId, apiKeyId: row.id });
        bumpLastUsed(row.id);
        return { userId: row.userId, apiKeyId: row.id };
      }
    } catch {
      // Bad hash format — skip this row.
    }
  }
  return null;
}

function bumpLastUsed(apiKeyId: string): void {
  // Coalesce: at most one DB UPDATE per minute per key. Without this,
  // every cache hit fires a fire-and-forget UPDATE, which (a) defeats
  // the cache's stated job of avoiding DB roundtrips, and (b) is a
  // per-request slow leak when the DB is under stress.
  const now = Date.now();
  const last = lastUsedBumpAt.get(apiKeyId) ?? 0;
  if (now - last < LAST_USED_BUMP_INTERVAL_MS) return;

  // Backpressure: drop the bump if one is already in flight for this
  // key. Concurrent cache hits should NOT pile up DB writes.
  if (inFlightBumps.has(apiKeyId)) return;

  // Mark before the await; release in the .finally so we never strand
  // the inFlightBumps entry on an unhandled rejection.
  lastUsedBumpAt.set(apiKeyId, now);
  inFlightBumps.add(apiKeyId);

  // Fire-and-forget — never block the request hot path on this update.
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, apiKeyId))
    .catch((err) => {
      console.warn('[api-keys] failed to bump last_used_at:', err);
    })
    .finally(() => {
      inFlightBumps.delete(apiKeyId);
    });
}
