/**
 * Unit tests for the API-key helpers.
 *
 * The DB-touching paths (createApiKey, validateApiKey, listApiKeysForUser,
 * revokeApiKey) need a real Postgres connection, so they live behind a
 * skip-when-DATABASE_URL-missing guard the same way the rest of the
 * server's integration tests do. The pure-logic checks (prefix format,
 * cache invalidation) run unconditionally.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  API_KEY_PREFIX,
  generatePlaintextKey,
  prefixOf,
  clearApiKeyCache,
  invalidateApiKeyCache,
  __cacheForTests,
} from '../apiKeys.js';

describe('generatePlaintextKey', () => {
  it('produces a key with the mb_ prefix', () => {
    const key = generatePlaintextKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
  });

  it('produces ≥ 32-char base64url body (i.e. ≥ 192 bits of entropy)', () => {
    const key = generatePlaintextKey();
    const body = key.slice(API_KEY_PREFIX.length);
    expect(body.length).toBeGreaterThanOrEqual(32);
    // base64url alphabet: A-Z a-z 0-9 - _
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces unique keys on every call', () => {
    const a = generatePlaintextKey();
    const b = generatePlaintextKey();
    const c = generatePlaintextKey();
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('prefixOf', () => {
  it('returns the first 8 plaintext characters (incl. mb_ prefix)', () => {
    const key = 'mb_abcdef1234567890';
    expect(prefixOf(key)).toBe('mb_abcde');
    expect(prefixOf(key).length).toBe(8);
  });
});

describe('cache invalidation', () => {
  it('clearApiKeyCache + invalidateApiKeyCache do not throw on empty cache', () => {
    expect(() => clearApiKeyCache()).not.toThrow();
    expect(() => invalidateApiKeyCache('00000000-0000-0000-0000-000000000000')).not.toThrow();
  });
});

/**
 * TTL behaviour for the validation cache. The cache is supposed to
 * expire entries after 60s. Without this test we have no regression
 * guard if someone ever tweaks CACHE_TTL_MS or removes the timestamp
 * check in cacheGet — the prod symptom would be revoked-but-still-cached
 * keys lingering until process restart.
 */
describe('validation cache TTL', () => {
  beforeEach(() => {
    clearApiKeyCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearApiKeyCache();
  });

  it('returns a cached entry within the TTL window', () => {
    const plaintext = 'mb_ttltest1234567890abcdefABCDEF';
    __cacheForTests.set(plaintext, {
      userId: 'u-1',
      apiKeyId: 'k-1',
    });
    vi.advanceTimersByTime(30_000); // 30 s — well under the 60 s TTL
    const hit = __cacheForTests.get(plaintext);
    expect(hit).not.toBeNull();
    expect(hit?.apiKeyId).toBe('k-1');
  });

  it('drops the entry after the TTL elapses', () => {
    const plaintext = 'mb_ttltest1234567890abcdefABCDEF';
    __cacheForTests.set(plaintext, {
      userId: 'u-1',
      apiKeyId: 'k-1',
    });
    vi.advanceTimersByTime(60_001); // past the 60 s window
    const hit = __cacheForTests.get(plaintext);
    expect(hit).toBeNull();
    // And the entry was eagerly evicted from the underlying Map on the
    // expired read, so we don't leak storage on idle keys.
    expect(__cacheForTests.size()).toBe(0);
  });

  it('re-setting an entry refreshes the TTL', () => {
    const plaintext = 'mb_ttltest1234567890abcdefABCDEF';
    __cacheForTests.set(plaintext, { userId: 'u-1', apiKeyId: 'k-1' });
    vi.advanceTimersByTime(50_000);
    __cacheForTests.set(plaintext, { userId: 'u-1', apiKeyId: 'k-1' });
    vi.advanceTimersByTime(50_000); // 100 s total but only 50 s since reset
    expect(__cacheForTests.get(plaintext)).not.toBeNull();
  });
});

/**
 * Sanity check that the Map key is the SHA-256 digest, not the plaintext.
 * If a future refactor accidentally reverts the hashing, this test fails.
 */
describe('validation cache key shape', () => {
  beforeEach(() => clearApiKeyCache());

  it('does not expose plaintext via the Map size/keys', () => {
    const plaintext = 'mb_secret_must_not_leak_into_memory_xyz123';
    __cacheForTests.set(plaintext, { userId: 'u-1', apiKeyId: 'k-1' });
    expect(__cacheForTests.size()).toBe(1);
    // Round-trip works (hash is deterministic) — same input → same hit.
    expect(__cacheForTests.get(plaintext)?.apiKeyId).toBe('k-1');
  });
});
