/**
 * The repo webhook a PAT/OAuth forge binding needs (#386).
 *
 * Without it the 5-minute catch-up poll is the only way back from the
 * forge, and everything only the webhook path knows never happens: PR
 * opened/merged/closed (linked-PR mirror, the close gates, the claim
 * trail's pr_merged), reviews, check suites. A GitHub App binding has its
 * own App webhook and never comes here.
 *
 * `ensureForgeWebhook` makes the binding's repo carry exactly one hook to
 * this server — created, or the existing one with our URL re-armed with
 * the events and the stored secret — and stores a generated secret first
 * when the row has none. Idempotent; safe to run on every connect.
 */

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ForgeApiError, type ForgeClient, type ForgeKind } from '@mindblown/integrations';
import { db } from '../db/connection.js';
import { integrations } from '../db/schema.js';
import { forgeFromIntegration, type ForgeIntegrationConfig } from './forge.js';

export const WEBHOOK_PATH = '/api/webhooks/github';

/**
 * What the webhook route consumes. Gitea splits GitHub's `issues` and
 * `pull_request` into one event per facet (label, assignee, milestone,
 * sync) and delivers each under the GitHub name — subscribing only
 * `issues` would miss label and assignee changes.
 */
export const WEBHOOK_EVENTS: Record<ForgeKind, string[]> = {
  gitea: [
    'issues',
    'issue_assign',
    'issue_label',
    'issue_milestone',
    'pull_request',
    'pull_request_assign',
    'pull_request_label',
    'pull_request_milestone',
    'pull_request_sync',
    'pull_request_review',
  ],
  github: ['issues', 'pull_request', 'pull_request_review', 'check_suite'],
};

/**
 * The payload URL the forge must call: `PUBLIC_URL` (else `FRONTEND_URL`)
 * when set, otherwise the origin the request came in on (behind Caddy:
 * the forwarded proto/host). Null when neither yields an absolute URL.
 */
export function publicWebhookUrl(headers: Record<string, string | string[] | undefined> = {}): string | null {
  const configured = (process.env.PUBLIC_URL ?? process.env.FRONTEND_URL ?? '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(configured)) return `${configured}${WEBHOOK_PATH}`;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
  const host = first(headers['x-forwarded-host']) ?? first(headers.host);
  if (!host) return null;
  const proto = first(headers['x-forwarded-proto']) ?? 'http';
  return `${proto}://${host}${WEBHOOK_PATH}`;
}

interface RawHook {
  id: number;
  active: boolean;
  events: string[] | null;
  config: { url?: string } | null;
}

export interface WebhookState {
  url: string;
  events: string[];
  /** Whether MindBlown holds a secret to verify deliveries with. */
  secretStored: boolean;
  /** The repo's hook to `url`, if any. */
  hook: { id: number; active: boolean; events: string[] } | null;
  /** Events the hook lacks (empty when it has them all). */
  missingEvents: string[];
}

export type WebhookSetupResult =
  | { status: 'created' | 'updated'; hookId: number; url: string; events: string[] }
  | { status: 'failed'; reason: string; hint?: string };

interface IntegrationRow {
  id: string;
  provider: string;
  config: ForgeIntegrationConfig;
}

function kindOf(row: IntegrationRow): ForgeKind {
  return row.provider === 'gitea' ? 'gitea' : 'github';
}

async function findHook(forge: ForgeClient, cfg: ForgeIntegrationConfig, url: string): Promise<RawHook | null> {
  // Gitea answers an empty list with `null`.
  const hooks = (await forge.requestJson<RawHook[] | null>(`/repos/${cfg.owner}/${cfg.repo}/hooks`)) ?? [];
  return hooks.find((h) => h.config?.url === url) ?? null;
}

/** Read-only: does the binding's repo carry our hook? */
export async function readForgeWebhook(row: IntegrationRow, url: string): Promise<WebhookState> {
  const events = WEBHOOK_EVENTS[kindOf(row)];
  const forge = await forgeFromIntegration(row);
  if (!forge) throw new Error('the forge connection cannot authenticate (token or sign-in missing)');
  const hook = await findHook(forge, row.config, url);
  const have = hook?.events ?? [];
  return {
    url,
    events,
    secretStored: !!row.config.webhookSecret,
    hook: hook ? { id: hook.id, active: hook.active, events: have } : null,
    missingEvents: hook ? events.filter((e) => !have.includes(e)) : events,
  };
}

/** Why a hook write failed, in the words the operator can act on. */
function explain(err: unknown, kind: ForgeKind): { reason: string; hint?: string } {
  if (err instanceof ForgeApiError) {
    const reason = `${kind} answered ${err.status}: ${err.body.slice(0, 200)}`;
    if (err.status === 401 || err.status === 403 || err.status === 404) {
      return { reason, hint: 'The token needs admin rights on the repository (Gitea: write:repository scope, repo admin) to manage webhooks.' };
    }
    if (/allowed|ALLOWED_HOST_LIST/i.test(err.body)) {
      return {
        reason,
        hint: 'Gitea refuses to call this host. Add it to [webhook] ALLOWED_HOST_LIST in Gitea\'s app.ini (private and Tailnet addresses are blocked by default).',
      };
    }
    return { reason };
  }
  return { reason: err instanceof Error ? err.message : String(err) };
}

/** Create or re-arm the repo's hook to `url`; store a generated secret first when the row has none. */
export async function ensureForgeWebhook(row: IntegrationRow, url: string): Promise<WebhookSetupResult> {
  const kind = kindOf(row);
  const events = WEBHOOK_EVENTS[kind];
  const cfg = row.config;
  const forge = await forgeFromIntegration(row);
  if (!forge) return { status: 'failed', reason: 'the forge connection cannot authenticate (token or sign-in missing)' };

  // Stored BEFORE the hook carries it: a failed hook write then leaves a
  // secret no delivery uses yet, never a hook signing with a secret we lost.
  let secret = cfg.webhookSecret;
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    await db
      .update(integrations)
      .set({ config: { ...cfg, webhookSecret: secret }, updatedAt: new Date() })
      .where(eq(integrations.id, row.id));
  }

  const hookConfig = { url, content_type: 'json', secret };
  try {
    const existing = await findHook(forge, cfg, url);
    if (existing) {
      // Gitea resets a hook to `push` only when a PATCH omits `events`.
      const hook = await forge.requestJson<RawHook>(`/repos/${cfg.owner}/${cfg.repo}/hooks/${existing.id}`, {
        method: 'PATCH',
        body: { active: true, events, config: hookConfig },
      });
      return { status: 'updated', hookId: hook?.id ?? existing.id, url, events };
    }
    const hook = await forge.requestJson<RawHook>(`/repos/${cfg.owner}/${cfg.repo}/hooks`, {
      method: 'POST',
      body: kind === 'gitea'
        ? { type: 'gitea', active: true, events, config: hookConfig }
        : { name: 'web', active: true, events, config: { ...hookConfig, insecure_ssl: '0' } },
    });
    return { status: 'created', hookId: hook.id, url, events };
  } catch (err) {
    return { status: 'failed', ...explain(err, kind) };
  }
}
