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

import { pushKumaHeartbeat, _resetKumaSuppressionForTests } from '../kumaPush.js';

describe('pushKumaHeartbeat', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    _resetKumaSuppressionForTests();
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

  it('suppresses repeated identical failures within a logTag', async () => {
    // Kuma returning the same 404 on every tick (e.g. operator deleted
    // the monitor on Kuma's side) used to spam one warn per tick, every
    // 5 minutes, forever. The helper should warn once then go quiet
    // until the signature changes.
    const fetchMock = vi.fn(
      async (_input: unknown, _init?: unknown) => ({ ok: false, status: 404 }) as Response,
    );
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 5; i += 1) {
      await pushKumaHeartbeat(
        'https://kuma.example/api/push/missing',
        'up',
        `tick ${i}`,
        '[kuma-push] catchup',
      );
    }

    expect(fetchMock).toHaveBeenCalledTimes(5);
    // Only the first 404 logs; the next four are suppressed.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0].join(' ')).toContain('404');
  });

  it('logs a "recovered" line when a previously-failing push starts succeeding', async () => {
    // First two ticks fail with 404, then Kuma comes back. We want a
    // single recovery line in the journal so the operator knows the
    // monitor is healthy again without grepping for missing warns.
    const responses: Array<{ ok: boolean; status: number }> = [
      { ok: false, status: 404 },
      { ok: false, status: 404 },
      { ok: true, status: 200 },
      { ok: true, status: 200 },
    ];
    const fetchMock = vi.fn(async () => responses.shift() as Response);
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 4; i += 1) {
      await pushKumaHeartbeat(
        'https://kuma.example/api/push/recovers',
        'up',
        `tick ${i}`,
        '[kuma-push] catchup',
      );
    }

    // 404 once, recovery once, ok ticks silent → 2 warns total.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0].join(' ')).toContain('404');
    expect(warnSpy.mock.calls[1].join(' ')).toContain('recovered');
  });

  it('logs again when the failure signature changes (404 → 500)', async () => {
    // Distinct failure modes shouldn't be silenced by a previous
    // suppression for a different status code.
    const responses: Array<{ ok: boolean; status: number }> = [
      { ok: false, status: 404 },
      { ok: false, status: 404 },
      { ok: false, status: 500 },
    ];
    const fetchMock = vi.fn(async () => responses.shift() as Response);
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 3; i += 1) {
      await pushKumaHeartbeat(
        'https://kuma.example/api/push/changing',
        'up',
        `tick ${i}`,
        '[kuma-push] catchup',
      );
    }

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0].join(' ')).toContain('404');
    expect(warnSpy.mock.calls[1].join(' ')).toContain('500');
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

  describe('Gatus mode (URL contains /api/v1/endpoints/)', () => {
    const ORIGINAL_TOKEN = process.env.GATUS_PUSH_TOKEN;

    beforeEach(() => {
      process.env.GATUS_PUSH_TOKEN = 'test-bearer-abc';
    });

    afterEach(() => {
      if (ORIGINAL_TOKEN === undefined) delete process.env.GATUS_PUSH_TOKEN;
      else process.env.GATUS_PUSH_TOKEN = ORIGINAL_TOKEN;
    });

    it('POSTs with bearer auth + success=true on status="up"', async () => {
      const fetchMock = vi.fn(
        async (_input: unknown, _init?: unknown) =>
          ({ ok: true, status: 200 }) as Response,
      );
      vi.stubGlobal('fetch', fetchMock);

      await pushKumaHeartbeat(
        'http://gatus.example/api/v1/endpoints/push_foo/external',
        'up',
        'tick ok',
        '[gatus-push] foo',
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(String(calledUrl)).toContain('success=true');
      expect(String(calledUrl)).toContain('duration=');
      // Healthy push must NOT include error=, since Gatus surfaces error
      // text verbatim in the alert body and "tick ok" would land there.
      expect(String(calledUrl)).not.toContain('error=');
      expect(calledInit.method).toBe('POST');
      expect(
        (calledInit.headers as Record<string, string>).Authorization,
      ).toBe('Bearer test-bearer-abc');
    });

    it('POSTs success=false + error=<msg> on status="down"', async () => {
      const fetchMock = vi.fn(
        async (_input: unknown, _init?: unknown) =>
          ({ ok: true, status: 200 }) as Response,
      );
      vi.stubGlobal('fetch', fetchMock);

      await pushKumaHeartbeat(
        'http://gatus.example/api/v1/endpoints/push_foo/external',
        'down',
        'auth check failed: 3 webhooks unauthenticated',
        '[gatus-push] foo',
      );

      const calledUrl = String(fetchMock.mock.calls[0][0]);
      expect(calledUrl).toContain('success=false');
      // msg goes into error= and is URL-encoded.
      expect(calledUrl).toContain(
        'error=auth%20check%20failed%3A%203%20webhooks%20unauthenticated',
      );
    });

    it('omits Authorization header when GATUS_PUSH_TOKEN is unset', async () => {
      delete process.env.GATUS_PUSH_TOKEN;

      const fetchMock = vi.fn(
        async (_input: unknown, _init?: unknown) =>
          ({ ok: true, status: 200 }) as Response,
      );
      vi.stubGlobal('fetch', fetchMock);

      await pushKumaHeartbeat(
        'http://gatus.example/api/v1/endpoints/push_foo/external',
        'up',
        'ok',
        '[gatus-push] foo',
      );

      const calledInit = fetchMock.mock.calls[0][1] as RequestInit;
      const headers = (calledInit.headers as Record<string, string>) ?? {};
      expect(headers.Authorization).toBeUndefined();
    });
  });
});
