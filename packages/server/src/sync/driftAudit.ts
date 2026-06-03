/**
 * Daily drift audit between GitHub and MindBlown.
 *
 * Catches the failure mode the webhook + catchup loop CAN'T self-heal:
 * a GitHub issue exists, is open, on a repo wired to a MindBlown map
 * with `auto_import_new_issues = TRUE`, but no MindBlown node ever got
 * created for it. Causes range from a misconfigured webhook URL on the
 * GitHub side, to an installation-token outage during the catchup
 * window, to an ingest exception that quietly dropped the issue. Today
 * the only signal that drift exists is when the user clicks through
 * the `github_sync_overview` endpoint by hand — this module gives
 * Kuma a once-a-day check it can alarm on.
 *
 * Scope: open issues only. Closed-without-node is a separate question
 * (the catchup pass deliberately doesn't ingest closed issues, so a
 * closed-unlinked issue is usually intentional history, not drift).
 *
 * Skipped:
 *   - Maps with `autoImportNewIssues = FALSE` (the user explicitly
 *     opted out of auto-creation).
 *   - Maps with no GitHub binding (no repo to compare against).
 *   - Maps whose binding can't currently resolve a token (App install
 *     revoked, PAT expired). Logged via `console.warn` AND surfaced in
 *     the `tokenErrors` array of the returned `AuditDriftResult` so the
 *     operator hitting `POST /api/maps/sync/audit-drift` can see exactly
 *     which maps need attention without SSH-ing for logs. They still
 *     don't count as drift for the Kuma "up/down" decision — auto-backfill
 *     can't heal a token problem — but `tokenErrors.length` is included
 *     in the Kuma message so a token outage shows up in the dashboard.
 */

import { eq, and, isNotNull } from 'drizzle-orm';
import type { ExternalLink } from '@mindblown/core';
import { importGitHubIssues, mintInstallationToken } from '@mindblown/integrations';

import { db } from '../db/connection.js';
import { maps, nodes, integrations } from '../db/schema.js';
import { pushKumaHeartbeat } from './kumaPush.js';
import { runAutoBackfill, type AutoBackfillSummary } from './autoBackfill.js';

export interface DriftReport {
  mapId: string;
  mapName: string;
  /** "owner/repo" — matches the externalId namespace. */
  repo: string;
  /** Count of open GitHub issues with no linked MindBlown node in this map. */
  onlyInGitHub: number;
  /** First 5 issue numbers from `onlyInGitHub`, for the Kuma alert text. */
  exampleIssues: number[];
}

/**
 * Internal: a map + its resolved (owner, repo, token) triple. Maps that
 * fail to resolve a token are skipped entirely and reported via the
 * `tokenErrors` array.
 */
interface AuditTarget {
  mapId: string;
  mapName: string;
  owner: string;
  repo: string;
  token: string;
}

/**
 * One map whose token resolution failed. Surfaced in `AuditDriftResult`
 * so the operator endpoint can show the failure without log access.
 *
 * `reason` is a short stringified cause — typical values:
 *   - `app: install revoked`       (App-token mint threw, no PAT fallback)
 *   - `app: <octokit message>`     (other App-token mint failure)
 *   - bare error message if no `app:` prefix applies
 */
export interface TokenError {
  mapId: string;
  mapName: string;
  reason: string;
}

interface ResolvedTargets {
  targets: AuditTarget[];
  tokenErrors: TokenError[];
}

/**
 * Return shape of `auditDrift()`. `reports` is the per-map drift list
 * (every entry has `onlyInGitHub > 0`); `tokenErrors` is every map that
 * couldn't be audited because its GitHub binding failed to resolve a
 * token. The two are disjoint by construction — a map with a token
 * error isn't audited so can't produce a report.
 */
export interface AuditDriftResult {
  reports: DriftReport[];
  tokenErrors: TokenError[];
}

