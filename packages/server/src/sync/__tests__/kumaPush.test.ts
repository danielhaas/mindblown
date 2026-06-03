/**
 * Direct tests for `pushKumaHeartbeat`.
 *
 * The helper is already exercised indirectly in `githubCatchup.test.ts`,
 * but those tests mock the helper itself so the swallow-the-fetch-error
 * branch (lines 47–57 in kumaPush.ts) never runs against a thrown fetch.
 * This file stubs `global.fetch` so each failure mode is exercised
 * end-to-end through the real helper code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { pushKumaHeartbeat } from '../kumaPush.js';

describe('pushKumaHeartbeat', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('does not throw when fetch raises a network error, and logs a warn', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      pushKumaHeartbeat(
        'https://kuma.example/api/push/abc',
        'up',
        'test',
        '[kuma-push] test',
      ),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    // The warn message should carry the tag and the underlying error.
    const warnArgs = warnSpy.mock.calls[0].join(' ');
    expect(warnArgs).toContain('[kuma-push] test');
    expect(warnArgs).toContain('fetch failed');
  });

  it('does not throw when fetch raises an AbortError (timeout path), and logs a warn', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => {
      throw new DOMException('timeout', 'AbortError');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      pushKumaHeartbeat(
        'https://kuma.example/api/push/abc',
        'down',
        'timeout-msg',
        '[kuma-push] test',
      ),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('logs a warn (but does not throw) when fetch resolves with a non-2xx status', async () => {
    const fetchMock = vi.fn(
      async (_input: unknown, _init?: unknown) => ({ ok: false, status: 500 }) as Response,
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      pushKumaHeartbeat(
        'https://kuma.example/api/push/abc',
        'up',
        'bad-status',
        '[kuma-push] test',
      ),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    const warnArgs = warnSpy.mock.calls[0].join(' ');
    expect(warnArgs).toContain('[kuma-push] test');
    expect(warnArgs).toContain('500');
  });

  it('does not call fetch when the URL is undefined or empty', async () => {
    // Defence-in-depth guard inside the helper: if a misconfigured
    // caller (or a regressed env-var check) passes an undefined / empty
    // URL through, we must NOT fire a malformed GET — silently no-op
    // instead.
    const fetchMock = vi.fn(
      async (_input: unknown, _init?: unknown) => ({ ok: true, status: 200 }) as Response,
    );
    vi.stubGlobal('fetch', fetchMock);

    await pushKumaHeartbeat(undefined, 'up', 'msg', '[kuma-push] test');
    await pushKumaHeartbeat('', 'up', 'msg', '[kuma-push] test');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('URL-encodes special characters in the msg query param', async () => {
    const fetchMock = vi.fn(
      async (_input: unknown, _init?: unknown) => ({ ok: true, status: 200 }) as Response,
    );
    vi.stubGlobal('fetch', fetchMock);

    await pushKumaHeartbeat(
      'https://kuma.example/api/push/abc',
      'down',
      'errored: foo&bar',
      '[kuma-push] test',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    // `&` inside the msg value must be URL-encoded as %26, otherwise it
    // would break the query string by introducing a spurious key/value
    // boundary. Same goes for the colon (%3A) and space (%20).
    expect(calledUrl).toContain('msg=errored%3A%20foo%26bar');
    // And the status param must remain a clean separate key/value.
    expect(calledUrl).toMatch(/[?&]status=down(&|$)/);
  });
});
