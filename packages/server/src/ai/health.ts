/**
 * Reachability of the configured local AI backends (#429).
 *
 * `capabilities.ts` used to derive "available" from configuration alone,
 * so when the local GPU host went away MindBlown kept offering AI for a
 * week: every node edit tried to embed and 502'd, semantic search ran on
 * stale vectors, and triage on a `local` map would have failed silently.
 *
 * A probe every PROBE_INTERVAL_MS asks each configured backend a cheap
 * question — chat: is `AI_MODEL` in `GET /models`; embeddings: one tiny
 * embedding — and keeps the answer here. Capabilities fold it in, the
 * config route and `/api/health/ai` report it, and a failed embedding
 * call marks the embedder down at once so node edits stop hammering a
 * dead host until the next probe sees it back. Unknown (no probe yet)
 * counts as reachable: a cold start must not hide AI for a minute.
 */

import { aiEnabled, embedEnabled, getClient, probeEmbedding, AI_MODEL_NAME } from './client.js';

export interface BackendHealth {
  configured: boolean;
  /** null until the first probe answered. */
  reachable: boolean | null;
  checkedAt: string | null;
  /** When it went from reachable/unknown to unreachable; null while up. */
  downSince: string | null;
  lastError: string | null;
}

const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_INTERVAL_MS = 60_000;

const fresh = (configured: boolean): BackendHealth => ({
  configured,
  reachable: null,
  checkedAt: null,
  downSince: null,
  lastError: null,
});

const state = {
  chat: fresh(aiEnabled),
  embeddings: fresh(embedEnabled),
};

function record(which: 'chat' | 'embeddings', ok: boolean, error: string | null): void {
  const h = state[which];
  const now = new Date().toISOString();
  if (!ok && h.reachable !== false) {
    h.downSince = now;
    console.warn(`[ai-health] ${which} backend unreachable: ${error}`);
  }
  if (ok && h.reachable === false) console.log(`[ai-health] ${which} backend reachable again`);
  h.reachable = ok;
  h.checkedAt = now;
  h.lastError = ok ? null : error;
  if (ok) h.downSince = null;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export async function probeChat(): Promise<void> {
  if (!aiEnabled) return;
  try {
    const page = await getClient().models.list({ timeout: PROBE_TIMEOUT_MS });
    const ids = page.data.map((m) => m.id);
    if (ids.includes(AI_MODEL_NAME)) record('chat', true, null);
    else record('chat', false, `model ${AI_MODEL_NAME} is not served (has: ${ids.slice(0, 5).join(', ') || 'none'})`);
  } catch (err) {
    record('chat', false, errText(err));
  }
}

export async function probeEmbeddings(): Promise<void> {
  if (!embedEnabled) return;
  try {
    await probeEmbedding(PROBE_TIMEOUT_MS);
    record('embeddings', true, null);
  } catch (err) {
    record('embeddings', false, errText(err));
  }
}

/** A real embedding call failed: stop sending more until the probe sees the backend back. */
export function markEmbeddingsFailed(err: unknown): void {
  record('embeddings', false, errText(err));
}

/** Configured and not known to be down. */
export const localChatUsable = (): boolean => aiEnabled && state.chat.reachable !== false;
export const embeddingsUsable = (): boolean => embedEnabled && state.embeddings.reachable !== false;

export function aiHealth(): { chat: BackendHealth; embeddings: BackendHealth } {
  return { chat: { ...state.chat }, embeddings: { ...state.embeddings } };
}

let timer: NodeJS.Timeout | null = null;

/** Probe now, then every PROBE_INTERVAL_MS. Idempotent. */
export function startAiHealthProbe(): void {
  if (timer || (!aiEnabled && !embedEnabled)) return;
  const tick = () => void Promise.all([probeChat(), probeEmbeddings()]);
  tick();
  timer = setInterval(tick, PROBE_INTERVAL_MS);
  timer.unref?.();
}

/** Test hook. */
export function _resetAiHealthForTests(): void {
  state.chat = fresh(aiEnabled);
  state.embeddings = fresh(embedEnabled);
}