/**
 * Find every map opted into auto-import that has a GitHub binding, and
 * resolve a current token for each one. Mirrors `discoverTargets()` in
 * `githubCatchup.ts` but at the *map* level — we report drift per-map,
 * not per-repo, because the same repo can be wired to multiple maps
 * with different policy.
 */
async function resolveTargets(): Promise<ResolvedTargets> {
  const targets: AuditTarget[] = [];
  const tokenErrors: TokenError[] = [];

  // (1) App-bound maps with auto-import on.
  const appMaps = await db
    .select({
      id: maps.id,
      name: maps.name,
      owner: maps.githubRepoOwner,
      repo: maps.githubRepoName,
      installationId: maps.githubInstallationId,
      workspaceId: maps.workspaceId,
    })
    .from(maps)
    .where(
      and(
        eq(maps.autoImportNewIssues, true),
        isNotNull(maps.githubRepoOwner),
        isNotNull(maps.githubRepoName),
      ),
    );

  for (const m of appMaps) {
    if (!m.owner || !m.repo) continue;
    if (m.installationId) {
      try {
        const token = await mintInstallationToken(m.installationId);
        targets.push({ mapId: m.id, mapName: m.name, owner: m.owner, repo: m.repo, token });
        continue;
      } catch (err) {
        // Fall through to PAT lookup below — the map may have an
        // App binding that no longer works AND a workspace PAT that
        // does.
        const reason = err instanceof Error ? err.message : String(err);
        tokenErrors.push({ mapId: m.id, mapName: m.name, reason: `app: ${reason}` });
      }
    }

    // PAT fallback: any workspace integration matching (owner, repo).
    const pats = await db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.workspaceId, m.workspaceId),
          eq(integrations.provider, 'github'),
          eq(integrations.enabled, true),
        ),
      );
    const pat = pats.find((p) => {
      const cfg = p.config as { owner?: string; repo?: string; token?: string } | null;
      return cfg?.owner === m.owner && cfg?.repo === m.repo && !!cfg.token;
    });
    if (pat) {
      const cfg = pat.config as { token: string };
      // If we already pushed a tokenError for the failed App mint above,
      // drop it — we DID resolve a token in the end.
      const idx = tokenErrors.findIndex((te) => te.mapId === m.id);
      if (idx >= 0) tokenErrors.splice(idx, 1);
      targets.push({ mapId: m.id, mapName: m.name, owner: m.owner, repo: m.repo, token: cfg.token });
    }
  }

  return { targets, tokenErrors };
}

/**
 * Audit drift for one target map: fetch open issues from GitHub,
 * cross-reference against linked nodes IN THAT MAP, count issues that
 * have no MindBlown node.
 *
 * Returns null if the map is currently clean. Returns a DriftReport
 * with `onlyInGitHub > 0` otherwise.
 */
async function auditOneMap(t: AuditTarget): Promise<DriftReport | null> {
  // Open issues only — closed-without-node is a separate question
  // (see module header).
  const importedIssues = await importGitHubIssues(t.owner, t.repo, t.token, {
    includeAll: false,
  });

  // Build externalId lookup from this map's nodes.
  const mapNodes = await db
    .select({ externalLinks: nodes.externalLinks })
    .from(nodes)
    .where(eq(nodes.mapId, t.mapId));

  const linkedExternalIds = new Set<string>();
  for (const n of mapNodes) {
    const links = (n.externalLinks as ExternalLink[]) ?? [];
    for (const l of links) {
      if (l.provider === 'github' && l.externalId) {
        linkedExternalIds.add(l.externalId);
      }
    }
  }

  const drifted = importedIssues
    .filter((item) => !linkedExternalIds.has(item.externalLink.externalId))
    .map((item) => item.issue.number);

  if (drifted.length === 0) return null;

  return {
    mapId: t.mapId,
    mapName: t.mapName,
    repo: `${t.owner}/${t.repo}`,
    onlyInGitHub: drifted.length,
    exampleIssues: drifted.slice(0, 5),
  };
}

