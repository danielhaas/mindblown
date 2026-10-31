/**
 * Daily mail with open questions (#597): which items go in, how they are
 * grouped, and once a day — with the clock injected. The DB state
 * (db/digestMails) is an in-memory stand-in with the same once-per-day
 * claim; the inbox and approvals are stubbed per user.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AskRow, PendingApproval } from '@mindblown/core';

const state = vi.hoisted(() => ({
  smtp: true,
  recipients: [] as Array<{ id: string; email: string; name: string; enabled: boolean; lastSentOn: string | null }>,
  maps: {} as Record<string, Array<{ id: string; name: string; archivedAt: string | null }>>,
  fleets: {} as Record<string, Array<{ id: string; name: string }>>,
  asks: {} as Record<string, AskRow[]>,
  approvals: {} as Record<string, PendingApproval[]>,
}));
const sendEmail = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('../../lib/email.js', () => ({
  emailConfigured: () => state.smtp,
  sendEmail,
  escapeHtml: (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}));
vi.mock('../../db/digestMails.js', () => ({
  listDigestRecipients: async () => state.recipients.filter((r) => r.enabled).map(({ enabled: _e, ...r }) => ({ ...r })),
  claimDigestDay: async (userId: string, day: string) => {
    const r = state.recipients.find((x) => x.id === userId)!;
    if (!r.enabled || r.lastSentOn === day) return false;
    r.lastSentOn = day;
    return true;
  },
}));
vi.mock('../../db/maps.js', () => ({ listMapsForUser: async (u: string) => state.maps[u] ?? [] }));
vi.mock('../fleets.js', () => ({ listFleetsForUser: async (u: string) => state.fleets[u] ?? [] }));
vi.mock('../asksInbox.js', () => ({
  fleetInbox: async (u: string, fleetId: string) => ({ items: (state.asks[`${u}|${fleetId}`] ?? []) }),
}));
vi.mock('../approvals.js', () => ({ listPendingApprovals: async (u: string) => ({ items: state.approvals[u] ?? [] }) }));

import {
  askItems,
  approvalItems,
  buildDigestMail,
  digestConfig,
  digestDue,
  groupByMap,
  localDay,
  runDigestMails,
  waitingFor,
  type DigestItem,
} from '../digestMail.js';

const CFG = { hour: 8, timeZone: 'Europe/Zurich' };
// 31.10.2026 is CET (UTC+1): 07:10 UTC = 08:10 Zurich.
const MORNING = new Date('2026-10-31T07:10:00Z');
const EARLY = new Date('2026-10-31T06:50:00Z'); // 07:50 Zurich

function ask(id: string, mapId: string | null, over: Partial<AskRow['ask']> = {}, status: AskRow['status'] = 'open'): AskRow {
  return {
    ask: {
      id,
      ticket: null,
      requirement: null,
      title: `Ticket ${id}`,
      url: null,
      sources: ['worker'],
      question: `Question ${id}?`,
      question_author: null,
      options: [],
      answerer: 'Dan',
      hint: 'decision',
      priority: null,
      milestone: null,
      needs_version: false,
      idle_hours: null,
      unblocks: { node_id: null, node_title: null, node_status: null, claimed_by: null, worker: null, pr: null, pr_state: null },
      moot: false,
      ...over,
    },
    mapId,
    status,
    pushedAt: '2026-10-30T07:00:00Z',
    firstSeenAt: '2026-10-29T07:00:00Z',
    answer: null,
    answeredBy: null,
    answeredAt: null,
    writes: [],
    workerPending: false,
  };
}

function approval(nodeId: string, mapId: string): PendingApproval {
  return {
    mapId,
    mapName: 'ignored',
    nodeId,
    revision: 1,
    title: `Proposed ${nodeId}`,
    approval: { state: 'proposed', at: '2026-10-30T19:10:00Z' },
  } as unknown as PendingApproval;
}

beforeEach(() => {
  sendEmail.mockClear();
  state.smtp = true;
  state.recipients = [{ id: 'u1', email: 'u1@example.com', name: 'U1', enabled: true, lastSentOn: null }];
  state.maps = { u1: [{ id: 'm1', name: 'Alpha', archivedAt: null }, { id: 'm2', name: 'Beta', archivedAt: null }] };
  state.fleets = { u1: [{ id: 'f1', name: 'Fleet' }] };
  state.asks = {};
  state.approvals = {};
});

describe('selection', () => {
  const maps = new Map([['m1', 'Alpha']]);
  const fleet = { id: 'f1', name: 'Fleet' };

  it('keeps open questions on visible maps and fleet-level ones', () => {
    const items = askItems([ask('a', 'm1'), ask('b', null)], maps, fleet);
    expect(items.map((i) => [i.question, i.groupName])).toEqual([
      ['Question a?', 'Alpha'],
      ['Question b?', 'Fleet'],
    ]);
    expect(items[0].url).toContain('?map=m1&view=fleet');
  });

  it('drops answered rows, non-questions and maps the reader cannot view', () => {
    const items = askItems(
      [ask('done', 'm1', {}, 'answered'), ask('decided', 'm1', { hint: 'already-decided' }), ask('parked', 'm1', { hint: 'parked-plan' }), ask('hidden', 'secret')],
      maps,
      fleet,
    );
    expect(items).toEqual([]);
  });

  it('falls back to the blocked node title', () => {
    const [it] = askItems([ask('a', 'm1', { title: null, unblocks: { ...ask('x', null).ask.unblocks, node_title: 'Node T' } })], maps, fleet);
    expect(it.title).toBe('Node T');
  });

  it('approvals: only on visible maps, linked to the approvals card', () => {
    const items = approvalItems([approval('n1', 'm1'), approval('n2', 'secret')], maps);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ groupName: 'Alpha', title: 'Proposed n1', since: '2026-10-30T19:10:00Z' });
    expect(items[0].url).toContain('#approvals');
  });
});

describe('grouping and mail', () => {
  const item = (groupId: string, groupName: string, since: string | null, q = 'Q'): DigestItem => ({ groupId, groupName, question: q, title: 'T', since, url: 'http://x' });

  it('groups by map, maps by name, oldest first', () => {
    const groups = groupByMap([
      item('m2', 'Beta', '2026-10-30T00:00:00Z', 'b1'),
      item('m1', 'Alpha', '2026-10-30T00:00:00Z', 'a-new'),
      item('m1', 'Alpha', '2026-10-20T00:00:00Z', 'a-old'),
    ]);
    expect(groups.map((g) => [g.name, g.items.map((i) => i.question)])).toEqual([
      ['Alpha', ['a-old', 'a-new']],
      ['Beta', ['b1']],
    ]);
  });

  it('says how long an item has waited', () => {
    expect(waitingFor('2026-10-31T07:00:00Z', MORNING)).toBe('under an hour');
    expect(waitingFor('2026-10-30T19:10:00Z', MORNING)).toBe('12 hours');
    expect(waitingFor('2026-10-28T07:10:00Z', MORNING)).toBe('3 days');
    expect(waitingFor(null, MORNING)).toBeNull();
  });

  it('subject counts, body names question, title, wait and link, footer says how to stop', () => {
    const mail = buildDigestMail([item('m1', 'Alpha', '2026-10-28T07:10:00Z', 'Ship <it>?'), item('m2', 'Beta', null)], MORNING);
    expect(mail.subject).toBe('2 open questions in MindBlown');
    expect(buildDigestMail([item('m1', 'Alpha', null)], MORNING).subject).toBe('1 open question in MindBlown');
    expect(mail.html).toContain('Ship &lt;it&gt;?');
    expect(mail.text).toContain('## Alpha');
    expect(mail.text).toContain('T · waiting 3 days');
    expect(mail.text).toContain('http://x');
    expect(mail.text).toContain('To turn it off, open Settings → Daily mail');
    expect(mail.text).toContain('?settings=account');
  });
});

describe('once a day', () => {
  it('due from the hour, once per local day', () => {
    expect(digestDue(EARLY, null, CFG)).toBe(false);
    expect(digestDue(MORNING, null, CFG)).toBe(true);
    expect(digestDue(MORNING, '2026-10-30', CFG)).toBe(true);
    expect(digestDue(MORNING, '2026-10-31', CFG)).toBe(false);
    // 23:30 UTC on the 31st is already 1 November in Zurich.
    expect(localDay(new Date('2026-10-31T23:30:00Z'), 'Europe/Zurich')).toBe('2026-11-01');
  });

  it('config: 08:00 Europe/Zurich unless set', () => {
    expect(digestConfig({})).toEqual({ hour: 8, timeZone: 'Europe/Zurich' });
    expect(digestConfig({ DIGEST_MAIL_HOUR: '6', DIGEST_MAIL_TZ: 'UTC' })).toEqual({ hour: 6, timeZone: 'UTC' });
    expect(digestConfig({ DIGEST_MAIL_HOUR: '25' }).hour).toBe(8);
  });

  it('two open questions: one mail listing both; a second tick the same day sends nothing', async () => {
    state.asks['u1|f1'] = [ask('a', 'm1'), ask('b', 'm2')];
    const first = await runDigestMails(MORNING, CFG);
    expect(first).toMatchObject({ checked: 1, sent: 1, errors: [] });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = (sendEmail.mock.calls[0] as unknown as [{ to: string; subject: string; text: string }])[0];
    expect(mail.to).toBe('u1@example.com');
    expect(mail.subject).toBe('2 open questions in MindBlown');
    expect(mail.text).toContain('Question a?');
    expect(mail.text).toContain('Question b?');

    const second = await runDigestMails(new Date(MORNING.getTime() + 10 * 60_000), CFG);
    expect(second.sent).toBe(0);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // The next morning it goes again.
    await runDigestMails(new Date(MORNING.getTime() + 24 * 3_600_000), CFG);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('counts approvals with the questions', async () => {
    state.asks['u1|f1'] = [ask('a', 'm1')];
    state.approvals.u1 = [approval('n1', 'm2')];
    await runDigestMails(MORNING, CFG);
    const mail = (sendEmail.mock.calls[0] as unknown as [{ subject: string; text: string }])[0];
    expect(mail.subject).toBe('2 open questions in MindBlown');
    expect(mail.text).toContain('Proposed n1');
  });

  it('nothing open: no mail', async () => {
    const r = await runDigestMails(MORNING, CFG);
    expect(r).toMatchObject({ checked: 1, sent: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('an item on a map the user cannot view, or an archived one, never appears', async () => {
    state.maps.u1 = [{ id: 'm1', name: 'Alpha', archivedAt: null }, { id: 'old', name: 'Old', archivedAt: '2026-01-01T00:00:00Z' }];
    state.asks['u1|f1'] = [ask('mine', 'm1'), ask('theirs', 'secret'), ask('archived', 'old')];
    state.approvals.u1 = [approval('n-secret', 'secret')];
    await runDigestMails(MORNING, CFG);
    const mail = (sendEmail.mock.calls[0] as unknown as [{ subject: string; text: string }])[0];
    expect(mail.subject).toBe('1 open question in MindBlown');
    expect(mail.text).not.toContain('theirs');
    expect(mail.text).not.toContain('archived');
    expect(mail.text).not.toContain('n-secret');
  });

  it('before the hour nothing goes', async () => {
    state.asks['u1|f1'] = [ask('a', 'm1')];
    expect(await runDigestMails(EARLY, CFG)).toMatchObject({ checked: 0, sent: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('switched off: no mail', async () => {
    state.recipients[0].enabled = false;
    state.asks['u1|f1'] = [ask('a', 'm1')];
    await runDigestMails(MORNING, CFG);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('no SMTP: nothing sent, nothing fails, the day is not used up', async () => {
    state.smtp = false;
    state.asks['u1|f1'] = [ask('a', 'm1')];
    expect(await runDigestMails(MORNING, CFG)).toEqual({ checked: 0, sent: 0, errors: [] });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(state.recipients[0].lastSentOn).toBeNull();
  });
});
