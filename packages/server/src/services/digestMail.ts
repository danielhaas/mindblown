/**
 * Daily mail with open questions (#597) and stale pull requests.
 *
 * Once a day, at a fixed local hour (DIGEST_MAIL_HOUR, default 8, in
 * DIGEST_MAIL_TZ, default Europe/Zurich), each person gets one mail listing
 * what waits for them: the open rows of the asks inbox (what the Questions
 * card on the Fleet tab shows — worker asks, blockers, derived asks) and
 * the tickets waiting for approval, on maps they can view — plus the PRs
 * open longer than STALE_PR_DAYS (default 7, bots and drafts left out) on
 * the repo of each map they administer (#499 sat open a month because
 * nothing outside the fleet loop looked at it) — and, per map they
 * administer, one plan-hygiene line from the daily self-check (lint/daily.ts):
 * "Navy App: 24 without estimate, 3 oversized", linking to the map's lint
 * panel. Nothing open and no hygiene line, no mail.
 * Fleet service users get none; a person can switch it off
 * (routes/digestMail.ts).
 *
 * The first tick at or after the hour takes the day per person
 * (db/digestMails claimDigestDay) — a second tick or a restart that day
 * sends nothing, and a question arriving later waits for tomorrow's mail.
 * A send that fails gives the day back (releaseDigestDay) so the next tick
 * tries again, up to DIGEST_MAX_ATTEMPTS per day (#602).
 * Without SMTP_HOST the round does nothing.
 */
import { isNoQuestion, lintDigestLine } from '@mindblown/core';
import type { AskRow, LintRun, PendingApproval } from '@mindblown/core';
import { paginateGitHub } from '@mindblown/integrations';
import * as digestDb from '../db/digestMails.js';
import * as mapDb from '../db/maps.js';
import * as lintRunsDb from '../db/lintRuns.js';
import { emailConfigured, escapeHtml, sendEmail } from '../lib/email.js';
import { getGitHubContextForMap, type ForgeMapContext } from '../lib/githubContext.js';
import { checkMapAccess } from '../lib/mapAccess.js';
import { listPendingApprovals } from './approvals.js';
import { fleetInbox } from './asksInbox.js';
import { listFleetsForUser } from './fleets.js';
import { waitingMaps } from '../lib/waitingMaps.js';
import { localDay, localHour } from '../lib/localDay.js';

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5180';

export interface DigestConfig {
  /** Local hour (0–23) from which the day's mail goes out. */
  hour: number;
  timeZone: string;
}

export function digestConfig(env: NodeJS.ProcessEnv = process.env): DigestConfig {
  const hour = Number.parseInt(env.DIGEST_MAIL_HOUR ?? '', 10);
  return {
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 8,
    timeZone: env.DIGEST_MAIL_TZ || 'Europe/Zurich',
  };
}

export { localDay, localHour };

/** Is today's mail still to go for someone last sent on `lastSentOn`? Pure; the clock comes in as `now`. */
export function digestDue(now: Date, lastSentOn: string | null, cfg: DigestConfig): boolean {
  return localHour(now, cfg.timeZone) >= cfg.hour && lastSentOn !== localDay(now, cfg.timeZone);
}

/** One line of the mail. */
export interface DigestItem {
  /** The map, or `fleet:<id>` for a fleet-level question. */
  groupId: string;
  groupName: string;
  question: string;
  title: string | null;
  /** Waiting since (ISO); null = unknown. */
  since: string | null;
  url: string;
}

const fleetTab = (mapId: string) => `${FRONTEND_URL}/?map=${mapId}&view=fleet`;

/**
 * The open questions of one fleet inbox the reader may see: open, a real
 * question (not already-decided / parked), on a live map in `maps` — or
 * fleet-level, which the inbox only hands to readers of every map.
 */
