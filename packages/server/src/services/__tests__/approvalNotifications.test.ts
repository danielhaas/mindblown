/**
 * Approval pushes (#493): the batching and reminder rules with the clock
 * injected, driven tick by tick the way the 5-minute timer runs them, and
 * the no-keys path that sends nothing and touches nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbTouched = vi.fn();
vi.mock('../../db/connection.js', () => ({
  db: new Proxy({}, { get: () => { dbTouched(); throw new Error('db must not be read'); } }),
}));

import { approvalPushMessage, planApprovalPush, runApprovalNotifications, type WaitingTicket } from '../approvalNotifications.js';
import { sendPush } from '../../lib/pushover.js';

const MIN = 60 * 1000;
const T0 = new Date('2026-10-29T08:00:00Z').getTime();
const at = (min: number) => new Date(T0 + min * MIN);

/**
 * Run the 5-minute tick from 0 to `untilMin`, with tickets proposed at
 * the given minutes (and still proposed). Returns every push, with the
 * state written after each one — as the service does.
 */
function simulate(proposedAtMin: number[], untilMin: number) {
  let lastPushedAt: Date | null = null;
  const reminded = new Set<string>();
  const pushes: Array<{ min: number; waiting: number; remind: string[] }> = [];
  for (let min = 0; min <= untilMin; min += 5) {
    const waiting: WaitingTicket[] = proposedAtMin
      .map((p, i) => ({ nodeId: `n${i}`, proposedAt: at(p), reminded: reminded.has(`n${i}`) }))
      .filter((w) => w.proposedAt <= at(min));
    const plan = planApprovalPush(at(min), lastPushedAt, waiting);
    if (!plan) continue;
    pushes.push({ min, ...plan });
    lastPushedAt = at(min);
    for (const id of plan.remind) reminded.add(id);
  }
  return pushes;
}

describe('planApprovalPush', () => {
  it('nothing waiting, nothing pushed', () => {
    expect(planApprovalPush(at(60), null, [])).toBeNull();
  });

  it('three tickets within 10 minutes make one push', () => {
    const pushes = simulate([1, 4, 9], 23 * 60);
    expect(pushes).toEqual([{ min: 15, waiting: 3, remind: [] }]);
  });

  it('waits until the first unannounced ticket has settled for 10 minutes', () => {
    const w = [{ nodeId: 'a', proposedAt: at(0), reminded: false }];
    expect(planApprovalPush(at(9), null, w)).toBeNull();
    expect(planApprovalPush(at(10), null, w)).toEqual({ waiting: 1, remind: [] });
  });

  it('at most one push per map per hour; a ticket arriving inside the hour goes out after it', () => {
    const pushes = simulate([0, 20], 23 * 60);
    expect(pushes.map((p) => [p.min, p.waiting])).toEqual([[10, 1], [70, 2]]);
  });

  it('a ticket left for 24 h gets exactly one reminder', () => {
    const pushes = simulate([0], 4 * 24 * 60);
    expect(pushes).toEqual([
      { min: 10, waiting: 1, remind: [] },
      { min: 24 * 60, waiting: 1, remind: ['n0'] },
    ]);
  });

  it('a reminder inside the hour after another push waits for the hour', () => {
    const pushes = simulate([0, 24 * 60 - 20], 3 * 24 * 60);
    expect(pushes.map((p) => [p.min, p.remind])).toEqual([
      [10, []],
      [24 * 60 - 10, []],
      [24 * 60 + 50, ['n0']],
      [2 * 24 * 60 - 20, ['n1']],
    ]);
  });

  it('a restart with the state already written does not re-send', () => {
    const w = [{ nodeId: 'a', proposedAt: at(0), reminded: true }];
    expect(planApprovalPush(at(3 * 24 * 60), at(24 * 60), w)).toBeNull();
  });
});

describe('approvalPushMessage', () => {
  it('names the count and the map, and the reminders', () => {
    expect(approvalPushMessage({ waiting: 2, remind: [] }, 'Navy App')).toBe('2 tickets waiting for approval (Navy App)');
    expect(approvalPushMessage({ waiting: 1, remind: ['a'] }, 'Navy App')).toBe('1 ticket waiting for approval (Navy App) — 1 for over 24 h');
  });
});

describe('without Pushover keys', () => {
  const saved = { token: process.env.PUSHOVER_APP_TOKEN, user: process.env.PUSHOVER_USER_KEY };
  beforeEach(() => {
    delete process.env.PUSHOVER_APP_TOKEN;
    delete process.env.PUSHOVER_USER_KEY;
    dbTouched.mockClear();
  });
  afterEach(() => {
    if (saved.token !== undefined) process.env.PUSHOVER_APP_TOKEN = saved.token;
    if (saved.user !== undefined) process.env.PUSHOVER_USER_KEY = saved.user;
  });

  it('the tick sends nothing, reads nothing and does not fail', async () => {
    await expect(runApprovalNotifications(at(0))).resolves.toEqual({ pushed: 0, errors: [] });
    expect(dbTouched).not.toHaveBeenCalled();
  });

  it('sendPush is a no-op', async () => {
    const fetchImpl = vi.fn();
    await expect(sendPush({ title: 't', message: 'm' }, fetchImpl as unknown as typeof fetch)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('sendPush with keys', () => {
  beforeEach(() => {
    process.env.PUSHOVER_APP_TOKEN = 'tok';
    process.env.PUSHOVER_USER_KEY = 'usr';
  });
  afterEach(() => {
    delete process.env.PUSHOVER_APP_TOKEN;
    delete process.env.PUSHOVER_USER_KEY;
  });

  it('posts token, user, message and link', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"status":1}', { status: 200 }));
    const ok = await sendPush({ title: 'MindBlown', message: '2 tickets', url: 'https://x/?map=m', urlTitle: 'Open' }, fetchImpl as unknown as typeof fetch);
    expect(ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: URLSearchParams }];
    expect(url).toBe('https://api.pushover.net/1/messages.json');
    expect(Object.fromEntries(init.body)).toEqual({ token: 'tok', user: 'usr', title: 'MindBlown', message: '2 tickets', url: 'https://x/?map=m', url_title: 'Open' });
  });

  it('a refused push is false, not a throw', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad token', { status: 400 }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(sendPush({ title: 't', message: 'm' }, fetchImpl as unknown as typeof fetch)).resolves.toBe(false);
  });
});
