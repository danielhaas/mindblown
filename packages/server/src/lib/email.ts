/**
 * Transactional email over SMTP via nodemailer. Fires-and-forgets from the
 * caller's perspective — errors are logged, never propagated — so share
 * flows are never blocked by the mail server. When SMTP_HOST is unset
 * (dev), logs what would have been sent and skips the connection.
 */

import { eq } from 'drizzle-orm';
import nodemailer, { type Transporter } from 'nodemailer';
import { db } from '../db/connection.js';
import { users, maps } from '../db/schema.js';

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
// `secure: true` is implicit TLS (port 465). Everything else (587, 25) uses
// STARTTLS, which nodemailer negotiates automatically. Override with
// SMTP_SECURE=true/false if your server is unusual.
const SMTP_SECURE = process.env.SMTP_SECURE
  ? process.env.SMTP_SECURE === 'true'
  : SMTP_PORT === 465;

const MAIL_FROM = process.env.MAIL_FROM ?? 'MindBlown <noreply@project.li>';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5180';

let transporter: Transporter | null = null;
if (SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  console.log(`[email] SMTP transport ready (${SMTP_HOST}:${SMTP_PORT}, secure=${SMTP_SECURE})`);
}

// ── Low-level sender ──────────────────────────────────────────────

export interface EmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(input: EmailInput): Promise<void> {
  if (!transporter) {
    console.log(
      `[email] (dev mode, no SMTP_HOST) would send to ${input.to}: ${input.subject}`,
    );
    return;
  }
  try {
    const info = await transporter.sendMail({
      from: MAIL_FROM,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    console.log(`[email] sent to ${input.to} (messageId=${info.messageId})`);
  } catch (err) {
    console.warn('[email] Send failed:', err);
  }
}

// ── Share-invitation email ────────────────────────────────────────

export interface MapInvitationInput {
  mapId: string;
  inviterId: string;
  recipientEmail: string;
  isNewUser: boolean;
}

/**
 * Fetch the inviter's name + map name, then send a formatted invitation.
 * Safe to call without awaiting — errors are logged, not thrown.
 */
export async function sendMapInvitationEmail(input: MapInvitationInput): Promise<void> {
  const { mapId, inviterId, recipientEmail, isNewUser } = input;

  const [inviter] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, inviterId))
    .limit(1);
  const [mapRow] = await db
    .select({ name: maps.name })
    .from(maps)
    .where(eq(maps.id, mapId))
    .limit(1);

  if (!inviter || !mapRow) return;

  const inviterName = inviter.name;
  const mapName = mapRow.name;
  const url = isNewUser
    ? `${FRONTEND_URL}/?email=${encodeURIComponent(recipientEmail)}&mode=register`
    : FRONTEND_URL;

  const subject = isNewUser
    ? `${inviterName} invited you to MindBlown`
    : `${inviterName} shared "${mapName}" with you`;

  const actionWord = isNewUser ? 'Accept invitation' : 'Open MindBlown';
  const blurbHtml = isNewUser
    ? `${escapeHtml(inviterName)} invited you to collaborate on <strong>${escapeHtml(mapName)}</strong>, a project map in MindBlown. Sign up to accept and you'll find the map on your dashboard.`
    : `${escapeHtml(inviterName)} shared the map <strong>${escapeHtml(mapName)}</strong> with you. Sign in to see it on your dashboard.`;

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:32px 16px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1e293b;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px 28px;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
    <h1 style="margin:0 0 16px;font-size:20px;font-weight:700;">MindBlown</h1>
    <p style="margin:0 0 24px;font-size:14px;line-height:1.6;">${blurbHtml}</p>
    <p style="margin:0 0 20px;">
      <a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 20px;border-radius:8px;">${actionWord}</a>
    </p>
    <p style="margin:0;font-size:11px;color:#94a3b8;word-break:break-all;">
      Or open this link: ${url}
    </p>
  </div>
</body>
</html>`;

  const blurbText = isNewUser
    ? `${inviterName} invited you to collaborate on "${mapName}", a project map in MindBlown. Sign up to accept.`
    : `${inviterName} shared the map "${mapName}" with you. Sign in to see it on your dashboard.`;
  const text = `${blurbText}\n\n${actionWord}: ${url}`;

  await sendEmail({ to: recipientEmail, subject, html, text });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });
}
