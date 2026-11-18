import { describe, it, expect, vi } from 'vitest';
import type { FleetWaitingOnHumans, WaitingOnHumansResult } from '@mindblown/core';
import type { ToolBackend } from '../../backend.js';
import { renderWaitingOnHumans, waitingOnHumansTool } from '../waitingOnHumans.js';
import { allTools } from '../../index.js';

const fleet = (over: Partial<FleetWaitingOnHumans> = {}): FleetWaitingOnHumans => ({
  fleetId: 'f1',
  fleetName: 'claudia',
  idle: true,
  idleSince: '2026-11-18T09:30:00.000Z',
  activeClaims: 0,
  hostsReporting: 1,
  workers: { total: 6, working: 0, waiting: 6 },
  total: { decisions: 1, steps: 0, prs: 1, approvals: 0, unblocks: 2 },
  people: [
    {
      person: 'Dan', decisions: 1, steps: 0, prs: 1, approvals: 0, unblocks: 2,
      top: {
        decisions: [{ kind: 'decision', person: 'Dan', ref: '#6823', title: 'Pick the DB', mapId: 'm1', nodeId: 'n1', since: '2026-11-17T00:00:00Z', url: null }],
        steps: [],
        prs: [{ kind: 'pr', person: 'Dan', ref: 'acme/app#42', title: 'Ship it', mapId: 'm1', nodeId: 'n2', since: null, url: null }],
        approvals: [],
      },
    },
  ],
  ...over,
});

describe('waiting_on_humans', () => {
  it('is registered and passes the fleet id through', async () => {
    expect(allTools.some((t) => t.name === 'waiting_on_humans')).toBe(true);
    const res: WaitingOnHumansResult = { fleets: [fleet()], now: 'x' };
    const backend = { waitingOnHumans: vi.fn(async () => res) } as unknown as ToolBackend;
    await waitingOnHumansTool.handler(backend, { fleetId: 'f1' } as never);
    expect(backend.waitingOnHumans).toHaveBeenCalledWith('f1');
    await waitingOnHumansTool.handler(backend, {} as never);
    expect(backend.waitingOnHumans).toHaveBeenLastCalledWith(undefined);
  });

  it('says idle since when, the counts per person and the ids of the top items', () => {
    const out = renderWaitingOnHumans({ fleets: [fleet()], now: 'x' });
    expect(out).toContain('1 of 1 fleet(s) idle and waiting on a person.');
    expect(out).toContain('claudia (id: f1) — IDLE since 2026-11-18 09:30');
    expect(out).toContain('### Dan: 1 decisions, 0 steps, 1 PRs, 0 approvals — unblocks 2');
    expect(out).toContain('- #6823 Pick the DB · node n1 · since 2026-11-17');
    expect(out).toContain('- acme/app#42 Ship it · node n2');
  });

  it('a working fleet and one with nothing waiting', () => {
    const out = renderWaitingOnHumans({ fleets: [fleet({ idle: false, idleSince: null, people: [] })], now: 'x' });
    expect(out).toContain('none idle waiting on a person');
    expect(out).toContain('— working');
    expect(out).toContain('Nothing waits on a person.');
  });
});
