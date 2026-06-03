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
 *     revoked, PAT expired). Surfaced as an `error` field on the report
 *     so the operator sees it in the manual-trigger response, but doesn't
 *     count as drift for the Kuma alarm.
 */

import { eq, and, isNotNull } from 'drizzle-orm';
import type { ExternalLink } from '@mindblown/core';
import { importGitHubIssues, mintInstallationToken } from '@mindblown/integrations';

import { db } from '../db/connection.js';
import { maps, nodes, integrations } from '../db/schema.js';

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

interface TokenError {
  mapId: string;
  mapName: string;
  reason: string;
}

interface ResolvedTargets {
  targets: AuditTarget[];
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
 * DriftReport per drifted map (empty array when everything's clean).
 *
 * Per-map fetch failures are logged but don't abort the sweep — one
 * map's outage shouldn't mask drift in another map. They're surfaced
 * via console.warn and (for the most common cause, token resolution)
 * via the returned reports' implicit absence.
 */
export async function auditDrift(): Promise<DriftReport[]> {
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
  return reports;
}
