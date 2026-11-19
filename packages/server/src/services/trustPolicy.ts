/**
 * A map's trust policy (#491): who may run the fleet on it.
 *
 * Stored in `maps.trust_policy`; NULL until an admin saves one. Until then
 * the map runs on the defaults: the creator is the trusted user, the
 * login the map's forge binding syncs as (an OAuth-bound row's identity)
 * plus the creator's own linked forge logins are the trusted logins, and
 * both untrusted levels are on the safe knobs (approval + pr-only).
 *
 * Kept off `MindMap` on purpose: read and write are admin-only, while the
 * map row goes to every viewer (GET /api/maps/:id, map:updated broadcast).
 */
import { eq, inArray } from 'drizzle-orm';
import {
  approvalAtCreation,
  automationFor,
  defaultTrustPolicy,
  parseTrustPolicy,
  type ForgeUserLink,
  type NodeApproval,
  type NodeReporter,
  type TrustPolicy,
} from '@mindblown/core';
import { db } from '../db/connection.js';
import { mapPermissions, maps, userGithubIdentities } from '../db/schema.js';
import { recordEvent } from '../db/events.js';
import * as permDb from '../db/permissions.js';
import { getForgeIntegration } from '../lib/githubContext.js';

export interface MapTrustPolicy {
  policy: TrustPolicy;
  /** No policy saved yet — `policy` is the computed default. */
  isDefault: boolean;
}

/**
 * Gate a `trustPolicy` sent with a map update (REST PUT, chat backend):
 * admin on the map, and a valid policy or null (back to the defaults).
 * Returns the policy to save, or the refusal. Callers check before writing
 * anything, so a refused policy leaves the rest of the update unapplied too.
 */
export async function checkTrustPolicyInput(
  userId: string,
  mapId: string,
  raw: unknown,
): Promise<{ policy: TrustPolicy | null } | { status: 400 | 403; code: string; message: string }> {
  if (!permDb.hasPermission(await permDb.getPermission(mapId, userId), 'admin')) {
    return { status: 403, code: 'FORBIDDEN', message: 'Only map admins can change who may run the fleet' };
  }
  if (raw === null) return { policy: null };
  const parsed = parseTrustPolicy(raw);
  if (typeof parsed === 'string') return { status: 400, code: 'VALIDATION_ERROR', message: parsed };
  return { policy: parsed };
}

/** The forge logins a map trusts by default. */
async function defaultForgeLogins(map: {
  workspaceId: string;
  createdBy: string;
  githubRepoOwner: string | null;
  githubRepoName: string | null;
}): Promise<string[]> {
  const logins: string[] = [];
  if (map.githubRepoOwner && map.githubRepoName) {
    const row = await getForgeIntegration(map.workspaceId, map.githubRepoOwner, map.githubRepoName);
    const identityId = row?.config.oauthIdentityId;
    if (identityId) {
      const [identity] = await db
        .select({ login: userGithubIdentities.githubLogin })
        .from(userGithubIdentities)
        .where(eq(userGithubIdentities.id, identityId));
      if (identity) logins.push(identity.login);
    }
  }
  const own = await db
    .select({ login: userGithubIdentities.githubLogin })
    .from(userGithubIdentities)
    .where(eq(userGithubIdentities.userId, map.createdBy));
  for (const { login } of own) if (!logins.includes(login)) logins.push(login);
  return logins;
}

/** The map's policy — saved, or the default. null when the map does not exist. */
export async function getTrustPolicy(mapId: string): Promise<MapTrustPolicy | null> {
  const [map] = await db
    .select({
      trustPolicy: maps.trustPolicy,
      workspaceId: maps.workspaceId,
      createdBy: maps.createdBy,
      githubRepoOwner: maps.githubRepoOwner,
      githubRepoName: maps.githubRepoName,
    })
    .from(maps)
    .where(eq(maps.id, mapId));
  if (!map) return null;
  if (map.trustPolicy) return { policy: map.trustPolicy as TrustPolicy, isDefault: false };
  return { policy: defaultTrustPolicy(map.createdBy, await defaultForgeLogins(map)), isDefault: true };
}

/**
 * Save the policy (already validated by `parseTrustPolicy`), or `null` to
 * go back to the defaults. Journals the change like the dispatch knobs.
 */
export async function setTrustPolicy(
  mapId: string,
  policy: TrustPolicy | null,
  userId: string | null,
): Promise<MapTrustPolicy | null> {
  const before = await getTrustPolicy(mapId);
  if (!before) return null;
  await db.update(maps).set({ trustPolicy: policy, updatedAt: new Date() }).where(eq(maps.id, mapId));
  contextCache.delete(mapId);
  const after = await getTrustPolicy(mapId);
  await recordEvent({
    mapId,
    nodeId: null,
    userId,
    eventType: 'map.field_changed',
    fieldName: 'trustPolicy',
    oldValue: before.isDefault ? null : before.policy,
    newValue: policy,
  });
  return after;
}

/** What core `trustLevel` needs about a map: its policy, its members, and their linked forge logins. */
export interface TrustContext {
  policy: TrustPolicy;
  memberIds: string[];
  forgeUsers: ForgeUserLink[];
}

// Every createNode loads the context (#492), so bulk creates and forge
// catch-up would repeat the same handful of queries per node. A few seconds
// is short enough that a new member or a linked login shows up almost at
// once; a saved policy clears the entry (setTrustPolicy).
const CONTEXT_TTL_MS = 5_000;
const contextCache = new Map<string, { at: number; ctx: TrustContext }>();

/** null when the map does not exist. */
export async function loadTrustContext(mapId: string): Promise<TrustContext | null> {
  const hit = contextCache.get(mapId);
  if (hit && Date.now() - hit.at < CONTEXT_TTL_MS) return hit.ctx;
  const ctx = await readTrustContext(mapId);
  if (ctx) contextCache.set(mapId, { at: Date.now(), ctx });
  return ctx;
}

async function readTrustContext(mapId: string): Promise<TrustContext | null> {
  const trust = await getTrustPolicy(mapId);
  if (!trust) return null;
  const memberIds = (
    await db.select({ userId: mapPermissions.userId }).from(mapPermissions).where(eq(mapPermissions.mapId, mapId))
  ).map((r) => r.userId);
  // A forge author counts as the user whose login it is — a member, or a
  // trusted user who is not a member.
  const userIds = [...new Set([...memberIds, ...trust.policy.trustedUserIds])];
  const forgeUsers =
    userIds.length === 0
      ? []
      : (
          await db
            .select({ provider: userGithubIdentities.kind, login: userGithubIdentities.githubLogin, userId: userGithubIdentities.userId })
            .from(userGithubIdentities)
            .where(inArray(userGithubIdentities.userId, userIds))
        );
  return { policy: trust.policy, memberIds, forgeUsers };
}

/** The approval stamp (#492) for a node from this reporter, against a loaded context. */
export function approvalFor(ctx: TrustContext, reportedBy: NodeReporter | null, at: Date): NodeApproval {
  return approvalAtCreation(automationFor({ reportedBy }, ctx.policy, ctx.memberIds, ctx.forgeUsers), at.toISOString());
}

/**
 * The approval stamp a new node gets (#492). A map that cannot be read
 * stamps nothing: the node then waits like a proposed one.
 */
export async function approvalForNewNode(mapId: string, reportedBy: NodeReporter | null, at: Date): Promise<NodeApproval | null> {
  const ctx = await loadTrustContext(mapId);
  return ctx ? approvalFor(ctx, reportedBy, at) : null;
}
