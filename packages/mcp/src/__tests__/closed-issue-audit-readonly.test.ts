/**
 * The MCP surface for the closed-issue audit REPORTS. It never writes.
 *
 * The server route gates the write mode with `requireAdmin`, which
 * deliberately refuses API-key auth. But the HTTP-MCP route mints a
 * loopback session JWT out of the caller's `mb_…` key, so everything
 * arriving through MCP looks like a session and clears that check. That
 * makes `audit_closed_issues` the first admin-gated WRITE reachable from
 * an API key alone — and its write mode reopens tickets in bulk.
 *
 * So the client pins `dryRun: true` on the wire. The tool schema no
 * longer offers the flag either; this test is the backstop for the
 * client, because a schema is easy to widen again by accident.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runWithApiContext } from '../api.js';
import * as api from '../api.js';

describe('auditClosedIssues (MCP client) — read-only on the wire', () => {
  const realFetch = globalThis.fetch;
  let injector: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('no network call expected');
    }) as unknown as typeof fetch;
    injector = vi.fn(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        repo: 'o/r',
        dryRun: true,
        inspected: 0,
        unbacked: 0,
        noClosingPr: 0,
        reopened: 0,
        truncated: false,
        findings: [],
      }),
      headers: { 'content-type': 'application/json' },
    }));
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function sentBody(): Record<string, unknown> {
    return JSON.parse(
      (injector.mock.calls[0][0] as { payload: string }).payload,
    );
  }

  it('sends dryRun: true when nothing was asked for', async () => {
    await runWithApiContext(
      { baseUrl: 'http://unused.invalid', token: 'mb_test', injector },
      () => api.auditClosedIssues('m1', {}),
    );

    expect(sentBody().dryRun).toBe(true);
  });

  it('sends dryRun: true even when the caller explicitly asked for false', async () => {
    await runWithApiContext(
      { baseUrl: 'http://unused.invalid', token: 'mb_test', injector },
      () => api.auditClosedIssues('m1', { dryRun: false }),
    );

    expect(sentBody().dryRun).toBe(true);
  });

  it('still forwards the read-only filters', async () => {
    await runWithApiContext(
      { baseUrl: 'http://unused.invalid', token: 'mb_test', injector },
      () =>
        api.auditClosedIssues('m1', {
          dryRun: false,
          closedBy: 'mindblown-by-project-li[bot]',
          since: '2026-07-01T00:00:00Z',
          limit: 50,
        }),
    );

    expect(sentBody()).toEqual({
      dryRun: true,
      closedBy: 'mindblown-by-project-li[bot]',
      since: '2026-07-01T00:00:00Z',
      limit: 50,
    });
  });
});