export function askItems(rows: AskRow[], maps: Map<string, string>, fleet: { id: string; name: string }): DigestItem[] {
  const out: DigestItem[] = [];
  for (const r of rows) {
    if (r.status !== 'open' || isNoQuestion(r.ask)) continue;
    const mapId = r.mapId ?? null;
    if (mapId && !maps.has(mapId)) continue;
    out.push({
      groupId: mapId ?? `fleet:${fleet.id}`,
      groupName: mapId ? maps.get(mapId)! : fleet.name,
      question: r.ask.question,
      title: r.ask.title ?? r.ask.unblocks.node_title,
      since: r.firstSeenAt ?? null,
      url: mapId ? fleetTab(mapId) : (r.ask.url ?? `${FRONTEND_URL}/`),
    });
  }
  return out;
}

/** Tickets waiting for approval on a live map in `maps`. */
export function approvalItems(list: PendingApproval[], maps: Map<string, string>): DigestItem[] {
  return list
    .filter((p) => maps.has(p.mapId))
    .map((p) => ({
      groupId: p.mapId,
      groupName: maps.get(p.mapId)!,
      question: 'Approve this ticket?',
      title: p.title,
      since: p.approval.at ?? null,
      url: `${FRONTEND_URL}/?approvals`,
    }));
}

const DAY_MS = 86_400_000;

/** Days a PR may stay open before the mail names it (env STALE_PR_DAYS, default 7). */
export function stalePrDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.STALE_PR_DAYS ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : 7;
}

/** The fields of an open PR (GitHub and Gitea list rows) the mail needs. */
export interface OpenPrRow {
  number: number;
  title: string;
  created_at: string;
  html_url: string;
  draft?: boolean;
  /** GitHub sets `type: 'Bot'` for app accounts; Gitea has no type. */
  user?: { login?: string; type?: string } | null;
}

/** Bot accounts that run as plain users on Gitea (no `type` there). */
const BOT_LOGINS = new Set(['renovate', 'renovate-bot', 'dependabot']);

/** Dependency bots open PRs nobody owns; the mail does not chase them. */
export function isBotPr(pr: OpenPrRow): boolean {
  const login = pr.user?.login?.toLowerCase() ?? '';
  return pr.user?.type === 'Bot' || login.endsWith('[bot]') || BOT_LOGINS.has(login);
}

/** Open, non-draft, human-authored PRs created more than `days` days before `now`, as items of `map`. */
export function stalePrItems(prs: OpenPrRow[], map: { id: string; name: string }, now: Date, days: number): DigestItem[] {
  const out: DigestItem[] = [];
  for (const pr of prs) {
    if (pr.draft === true || isBotPr(pr)) continue;
    const ageMs = now.getTime() - Date.parse(pr.created_at);
    if (!(ageMs > days * DAY_MS)) continue;
    const age = Math.floor(ageMs / DAY_MS);
    out.push({
      groupId: map.id,
      groupName: map.name,
      question: `PR #${pr.number} has been open ${age} days — merge, update or close it?`,
      title: pr.title,
      since: pr.created_at,
      url: pr.html_url,
    });
  }
  return out;
}

/** Pages of open PRs read per repo (oldest first, so the stale ones come first). */
const STALE_PR_MAX_PAGES = 2;
/**
 * Deadline for one repo's whole PR walk. Recipients go one after another,
 * so a forge that hangs (a Gitea mid-reboot) must not hold up the run.
 */
export const STALE_PR_FETCH_TIMEOUT_MS = 15_000;

/**
 * One digest run's forge reads, shared by every recipient: each map's
 * binding is resolved once and each repo listed once, however many maps
 * bind it and however many people share those maps. A failed read is
 * remembered as `null` — logged once, skipped for everyone.
 */
export interface DigestRunCache {
  contexts: Map<string, Promise<ForgeMapContext | null>>;
  repos: Map<string, Promise<OpenPrRow[] | null>>;
}

