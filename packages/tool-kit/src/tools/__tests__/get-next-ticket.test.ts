/**
 * get_next_ticket — MCP surface tests (Leidang pull queue).
 *
 * Pins the zod schema (sessionId required, profile optional/dormant)
 * and the handler's rendering of grants, refusals, and needs-brief
 * skips, so pull-fleet workers see the full self-contained brief.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { getNextTicketTool } from '../orchestration.js';
import type { ToolBackend, GetNextTicketResult } from '../../backend.js';

function makeBackend(result: GetNextTicketResult): {
  backend: ToolBackend;
  calls: Array<{ mapId: string; sessionId: string; profile?: string }>;
} {
  const calls: Array<{ mapId: string; sessionId: string; profile?: string }> = [];
  const backend = {
    getNextTicket: async (mapId: string, sessionId: string, profile?: string) => {
      calls.push({ mapId, sessionId, profile });
      return result;
    },
  } as unknown as ToolBackend;
  return { backend, calls };
}

describe('get_next_ticket schema', () => {
  const schema = z.object(getNextTicketTool.schema);

  it('requires mapId and sessionId; profile is optional', () => {
    expect(() => schema.parse({ mapId: 'm1' })).toThrow();
    expect(schema.parse({ mapId: 'm1', sessionId: 'w1' }).profile).toBeUndefined();
    expect(schema.parse({ mapId: 'm1', sessionId: 'w1', profile: 'heavy' }).profile).toBe('heavy');
  });
});

describe('get_next_ticket handler', () => {
  it('renders the full brief on a grant and forwards all args', async () => {
    const { backend, calls } = makeBackend({
      granted: true,
      active: 3,
      cap: 12,
      ticket: {
        id: 'n1',
        mapId: 'm1',
        text: 'Fix the flaky retry',
        description: 'Steps:\n1. reproduce\n2. fix',
        priority: 'P1',
        priorityRank: 4,
        tags: ['bug'],
        scopes: ['packages/server'],
        versionId: 'v-mvp',
        effortEstimate: 2,
        githubLinks: [{ externalId: 'o/r#7', url: 'https://github.com/o/r/issues/7' }],
        claimedAt: '2026-07-25T10:00:00Z',
      },
      skipped: [],
    });
    const out = await getNextTicketTool.handler(backend, {
      mapId: 'm1',
      sessionId: 'claudia:worker-1:acct1',
      profile: 'standard',
    } as never);
    expect(calls).toEqual([
      { mapId: 'm1', sessionId: 'claudia:worker-1:acct1', profile: 'standard' },
    ]);
    expect(out).toContain('n1');
    expect(out).toContain('Fix the flaky retry');
    expect(out).toContain('Steps:');
    expect(out).toContain('o/r#7');
    expect(out).toContain('3/12');
  });

  it('explains hold / cap / empty refusals', async () => {
    const hold = makeBackend({ granted: false, reason: 'hold', active: 0, cap: 0, skipped: [] });
    expect(await getNextTicketTool.handler(hold.backend, { mapId: 'm1', sessionId: 'w1' } as never)).toContain('hold');

    const cap = makeBackend({ granted: false, reason: 'cap', active: 12, cap: 12, skipped: [] });
    expect(await getNextTicketTool.handler(cap.backend, { mapId: 'm1', sessionId: 'w1' } as never)).toContain('12/12');

    const empty = makeBackend({ granted: false, reason: 'empty', active: 1, cap: 12, skipped: [] });
    expect(await getNextTicketTool.handler(empty.backend, { mapId: 'm1', sessionId: 'w1' } as never)).toContain('No ticket granted');
  });

  it('lists needs-brief skips so the queue starves loudly', async () => {
    const { backend } = makeBackend({
      granted: false,
      reason: 'empty',
      active: 0,
      cap: 12,
      skipped: [{ id: 'n9', text: 'mystery node', reason: 'needs-brief' }],
    });
    const out = await getNextTicketTool.handler(backend, { mapId: 'm1', sessionId: 'w1' } as never);
    expect(out).toContain('needs-brief');
    expect(out).toContain('n9');
    expect(out).toContain('mystery node');
  });
});