/**
 * Audit every opted-in map for GitHub→MindBlown drift. Returns one
 * DriftReport per drifted map (empty when everything's clean) PLUS a
 * `tokenErrors` array listing every map whose binding couldn't resolve
 * a current token (App install revoked, PAT expired/missing).
 *
 * Per-map fetch failures (network/5xx during `importGitHubIssues`) are
 * still logged via `console.warn` and don't abort the sweep — one map's
 * outage shouldn't mask drift in another. Those are NOT collected into
 * `tokenErrors` because they're typically transient and clear by the
 * next sweep; token errors are persistent until an operator fixes the
 * binding, so they're worth surfacing in the response shape.
 */
export async function auditDrift(): Promise<AuditDriftResult> {
  const { targets, tokenErrors } = await resolveTargets();

  if (tokenErrors.length > 0) {
    for (const te of tokenErrors) {
      console.warn(
        `[drift-audit] skipping map ${te.mapId} (${te.mapName}): ${te.reason}`,
      );
    }
  }

  const reports: DriftReport[] = [];
  for (const t of targets) {
    try {
      const report = await auditOneMap(t);
      if (report) reports.push(report);
    } catch (err) {
      console.warn(
        `[drift-audit] map ${t.mapId} (${t.mapName}) — fetch failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { reports, tokenErrors };
}

/**
 * Result of one `runDriftAudit()` invocation, returned to callers
 * (the daily scheduler in index.ts and the manual operator endpoint
 * in routes/integrations.ts so they can show what auto-backfill did).
 *
 * `tokenErrors` is propagated from `auditDrift()` so the manual operator
 * endpoint can surface binding failures alongside drift + auto-backfill
 * results in a single response.
 */
export interface DriftAuditRunResult {
  reports: DriftReport[];
  tokenErrors: TokenError[];
  autoBackfill: AutoBackfillSummary;
  /** Set when the audit itself threw — short reason string for ops UI. */
  error?: string;
}

/**
 * Build the Kuma message string from an auto-backfill summary.
 * Exported for tests.
 *
 * Examples:
 *   - clean       → "no-drift"
 *   - all healed  → "auto-backfilled-3"
 *   - all manual  → "manual-5"
 *   - mixed       → "auto-backfilled-2,manual-3"
 */
export function formatAutoBackfillMsg(summary: AutoBackfillSummary): string {
  const parts: string[] = [];
  if (summary.totalImported > 0) {
    parts.push(`auto-backfilled-${summary.totalImported}`);
  }
  if (summary.totalManualPending > 0) {
    parts.push(`manual-${summary.totalManualPending}`);
  }
  if (parts.length === 0) return 'no-drift';
  return parts.join(',');
}

/**
 * Run the drift audit, attempt auto-backfill on every drift report that
 * fits under the per-day cap, then push a single Kuma heartbeat
 * summarising the outcome.
 *
 * Pushes:
 *   - No drift                       → status=up, msg="no-drift"
 *   - Drift fully auto-healed        → status=up, msg="auto-backfilled-N"
 *   - Drift partially auto-healed    → status=down, msg="auto-backfilled-X,manual-Y"
 *   - All drift over cap / killed    → status=down, msg="manual-N"
 *   - Audit itself threw             → status=down, msg="audit_failed:<reason>"
 *
 * If any maps had token errors, `,token-errors-N` is appended to the
 * msg (e.g. `no-drift,token-errors-2`). Token errors alone do not flip
 * status to down — they're surfaced via the response shape's
 * `tokenErrors` field for the operator endpoint to render.
 *
 * Kuma URL comes from `KUMA_GITHUB_DRIFT_PUSH_URL`; if unset the push
 * is skipped entirely (dev / test environments). Push errors are
 * swallowed by `pushKumaHeartbeat`, but we re-wrap here so any future
 * helper misbehaviour can't take down the run result.
 */
export async function runDriftAudit(): Promise<DriftAuditRunResult> {
  const url = process.env.KUMA_GITHUB_DRIFT_PUSH_URL;
  let reports: DriftReport[];
  let tokenErrors: TokenError[];
  try {
    ({ reports, tokenErrors } = await auditDrift());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[drift-audit] sweep failed:', err);
    if (url) {
      const msg = `audit_failed: ${reason}`.slice(0, 200);
      try {
        await pushKumaHeartbeat(url, 'down', msg, '[kuma-push] drift audit');
      } catch (pushErr) {
        console.warn(
          '[kuma-push] drift audit heartbeat unexpectedly threw:',
          pushErr instanceof Error ? pushErr.message : pushErr,
        );
      }
    }
    return {
      reports: [],
      tokenErrors: [],
      autoBackfill: { totalImported: 0, totalManualPending: 0, outcomes: [] },
      error: reason,
    };
  }

  // Suffix appended to the Kuma message when any map's binding failed
  // to resolve a token. Token errors don't trigger status=down on their
  // own (they can't be auto-healed and don't count as drift), but
  // appending the count lets a Kuma watcher catch persistent binding
  // outages even when drift is otherwise clean.
  const tokenSuffix = tokenErrors.length > 0 ? `,token-errors-${tokenErrors.length}` : '';

  // No drift → clean push and bail. Skip auto-backfill entirely
  // (nothing to heal). Token errors still get appended so a "no drift
  // but token broken" state is visible at the Kuma dashboard.
  if (reports.length === 0) {
    console.log('[drift-audit] clean — no drift');
    if (url) {
      try {
        await pushKumaHeartbeat(url, 'up', `no-drift${tokenSuffix}`, '[kuma-push] drift audit');
      } catch (pushErr) {
        console.warn(
          '[kuma-push] drift audit heartbeat unexpectedly threw:',
          pushErr instanceof Error ? pushErr.message : pushErr,
        );
      }
    }
    return {
      reports: [],
      tokenErrors,
      autoBackfill: { totalImported: 0, totalManualPending: 0, outcomes: [] },
    };
  }

  // Drift detected — log + auto-backfill what we can.
  const summary = reports.map((r) => `${r.mapName}=${r.onlyInGitHub} issues`).join(', ');
  console.warn(`[drift-audit] drift detected: ${summary}`);

  const autoBackfill = await runAutoBackfill(reports);

  if (autoBackfill.totalImported > 0) {
    const perMap = autoBackfill.outcomes
      .filter((o) => o.kind === 'healed')
      .map((o) => `${o.mapName}=${(o as { imported: number }).imported}`)
      .join(', ');
    console.log(`[auto-backfill] healed ${autoBackfill.totalImported} drift node(s): ${perMap}`);
  }
  if (autoBackfill.totalManualPending > 0) {
    const perMap = autoBackfill.outcomes
      .filter((o) => o.kind === 'over-cap' || o.kind === 'failed')
      .map((o) => {
        if (o.kind === 'failed') {
          return `${o.mapName}=${(o as { pending: number }).pending} (failed: ${(o as { reason: string }).reason})`;
        }
        return `${o.mapName}=${(o as { pending: number }).pending} (over cap)`;
      })
      .join(', ');
    console.warn(`[auto-backfill] ${autoBackfill.totalManualPending} drift node(s) need manual action: ${perMap}`);
  }

  // Build the Kuma message and status.
  const msg = `${formatAutoBackfillMsg(autoBackfill)}${tokenSuffix}`.slice(0, 200);
  const status = autoBackfill.totalManualPending > 0 ? 'down' : 'up';

  if (url) {
    try {
      await pushKumaHeartbeat(url, status, msg, '[kuma-push] drift audit');
    } catch (pushErr) {
      console.warn(
        '[kuma-push] drift audit heartbeat unexpectedly threw:',
        pushErr instanceof Error ? pushErr.message : pushErr,
      );
    }
  }

  return { reports, tokenErrors, autoBackfill };
}
