/**
 * Unit tests for the API-key helpers.
 *
 * The DB-touching paths (createApiKey, validateApiKey, listApiKeysForUser,
 * revokeApiKey) need a real Postgres connection, so they live behind a
 * skip-when-DATABASE_URL-missing guard the same way the rest of the
 * server's integration tests do. The pure-logic checks (prefix format,
 * cache invalidation) run unconditionally.
 */

import { describe, it, expect } from 'vitest';
import {
  API_KEY_PREFIX,
  generatePlaintextKey,
  prefixOf,
  clearApiKeyCache,
  invalidateApiKeyCache,
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
