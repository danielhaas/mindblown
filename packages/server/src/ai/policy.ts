/**
 * Per-map AI policy (#375) — which LLM a map's content may reach.
 *
 *   any    follow the server-wide provider preference (the default)
 *   local  only the local OpenAI-compatible backend; NEVER Claude. With no
 *          local backend configured the AI features are simply off for
 *          this map — falling back to Claude would be the leak the
 *          policy exists to prevent.
 *   none   no AI at all for this map, embeddings included.
 *
 * Every AI entry point resolves its backend through here instead of
 * `resolveProvider()` directly: the six structured routes, chat, semantic
 * search + backfill, node embedding and issue triage. The frontend reads
 * the map's effective capabilities from `GET /api/ai/config?mapId=` and
 * hides what the policy forbids.
 *
 * Fail-closed: if the policy cannot be read (DB error) the map is treated
 * as `none` — a privacy setting must never silently widen.
 */

import { eq } from 'drizzle-orm';
import type { AiPolicy } from '@mindblown/core';
import { isAiPolicy } from '@mindblown/core';
import { db } from '../db/connection.js';
import { maps } from '../db/schema.js';
import { aiEnabled, embedEnabled } from './client.js';
import { aiCapabilities, type AiCapabilities } from './capabilities.js';
import { resolveProvider } from './providers/index.js';
import { ollamaProvider } from './providers/ollama.js';
import type { ChatProvider } from './providers/types.js';

export class AiPolicyError extends Error {
  readonly code = 'AI_POLICY' as const;
  constructor(
    public readonly policy: AiPolicy,
    message: string,
  ) {
    super(message);
    this.name = 'AiPolicyError';
  }
}

const NONE: AiCapabilities = {
  enabled: false,
  chat: false,
  structured: false,
  embeddings: false,
  triage: false,
};

/** The map's stored policy; a missing map reads as `any` (the caller 404s it). */
export async function getMapAiPolicy(mapId: string): Promise<AiPolicy> {
  try {
    const [row] = await db
      .select({ aiPolicy: maps.aiPolicy })
      .from(maps)
      .where(eq(maps.id, mapId))
      .limit(1);
    if (!row) return 'any';
    return isAiPolicy(row.aiPolicy) ? row.aiPolicy : 'any';
  } catch (err) {
    console.warn(`[ai-policy] could not read policy for map ${mapId} — treating as none:`, err);
    return 'none';
  }
}

/** Effective capabilities under a policy, given what the server has configured. */
export function capabilitiesForPolicy(policy: AiPolicy): AiCapabilities {
  switch (policy) {
    case 'none':
      return { ...NONE };
    case 'local':
      return {
        enabled: aiEnabled,
        chat: aiEnabled,
        structured: aiEnabled,
        embeddings: embedEnabled,
        triage: aiEnabled,
      };
    default:
      return aiCapabilities();
  }
}

export async function capabilitiesForMap(mapId: string): Promise<AiCapabilities> {
  return capabilitiesForPolicy(await getMapAiPolicy(mapId));
}

/**
 * The backend a policy allows for chat / structured calls.
 * `local` pins the local provider without the resolver's Claude fallback.
 */
export async function resolveProviderForPolicy(policy: AiPolicy): Promise<ChatProvider> {
  switch (policy) {
    case 'none':
      throw new AiPolicyError('none', 'AI is disabled for this map by its AI policy.');
    case 'local':
      if (!aiEnabled) {
        throw new AiPolicyError(
          'local',
          'This map allows only a local model and none is configured (AI_BASE_URL).',
        );
      }
      return ollamaProvider;
    default:
      return resolveProvider();
  }
}

export async function resolveProviderForMap(mapId: string): Promise<ChatProvider> {
  return resolveProviderForPolicy(await getMapAiPolicy(mapId));
}

/** Semantic search / embedding allowed for this map? (`local` and `any` both use the local embedder.) */
export async function mapAllowsEmbeddings(mapId: string): Promise<boolean> {
  return (await capabilitiesForMap(mapId)).embeddings;
}
