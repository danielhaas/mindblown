/**
 * Client-side view of the server's AI capability flags.
 *
 * Fetched once from `/api/ai/config` and shared by every component that
 * shows an AI affordance (chat button, breakdown / brain dump / refine
 * context-menu items, the AI estimate button, semantic search enrichment,
 * the triage toggle). Until the answer arrives — and whenever the fetch
 * fails, e.g. before login — every flag reads false, so a no-LLM server
 * never flashes buttons that would fail on click. A failed fetch is not
 * cached: the next mount retries.
 */

import { useEffect, useState } from 'react';
import { aiConfig, type AiCapabilities } from './api.js';

export const NO_AI_CAPABILITIES: AiCapabilities = Object.freeze({
  enabled: false,
  chat: false,
  structured: false,
  embeddings: false,
  triage: false,
});

let cached: AiCapabilities | null = null;
let inflight: Promise<AiCapabilities> | null = null;
const listeners = new Set<(caps: AiCapabilities) => void>();

function normalize(raw: Partial<AiCapabilities> | undefined): AiCapabilities {
  return {
    enabled: raw?.enabled === true,
    chat: raw?.chat === true,
    structured: raw?.structured === true,
    embeddings: raw?.embeddings === true,
    triage: raw?.triage === true,
  };
}

/** Resolve the capabilities, sharing one request between callers. */
export function loadAiCapabilities(): Promise<AiCapabilities> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = aiConfig()
    .then((cfg) => {
      cached = normalize(cfg.capabilities);
      listeners.forEach((fn) => fn(cached!));
      return cached;
    })
    .catch(() => NO_AI_CAPABILITIES)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Synchronous read of whatever is known right now (all false until loaded). */
export function currentAiCapabilities(): AiCapabilities {
  return cached ?? NO_AI_CAPABILITIES;
}

/** Test seam — forget the cached answer. */
export function resetAiCapabilities(): void {
  cached = null;
  inflight = null;
}

export type AiCapabilityState = AiCapabilities & { loaded: boolean };

export function useAiCapabilities(): AiCapabilityState {
  const [caps, setCaps] = useState<AiCapabilities | null>(cached);
  useEffect(() => {
    let alive = true;
    listeners.add(setCaps);
    if (!cached) {
      loadAiCapabilities().then((c) => {
        if (alive) setCaps(c);
      });
    }
    return () => {
      alive = false;
      listeners.delete(setCaps);
    };
  }, []);
  return { ...(caps ?? NO_AI_CAPABILITIES), loaded: caps !== null };
}
