/**
 * Verifies the AsyncLocalStorage-based per-request API context override
 * actually scopes config to a single async chain — so concurrent HTTP MCP
 * requests don't bleed authorization across users.
 */

import { describe, it, expect } from 'vitest';
import { runWithApiContext, __peekApiContext } from '../api.js';

describe('runWithApiContext', () => {
  it('overrides baseUrl + token for the duration of the callback', async () => {
    const snap = await runWithApiContext(
      { baseUrl: 'http://override.invalid', token: 'mb_test_token_12345' },
      async () => __peekApiContext(),
    );
    expect(snap.baseUrl).toBe('http://override.invalid');
    expect(snap.token).toBe('mb_test_token_12345');
  });

  it('keeps two concurrent contexts isolated from each other', async () => {
    // Force interleaving with an await so AsyncLocalStorage proves it
    // tracks per-chain (not per-call-site) bindings.
    const captureWithDelay = async () => {
      await new Promise((r) => setImmediate(r));
      return __peekApiContext();
    };
    const [a, b] = await Promise.all([
      runWithApiContext({ baseUrl: 'http://a.invalid', token: 'mb_a' }, captureWithDelay),
      runWithApiContext({ baseUrl: 'http://b.invalid', token: 'mb_b' }, captureWithDelay),
    ]);
    expect(a.baseUrl).toBe('http://a.invalid');
    expect(a.token).toBe('mb_a');
    expect(b.baseUrl).toBe('http://b.invalid');
    expect(b.token).toBe('mb_b');
  });

  it('falls back to defaults outside any runWithApiContext call', () => {
    const snap = __peekApiContext();
    expect(snap.baseUrl).not.toBe('http://override.invalid');
  });
});