export function newDigestRunCache(): DigestRunCache {
  return { contexts: new Map(), repos: new Map() };
}

async function fetchOpenPrs(ctx: ForgeMapContext): Promise<OpenPrRow[]> {
  const rows: OpenPrRow[] = [];
  const ac = new AbortController();
  const timer = setTimeout(
    () => ac.abort(new Error(`timed out after ${STALE_PR_FETCH_TIMEOUT_MS / 1000} s`)),
    STALE_PR_FETCH_TIMEOUT_MS,
  );
  // The race backs up the signal: a request that ignores it still lets go.
  const aborted = new Promise<never>((_, reject) => {
    ac.signal.addEventListener('abort', () => reject(ac.signal.reason));
  });
  try {
    await Promise.race([
      paginateGitHub<OpenPrRow>(
        ctx.forge.pullRequestsListPath(ctx.owner, ctx.repo, { state: 'open', sort: 'created', direction: 'asc', perPage: 100 }),
        ctx.forge,
        {
          maxPages: STALE_PR_MAX_PAGES,
          signal: ac.signal,
          onPage: (page) => {
            rows.push(...page);
            return page.length > 0;
          },
        },
      ),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
  }
  return rows;
}

function mapContext(cache: DigestRunCache, mapId: string): Promise<ForgeMapContext | null> {
  let p = cache.contexts.get(mapId);
  if (!p) {
    p = getGitHubContextForMap(mapId).catch((err) => {
      console.warn(`[digest-mail] map ${mapId}: forge binding failed, PRs skipped: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    cache.contexts.set(mapId, p);
  }
  return p;
}

const repoKey = (ctx: ForgeMapContext) => `${ctx.owner}/${ctx.repo}`.toLowerCase();

function repoPrs(cache: DigestRunCache, ctx: ForgeMapContext): Promise<OpenPrRow[] | null> {
  const key = repoKey(ctx);
  let p = cache.repos.get(key);
  if (!p) {
    p = fetchOpenPrs(ctx).catch((err) => {
      console.warn(`[digest-mail] ${key}: open PR list failed, skipped: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    cache.repos.set(key, p);
  }
  return p;
}

/**
 * Stale PRs on the repos of the live maps this person administers. Only
 * owners/admins: one dead PR should nag the people who decide about it,
 * not every editor every day. A repo bound by several of
 * their maps is listed once, under the first of them.
 */
async function stalePrItemsForUser(
  userId: string,
  liveMaps: Array<{ id: string; name: string }>,
  now: Date,
  cache: DigestRunCache,
): Promise<DigestItem[]> {
  const days = stalePrDays();
  const seen = new Set<string>();
  const items: DigestItem[] = [];
  for (const m of liveMaps) {
    if (await checkMapAccess(userId, m.id, 'admin')) continue;
    const ctx = await mapContext(cache, m.id);
    if (!ctx || seen.has(repoKey(ctx))) continue;
    seen.add(repoKey(ctx));
    const prs = await repoPrs(cache, ctx);
    if (prs) items.push(...stalePrItems(prs, m, now, days));
  }
  return items;
}

/** One map's plan-hygiene line from its newest daily check. */
export interface HygieneLine {
  mapId: string;
  mapName: string;
  line: string;
  url: string;
}

/** A run older than this says nothing about today's map. */
const HYGIENE_MAX_AGE_MS = 2 * DAY_MS;

/** The hygiene lines of these runs (maps by name), runs older than two days left out. */
export function hygieneLines(runs: LintRun[], maps: Map<string, string>, now: Date): HygieneLine[] {
  const out: HygieneLine[] = [];
  for (const run of runs) {
    const name = maps.get(run.mapId);
    if (!name || run.error || now.getTime() - Date.parse(run.ranAt) > HYGIENE_MAX_AGE_MS) continue;
    const line = lintDigestLine(run.digest);
    if (line) out.push({ mapId: run.mapId, mapName: name, line, url: `${FRONTEND_URL}/?map=${run.mapId}&lint=1` });
  }
  return out.sort((a, b) => a.mapName.localeCompare(b.mapName));
}

/** Hygiene lines for the live maps this person administers — the people who decide about the plan, like stale PRs. */
export async function hygieneForUser(userId: string, now: Date = new Date()): Promise<HygieneLine[]> {
  const liveMaps = waitingMaps(await mapDb.listMapsForUser(userId));
  const mine: Array<{ id: string; name: string }> = [];
  for (const m of liveMaps) if (!(await checkMapAccess(userId, m.id, 'admin'))) mine.push(m);
  if (mine.length === 0) return [];
  const runs = await lintRunsDb.latestRuns(mine.map((m) => m.id));
  return hygieneLines([...runs.values()], new Map(mine.map((m) => [m.id, m.name])), now);
}

export interface DigestGroup {
  name: string;
  items: DigestItem[];
}

/** By map, maps by name, oldest item first. */
export function groupByMap(items: DigestItem[]): DigestGroup[] {
  const groups = new Map<string, DigestGroup>();
  for (const it of items) {
    const g = groups.get(it.groupId) ?? { name: it.groupName, items: [] };
    g.items.push(it);
    groups.set(it.groupId, g);
  }
  const at = (it: DigestItem) => (it.since ? Date.parse(it.since) : Number.POSITIVE_INFINITY);
  return [...groups.values()]
    .map((g) => ({ ...g, items: [...g.items].sort((a, b) => at(a) - at(b)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function waitingFor(since: string | null, now: Date): string | null {
  if (!since) return null;
  const hours = Math.floor((now.getTime() - Date.parse(since)) / 3_600_000);
  if (!Number.isFinite(hours)) return null;
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `${Math.floor(hours / 24)} days`;
}

export function buildDigestMail(items: DigestItem[], now: Date, hygiene: HygieneLine[] = []): { subject: string; html: string; text: string } {
  const n = items.length;
  const subject = n > 0 ? `${n} open ${n === 1 ? 'item' : 'items'} in MindBlown` : 'Plan hygiene in MindBlown';
  const settingsUrl = `${FRONTEND_URL}/?settings=account`;
  const groups = groupByMap(items);

  const textLines: string[] = [subject, ''];
  const htmlGroups: string[] = [];
  for (const g of groups) {
    textLines.push(`## ${g.name}`);
    const lis: string[] = [];
    for (const it of g.items) {
      const wait = waitingFor(it.since, now);
      const meta = [it.title, wait ? `waiting ${wait}` : null].filter(Boolean).join(' · ');
      textLines.push(`- ${it.question}`, ...(meta ? [`  ${meta}`] : []), `  ${it.url}`);
      lis.push(
        `<li style="margin:0 0 14px;">` +
          `<div style="font-size:14px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(it.question)}</div>` +
          (meta ? `<div style="font-size:12px;color:#64748b;margin-top:2px;">${escapeHtml(meta)}</div>` : '') +
          `<a href="${escapeHtml(it.url)}" style="font-size:12px;color:#4f46e5;">Open</a>` +
          `</li>`,
      );
    }
    textLines.push('');
    htmlGroups.push(
      `<h2 style="margin:24px 0 10px;font-size:15px;font-weight:700;">${escapeHtml(g.name)}</h2>` +
        `<ul style="margin:0;padding-left:18px;">${lis.join('')}</ul>`,
    );
  }
  if (hygiene.length > 0) {
    textLines.push('## Plan hygiene');
    for (const h of hygiene) textLines.push(`- ${h.mapName}: ${h.line}`, `  ${h.url}`);
    textLines.push('');
    htmlGroups.push(
      `<h2 style="margin:24px 0 10px;font-size:15px;font-weight:700;">Plan hygiene</h2>` +
        `<ul style="margin:0;padding-left:18px;">` +
        hygiene
          .map(
            (h) =>
              `<li style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>${escapeHtml(h.mapName)}:</strong> ${escapeHtml(h.line)} ` +
              `<a href="${escapeHtml(h.url)}" style="font-size:12px;color:#4f46e5;">Open</a></li>`,
          )
          .join('') +
        `</ul>`,
    );
  }
  const footer = 'You get this mail once a day while questions, pull requests or plan hygiene in MindBlown wait for you. To turn it off, open Settings → Daily mail';
  textLines.push('--', `${footer}: ${settingsUrl}`);

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:32px 16px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1e293b;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px 28px;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
    <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;">${escapeHtml(subject)}</h1>
    ${htmlGroups.join('\n    ')}
    <p style="margin:28px 0 0;font-size:11px;color:#94a3b8;">${escapeHtml(footer)}: <a href="${escapeHtml(settingsUrl)}" style="color:#94a3b8;">${escapeHtml(settingsUrl)}</a></p>
  </div>
</body>
</html>`;
  return { subject, html, text: textLines.join('\n') };
}

/**
 * Everything open for this person, on the maps they can view (archived
 * maps left out). `cache` shares forge reads across one run's recipients.
 */
export async function openItemsForUser(
  userId: string,
  now: Date = new Date(),
  cache: DigestRunCache = newDigestRunCache(),
): Promise<DigestItem[]> {
  const liveMaps = waitingMaps(await mapDb.listMapsForUser(userId));
  const live = new Map(liveMaps.map((m) => [m.id, m.name]));
  const items: DigestItem[] = [];
  for (const fleet of await listFleetsForUser(userId)) {
    const inbox = await fleetInbox(userId, fleet.id, { status: 'open' });
    if ('status' in inbox) continue;
    items.push(...askItems(inbox.items, live, fleet));
  }
  const approvals = await listPendingApprovals(userId, {});
  if (!('status' in approvals)) items.push(...approvalItems(approvals.items, live));
  items.push(...(await stalePrItemsForUser(userId, liveMaps, now, cache)));
  return items;
}

/** Sends tried per person and day before a failing mail waits for tomorrow (#602). */
export const DIGEST_MAX_ATTEMPTS = 3;

export interface DigestRunResult {
  checked: number;
  sent: number;
  errors: string[];
}

/** One tick (timer in index.ts): today's mail to every person it is due for. */
export async function runDigestMails(now: Date = new Date(), cfg: DigestConfig = digestConfig()): Promise<DigestRunResult> {
  const out: DigestRunResult = { checked: 0, sent: 0, errors: [] };
  if (!emailConfigured() || localHour(now, cfg.timeZone) < cfg.hour) return out;
  const day = localDay(now, cfg.timeZone);
  const cache = newDigestRunCache();
  for (const r of await digestDb.listDigestRecipients()) {
    if (!digestDue(now, r.lastSentOn, cfg)) continue;
    try {
      const items = await openItemsForUser(r.id, now, cache);
      // Best effort: without the daily check's runs the mail still goes.
      const hygiene = await hygieneForUser(r.id, now).catch(() => []);
      // Taken even when nothing is open: the day's round is done for them.
      if (!(await digestDb.claimDigestDay(r.id, day))) continue;
      out.checked++;
      if (items.length === 0 && hygiene.length === 0) continue;
      const res = await sendEmail({ to: r.email, ...buildDigestMail(items, now, hygiene) });
      if (res.ok) {
        out.sent++;
        continue;
      }
      const { attempts, released } = await digestDb.releaseDigestDay(r.id, day, r.lastSentOn, DIGEST_MAX_ATTEMPTS);
      out.errors.push(
        `user ${r.id}: send failed (attempt ${attempts}/${DIGEST_MAX_ATTEMPTS}${released ? ', retry next tick' : ', giving up for today'}): ${res.error}`,
      );
    } catch (err) {
      out.errors.push(`user ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
