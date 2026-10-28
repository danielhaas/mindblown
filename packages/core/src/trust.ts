/**
 * Trust (#491): who may run the fleet on a map.
 *
 * A node's reporter (#490) decides its trust level against the map's trust
 * policy:
 *
 *   trusted   on the map's explicit lists (user ids, forge logins)
 *   known     a map member who is not on the lists
 *   external  everyone else, incl. forge authors not mapped to a member
 *
 * `reportedBy = null` counts as external: an unknown reporter is not a
 * trusted one (#492, fail-closed). The nodes from before #490 were stamped
 * by the #492 backfill instead. Trusted work runs fully automatic; the two
 * untrusted levels follow the policy's knobs. Deploy is not a knob — only
 * trusted work is ever deployed automatically.
 */
import type { NodeApproval, NodeReporter } from './types.js';

export type TrustLevel = 'trusted' | 'known' | 'external';
export type TrustDispatch = 'auto' | 'approval';
export type TrustMerge = 'auto' | 'pr-only';

export interface TrustLevelPolicy {
  dispatch: TrustDispatch;
  merge: TrustMerge;
}

export interface TrustPolicy {
  /** MindBlown user ids. Default: the map's creator. */
  trustedUserIds: string[];
  /** Forge logins (case-insensitive). Default: the login the map's forge binding syncs as. */
  trustedForgeLogins: string[];
  levels: {
    known: TrustLevelPolicy;
    external: TrustLevelPolicy;
  };
}

/** The safe knobs for an untrusted level: ask first, stop at the PR. */
export const SAFE_TRUST_LEVEL: TrustLevelPolicy = { dispatch: 'approval', merge: 'pr-only' };

/** A map's policy before an admin has saved one. */
export function defaultTrustPolicy(creatorId: string, forgeLogins: string[] = []): TrustPolicy {
  return {
    trustedUserIds: [creatorId],
    trustedForgeLogins: [...forgeLogins],
    levels: { known: { ...SAFE_TRUST_LEVEL }, external: { ...SAFE_TRUST_LEVEL } },
  };
}

/** A forge login that belongs to a MindBlown user (a linked forge identity). */
export interface ForgeUserLink {
  provider: string;
  login: string;
  userId: string;
}

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function trustLevel(
  node: { reportedBy: NodeReporter | null },
  policy: TrustPolicy,
  memberIds: readonly string[],
  forgeUsers: readonly ForgeUserLink[] = [],
): TrustLevel {
  const r = node.reportedBy;
  if (!r) return 'external';
  let userId: string | null;
  if (r.kind === 'user') {
    userId = r.userId;
  } else {
    if (policy.trustedForgeLogins.some((l) => sameLogin(l, r.login))) return 'trusted';
    userId = forgeUsers.find((f) => f.provider === r.provider && sameLogin(f.login, r.login))?.userId ?? null;
  }
  if (userId === null) return 'external';
  if (policy.trustedUserIds.includes(userId)) return 'trusted';
  return memberIds.includes(userId) ? 'known' : 'external';
}

export interface TrustAutomation extends TrustLevelPolicy {
  level: TrustLevel;
  /** Only trusted work is ever deployed automatically. */
  deploy: boolean;
}

export function automationFor(
  node: { reportedBy: NodeReporter | null },
  policy: TrustPolicy,
  memberIds: readonly string[],
  forgeUsers: readonly ForgeUserLink[] = [],
): TrustAutomation {
  const level = trustLevel(node, policy, memberIds, forgeUsers);
  if (level === 'trusted') return { level, dispatch: 'auto', merge: 'auto', deploy: true };
  return { level, ...policy.levels[level], deploy: false };
}

/**
 * The approval stamp a new node gets (#492). Trusted work, and work at a
 * level the policy lets dispatch on its own, is approved by the policy
 * (`by: null`). Everything else is proposed and waits for a trusted person.
 * `merge` is what applies once the node is approved.
 */
export function approvalAtCreation(automation: TrustAutomation, at: string): NodeApproval {
  return { state: automation.dispatch === 'auto' ? 'approved' : 'proposed', merge: automation.merge, by: null, at };
}

/**
 * Validate an untyped policy (REST body). Returns the normalized policy
 * (lists trimmed, de-duplicated) or an error message.
 */
export function parseTrustPolicy(input: unknown): TrustPolicy | string {
  if (!input || typeof input !== 'object') return 'trustPolicy must be an object.';
  const p = input as Record<string, unknown>;
  const list = (key: 'trustedUserIds' | 'trustedForgeLogins'): string[] | string => {
    const v = p[key];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return `trustPolicy.${key} must be a list of strings.`;
    return [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))];
  };
  const trustedUserIds = list('trustedUserIds');
  if (typeof trustedUserIds === 'string') return trustedUserIds;
  const trustedForgeLogins = list('trustedForgeLogins');
  if (typeof trustedForgeLogins === 'string') return trustedForgeLogins;
  const levels = p.levels as Record<string, unknown> | undefined;
  if (!levels || typeof levels !== 'object') return 'trustPolicy.levels must be { known, external }.';
  const level = (key: 'known' | 'external'): TrustLevelPolicy | string => {
    const l = levels[key] as Record<string, unknown> | undefined;
    if (!l || typeof l !== 'object') return `trustPolicy.levels.${key} must be { dispatch, merge }.`;
    if (l.dispatch !== 'auto' && l.dispatch !== 'approval') return `trustPolicy.levels.${key}.dispatch must be "auto" or "approval".`;
    if (l.merge !== 'auto' && l.merge !== 'pr-only') return `trustPolicy.levels.${key}.merge must be "auto" or "pr-only".`;
    return { dispatch: l.dispatch, merge: l.merge };
  };
  const known = level('known');
  if (typeof known === 'string') return known;
  const external = level('external');
  if (typeof external === 'string') return external;
  return { trustedUserIds, trustedForgeLogins, levels: { known, external } };
}
