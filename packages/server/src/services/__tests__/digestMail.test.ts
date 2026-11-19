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
  recipients: [] as Array<{
    id: string;
    email: string;
    name: string;
    enabled: boolean;
    lastSentOn: string | null;
    failedOn?: string | null;
    failures?: number;
  }>,
  maps: {} as Record<string, Array<{ id: string; name: string; archivedAt: string | null }>>,
  fleets: {} as Record<string, Array<{ id: string; name: string }>>,
  asks: {} as Record<string, AskRow[]>,
  approvals: {} as Record<string, PendingApproval[]>,
  /** map id → bound repo `owner/repo`; absent = no repo. */
  repoOf: {} as Record<string, string>,
  /** `owner/repo` → open PR rows, or an Error the forge throws. */
  prs: {} as Record<string, unknown[] | Error>,
  /** `user|map` → level; absent = admin. */
  role: {} as Record<string, 'view' | 'edit' | 'admin'>,
  /** Repos whose PR list never answers. */
  hang: new Set<string>(),
}));
const forgeCalls = vi.hoisted(() => [] as string[]);
type SendResult = { ok: true } | { ok: false; error: string };
const sendEmail = vi.hoisted(() => vi.fn(async (): Promise<SendResult> => ({ ok: true })));

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
  // Same rule as the SQL: count today's failure, give the day back below the cap.
  releaseDigestDay: async (userId: string, day: string, previous: string | null, max: number) => {
    const r = state.recipients.find((x) => x.id === userId)!;
    r.failures = r.failedOn === day ? (r.failures ?? 0) + 1 : 1;
    r.failedOn = day;
    if (r.failures < max) r.lastSentOn = previous;
    return { attempts: r.failures, released: r.lastSentOn !== day };
  },
}));
vi.mock('../../db/maps.js', () => ({ listMapsForUser: async (u: string) => state.maps[u] ?? [] }));
vi.mock('../fleets.js', () => ({ listFleetsForUser: async (u: string) => state.fleets[u] ?? [] }));
vi.mock('../asksInbox.js', () => ({
  fleetInbox: async (u: string, fleetId: string) => ({ items: (state.asks[`${u}|${fleetId}`] ?? []) }),
}));
vi.mock('../../lib/mapAccess.js', () => ({
  checkMapAccess: async (u: string, mapId: string, level: 'view' | 'edit' | 'admin') => {
    const rank = { view: 1, edit: 2, admin: 3 };
    const has = state.role[`${u}|${mapId}`] ?? 'admin';
    return rank[has] >= rank[level] ? null : { status: 403, code: 'FORBIDDEN', message: level };
  },
}));
vi.mock('../../lib/githubContext.js', () => ({
  getGitHubContextForMap: async (mapId: string) => {
    const full = state.repoOf[mapId];
    if (!full) return null;
    const [owner, repo] = full.split('/');
    return { owner, repo, token: 't', forge: { pullRequestsListPath: (o: string, r: string) => `${o}/${r}` } };
  },
}));
vi.mock('@mindblown/integrations', () => ({
  paginateGitHub: async (path: string, _forge: unknown, opts: { onPage: (rows: unknown[]) => boolean | void; signal?: AbortSignal }) => {
    forgeCalls.push(path);
    // Ignores the signal on purpose: the service's own deadline must still let go.
    if (state.hang.has(path)) return new Promise(() => {});
    const rows = state.prs[path] ?? [];
    if (rows instanceof Error) throw rows;
    opts.onPage(rows);
    return { pages: 1, truncated: false };
  },
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
  newDigestRunCache,
  openItemsForUser,
  runDigestMails,
  stalePrDays,
  stalePrItems,
  waitingFor,
  STALE_PR_FETCH_TIMEOUT_MS,
  DIGEST_MAX_ATTEMPTS,
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
  sendEmail.mockReset();
  sendEmail.mockImplementation(async () => ({ ok: true }));
  state.smtp = true;
  state.recipients = [{ id: 'u1', email: 'u1@example.com', name: 'U1', enabled: true, lastSentOn: null }];
  state.maps = { u1: [{ id: 'm1', name: 'Alpha', archivedAt: null }, { id: 'm2', name: 'Beta', archivedAt: null }] };
  state.fleets = { u1: [{ id: 'f1', name: 'Fleet' }] };
  state.asks = {};
  state.approvals = {};
  state.repoOf = {};
  state.prs = {};
  state.role = {};
  state.hang = new Set();
  forgeCalls.length = 0;
});

function pr(number: number, createdAt: string, over: Record<string, unknown> = {}) {
  return { number, title: `PR title ${number}`, created_at: createdAt, html_url: `https://forge/pr/${number}`, ...over };
}

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

  it('approvals: only on visible maps, linked to the Approvals page', () => {
    const items = approvalItems([approval('n1', 'm1'), approval('n2', 'secret')], maps);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ groupName: 'Alpha', title: 'Proposed n1', since: '2026-10-30T19:10:00Z' });
    expect(items[0].url).toMatch(/\/\?approvals$/);
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
    expect(mail.subject).toBe('2 open items in MindBlown');
    expect(buildDigestMail([item('m1', 'Alpha', null)], MORNING).subject).toBe('1 open item in MindBlown');
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
    expect(mail.subject).toBe('2 open items in MindBlown');
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
    expect(mail.subject).toBe('2 open items in MindBlown');
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
    expect(mail.subject).toBe('1 open item in MindBlown');
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

  it('a failed send is an error, not sent, and the next tick tries again (#602)', async () => {
    state.asks['u1|f1'] = [ask('a', 'm1')];
    sendEmail.mockResolvedValueOnce({ ok: false, error: 'getaddrinfo ENOTFOUND smtp.example' });
    const first = await runDigestMails(MORNING, CFG);
    expect(first.sent).toBe(0);
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]).toContain('user u1');
    expect(first.errors[0]).toContain('ENOTFOUND');
    expect(state.recipients[0].lastSentOn).toBeNull();

    const second = await runDigestMails(new Date(MORNING.getTime() + 10 * 60_000), CFG);
    expect(second).toMatchObject({ sent: 1, errors: [] });
    expect(sendEmail).toHaveBeenCalledTimes(2);

    // Sent: the rest of the day nothing more goes.
    await runDigestMails(new Date(MORNING.getTime() + 20 * 60_000), CFG);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('after DIGEST_MAX_ATTEMPTS failures nothing more is tried that day; tomorrow starts fresh', async () => {
    state.recipients[0].lastSentOn = '2026-10-30';
    state.asks['u1|f1'] = [ask('a', 'm1')];
    sendEmail.mockImplementation(async () => ({ ok: false, error: 'connection refused' }));
    const tick = (min: number) => runDigestMails(new Date(MORNING.getTime() + min * 60_000), CFG);

    for (let i = 0; i < DIGEST_MAX_ATTEMPTS; i++) {
      const r = await tick(i * 10);
      expect(r.sent).toBe(0);
      expect(r.errors).toHaveLength(1);
    }
    expect(sendEmail).toHaveBeenCalledTimes(DIGEST_MAX_ATTEMPTS);
    expect(state.recipients[0].lastSentOn).toBe('2026-10-31');

    expect(await tick(DIGEST_MAX_ATTEMPTS * 10)).toMatchObject({ checked: 0, sent: 0, errors: [] });
    expect(sendEmail).toHaveBeenCalledTimes(DIGEST_MAX_ATTEMPTS);

    // Next morning, with SMTP back: one mail.
    sendEmail.mockImplementation(async () => ({ ok: true }));
    expect(await tick(24 * 60)).toMatchObject({ sent: 1, errors: [] });
    expect(await tick(24 * 60 + 10)).toMatchObject({ sent: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(DIGEST_MAX_ATTEMPTS + 1);
  });

  it('a failure while released keeps the previous day, so the person stays due', async () => {
    state.recipients[0].lastSentOn = '2026-10-30';
    state.asks['u1|f1'] = [ask('a', 'm1')];
    sendEmail.mockResolvedValueOnce({ ok: false, error: 'boom' });
    await runDigestMails(MORNING, CFG);
    expect(state.recipients[0].lastSentOn).toBe('2026-10-30');
  });

  it('no SMTP: nothing sent, nothing fails, the day is not used up', async () => {
    state.smtp = false;
    state.asks['u1|f1'] = [ask('a', 'm1')];
    expect(await runDigestMails(MORNING, CFG)).toEqual({ checked: 0, sent: 0, errors: [] });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(state.recipients[0].lastSentOn).toBeNull();
  });
});

describe('stale pull requests', () => {
  const map = { id: 'm1', name: 'Alpha' };
  const DAY = 86_400_000;
  const ago = (ms: number) => new Date(MORNING.getTime() - ms).toISOString();

  it('builds one item per PR open more than 7 days; drafts and younger PRs left out', () => {
    const items = stalePrItems(
      [pr(499, ago(31 * DAY)), pr(500, ago(3 * DAY)), pr(501, ago(20 * DAY), { draft: true }), pr(502, ago(8 * DAY), { draft: false })],
      map,
      MORNING,
      7,
    );
    expect(items).toEqual([
      {
        groupId: 'm1',
        groupName: 'Alpha',
        question: 'PR #499 has been open 31 days — merge, update or close it?',
        title: 'PR title 499',
        since: ago(31 * DAY),
        url: 'https://forge/pr/499',
      },
      expect.objectContaining({ question: 'PR #502 has been open 8 days — merge, update or close it?' }),
    ]);
  });

  it('7-day boundary: exactly 7 days is not yet stale, a minute more is', () => {
    expect(stalePrItems([pr(1, ago(7 * DAY))], map, MORNING, 7)).toEqual([]);
    const [it] = stalePrItems([pr(1, ago(7 * DAY + 60_000))], map, MORNING, 7);
    expect(it.question).toBe('PR #1 has been open 7 days — merge, update or close it?');
  });

  it('threshold: 7 unless STALE_PR_DAYS says otherwise', () => {
    expect(stalePrDays({})).toBe(7);
    expect(stalePrDays({ STALE_PR_DAYS: '14' })).toBe(14);
    expect(stalePrDays({ STALE_PR_DAYS: '0' })).toBe(7);
    expect(stalePrDays({ STALE_PR_DAYS: 'x' })).toBe(7);
  });

  it('two maps on one repo, two people: the repo is read once per run', async () => {
    state.recipients.push({ id: 'u2', email: 'u2@example.com', name: 'U2', enabled: true, lastSentOn: null });
    state.maps.u2 = [{ id: 'm2', name: 'Beta', archivedAt: null }];
    state.repoOf = { m1: 'dan/app', m2: 'Dan/App' };
    state.prs['dan/app'] = [pr(499, ago(31 * DAY))];
    state.prs['Dan/App'] = [pr(499, ago(31 * DAY))];
    const r = await runDigestMails(MORNING, CFG);
    expect(r).toMatchObject({ sent: 2, errors: [] });
    expect(forgeCalls).toHaveLength(1);
    const mails = sendEmail.mock.calls.map((c) => (c as unknown as [{ subject: string; text: string }])[0]);
    // u1 sees m1 and m2 on the same repo: the PR is listed once.
    expect(mails[0].subject).toBe('1 open item in MindBlown');
    expect(mails[0].text).toContain('PR #499 has been open 31 days');
    expect(mails[1].text).toContain('PR #499 has been open 31 days');
  });

  it('a forge error on one repo keeps the other items', async () => {
    state.repoOf = { m1: 'dan/broken', m2: 'dan/ok' };
    state.prs['dan/broken'] = new Error('401 Bad credentials');
    state.prs['dan/ok'] = [pr(7, ago(10 * DAY))];
    state.asks['u1|f1'] = [ask('a', 'm1')];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await openItemsForUser('u1', MORNING, newDigestRunCache());
    warn.mockRestore();
    expect(items.map((i) => i.question)).toEqual(['Question a?', 'PR #7 has been open 10 days — merge, update or close it?']);
  });

  it('bot-authored PRs are left out (GitHub type Bot, [bot] login, Gitea renovate)', () => {
    const items = stalePrItems(
      [
        pr(1, ago(30 * DAY), { user: { login: 'renovate[bot]', type: 'Bot' } }),
        pr(2, ago(30 * DAY), { user: { login: 'some-app', type: 'Bot' } }),
        pr(3, ago(30 * DAY), { user: { login: 'dependabot[bot]' } }),
        pr(4, ago(30 * DAY), { user: { login: 'Renovate' } }),
        pr(5, ago(30 * DAY), { user: { login: 'dan', type: 'User' } }),
      ],
      map,
      MORNING,
      7,
    );
    expect(items.map((i) => i.title)).toEqual(['PR title 5']);
  });

  it('a repo that never answers is skipped after the deadline; the rest stays', async () => {
    vi.useFakeTimers();
    try {
      state.repoOf = { m1: 'dan/hang', m2: 'dan/ok' };
      state.hang.add('dan/hang');
      state.prs['dan/ok'] = [pr(7, ago(10 * DAY))];
      state.asks['u1|f1'] = [ask('a', 'm1')];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pending = openItemsForUser('u1', MORNING, newDigestRunCache());
      await vi.advanceTimersByTimeAsync(STALE_PR_FETCH_TIMEOUT_MS);
      const items = await pending;
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
      warn.mockRestore();
      expect(items.map((i) => i.question)).toEqual(['Question a?', 'PR #7 has been open 10 days — merge, update or close it?']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('editors who are not admins get no PR items', async () => {
    state.repoOf = { m1: 'dan/app' };
    state.prs['dan/app'] = [pr(1, ago(30 * DAY))];
    state.role['u1|m1'] = 'edit';
    expect(await openItemsForUser('u1', MORNING, newDigestRunCache())).toEqual([]);
    expect(forgeCalls).toEqual([]);
  });

  it('viewers are not asked to merge; archived maps are skipped', async () => {
    state.maps.u1 = [{ id: 'm1', name: 'Alpha', archivedAt: null }, { id: 'old', name: 'Old', archivedAt: '2026-01-01T00:00:00Z' }];
    state.repoOf = { m1: 'dan/app', old: 'dan/old' };
    state.prs['dan/app'] = [pr(1, ago(30 * DAY))];
    state.prs['dan/old'] = [pr(2, ago(30 * DAY))];
    state.role['u1|m1'] = 'view';
    expect(await openItemsForUser('u1', MORNING, newDigestRunCache())).toEqual([]);
    expect(forgeCalls).toEqual([]);
  });
});
