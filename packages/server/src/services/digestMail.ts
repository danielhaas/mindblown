/**
 * Daily mail with open questions (#597).
 *
 * Once a day, at a fixed local hour (DIGEST_MAIL_HOUR, default 8, in
 * DIGEST_MAIL_TZ, default Europe/Zurich), each person gets one mail listing
 * what waits for them: the open rows of the asks inbox (what the Questions
 * card on the Fleet tab shows — worker asks, blockers, derived asks) and
 * the tickets waiting for approval, on maps they can view. Nothing open,
 * no mail. Fleet service users get none; a person can switch it off
 * (routes/digestMail.ts).
 *
 * The first tick at or after the hour takes the day per person
 * (db/digestMails claimDigestDay) — a second tick or a restart that day
 * sends nothing, and a question arriving later waits for tomorrow's mail.
 * Without SMTP_HOST the round does nothing.
 */
import { isNoQuestion } from '@mindblown/core';
import type { AskRow, PendingApproval } from '@mindblown/core';
import * as digestDb from '../db/digestMails.js';
import * as mapDb from '../db/maps.js';
import { emailConfigured, escapeHtml, sendEmail } from '../lib/email.js';
import { listPendingApprovals } from './approvals.js';
import { fleetInbox } from './asksInbox.js';
import { listFleetsForUser } from './fleets.js';

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

/** The calendar day at `now` in `timeZone`, as YYYY-MM-DD. */
export function localDay(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function localHour(now: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));
}

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

const fleetTab = (mapId: string, hash = '') => `${FRONTEND_URL}/?map=${mapId}&view=fleet${hash}`;

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
      url: fleetTab(p.mapId, '#approvals'),
    }));
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

export function buildDigestMail(items: DigestItem[], now: Date): { subject: string; html: string; text: string } {
  const n = items.length;
  const subject = `${n} open ${n === 1 ? 'question' : 'questions'} in MindBlown`;
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
  const footer = 'You get this mail once a day while questions in MindBlown wait for you. To turn it off, open Settings → Daily mail';
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

/** Everything open for this person, on the maps they can view (archived maps left out). */
export async function openItemsForUser(userId: string): Promise<DigestItem[]> {
  const live = new Map((await mapDb.listMapsForUser(userId)).filter((m) => !m.archivedAt).map((m) => [m.id, m.name]));
  const items: DigestItem[] = [];
  for (const fleet of await listFleetsForUser(userId)) {
    const inbox = await fleetInbox(userId, fleet.id, { status: 'open' });
    if ('status' in inbox) continue;
    items.push(...askItems(inbox.items, live, fleet));
  }
  const approvals = await listPendingApprovals(userId, {});
  if (!('status' in approvals)) items.push(...approvalItems(approvals.items, live));
  return items;
}

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
  for (const r of await digestDb.listDigestRecipients()) {
    if (!digestDue(now, r.lastSentOn, cfg)) continue;
    try {
      const items = await openItemsForUser(r.id);
      // Taken even when nothing is open: the day's round is done for them.
      if (!(await digestDb.claimDigestDay(r.id, day))) continue;
      out.checked++;
      if (items.length === 0) continue;
      await sendEmail({ to: r.email, ...buildDigestMail(items, now) });
      out.sent++;
    } catch (err) {
      out.errors.push(`user ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
