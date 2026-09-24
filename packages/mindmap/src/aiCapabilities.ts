/**
 * Client-side view of the server's AI capability flags, per map.
 *
 * Fetched from `/api/ai/config?mapId=…` (or without a map for the
 * workspace-level view) and shared by every component that shows an AI
 * affordance (chat button, breakdown / brain dump / refine context-menu
 * items, the AI estimate button, semantic search enrichment, the triage
 * toggle). A map's own AI policy (#375: any / local / none) is folded into
 * the answer server-side, so a `none` map simply reads all-false here.
 *
 * Until the answer arrives — and whenever the fetch fails, e.g. before
 * login — every flag reads false, so nothing flashes that would fail on
 * click. A failed fetch is not cached: the next mount retries. Changing a
 * map's policy calls `invalidateAiCapabilities(mapId)` so open views
 * re-read.
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

const GLOBAL = '';
const cached = new Map<string, AiCapabilities>();
const inflight = new Map<string, Promise<AiCapabilities>>();
const listeners = new Map<string, Set<(caps: AiCapabilities) => void>>();

function key(mapId?: string | null): string {
  return mapId ?? GLOBAL;
}

function normalize(raw: Partial<AiCapabilities> | undefined): AiCapabilities {
  return {
    enabled: raw?.enabled === true,
    chat: raw?.chat === true,
    structured: raw?.structured === true,
    embeddings: raw?.embeddings === true,
    triage: raw?.triage === true,
  };
}

function notify(k: string, caps: AiCapabilities): void {
  listeners.get(k)?.forEach((fn) => fn(caps));
}

/** Resolve the capabilities for a map (or the workspace), sharing one request per key. */
export function loadAiCapabilities(mapId?: string | null): Promise<AiCapabilities> {
  const k = key(mapId);
  const hit = cached.get(k);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(k);
  if (running) return running;
  const p = aiConfig(mapId ?? undefined)
    .then((cfg) => {
      const caps = normalize(cfg.capabilities);
      cached.set(k, caps);
      notify(k, caps);
      return caps;
    })
    .catch(() => NO_AI_CAPABILITIES)
    .finally(() => {
      inflight.delete(k);
    });
  inflight.set(k, p);
  return p;
}

/** Synchronous read of whatever is known right now (all false until loaded). */
export function currentAiCapabilities(mapId?: string | null): AiCapabilities {
  return cached.get(key(mapId)) ?? NO_AI_CAPABILITIES;
}

/** Forget a map's answer (after its policy changed) and re-fetch for anyone listening. */
export function invalidateAiCapabilities(mapId?: string | null): Promise<AiCapabilities> {
  const k = key(mapId);
  cached.delete(k);
  return loadAiCapabilities(mapId);
}

/** Test seam — forget every cached answer. */
export function resetAiCapabilities(): void {
  cached.clear();
  inflight.clear();
}

export type AiCapabilityState = AiCapabilities & { loaded: boolean };

export function useAiCapabilities(mapId?: string | null): AiCapabilityState {
  const k = key(mapId);
  const [caps, setCaps] = useState<AiCapabilities | null>(cached.get(k) ?? null);
  useEffect(() => {
    let alive = true;
    const set = (c: AiCapabilities) => {
      if (alive) setCaps(c);
    };
    if (!listeners.has(k)) listeners.set(k, new Set());
    listeners.get(k)!.add(set);
    const known = cached.get(k);
    if (known) setCaps(known);
    else {
      setCaps(null);
      loadAiCapabilities(mapId).then(set);
    }
    return () => {
      alive = false;
      listeners.get(k)?.delete(set);
    };
  }, [k, mapId]);
  return { ...(caps ?? NO_AI_CAPABILITIES), loaded: caps !== null };
}
