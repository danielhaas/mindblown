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

import OpenAI from 'openai';
import { aiEnabled, embedEnabled, getClient, probeEmbedding, AI_MODEL_NAME } from './client.js';

export interface BackendHealth {
  configured: boolean;
  /** null until the first probe answered. */
  reachable: boolean | null;
  checkedAt: string | null;
  /** When it went from reachable/unknown to unreachable; null while up. */
  downSince: string | null;
  lastError: string | null;
  /** Up, but something looks off (e.g. AI_MODEL not in the server's list). */
  warning?: string | null;
}

const PROBE_TIMEOUT_MS = 10_000;
/** A cold embedding-model load can take longer than a chat list call. */
const EMBED_PROBE_TIMEOUT_MS = 30_000;
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

const recoveryHooks: Array<() => void> = [];
/** Called when the embedder comes back after being down — the server re-embeds what changed meanwhile. */
export function onEmbeddingsRecovered(hook: () => void): void {
  recoveryHooks.push(hook);
}

function record(which: 'chat' | 'embeddings', ok: boolean, error: string | null, warning: string | null = null): void {
  const h = state[which];
  const now = new Date().toISOString();
  const wasDown = h.reachable === false;
  if (!ok && !wasDown) {
    h.downSince = now;
    console.warn(`[ai-health] ${which} backend unreachable: ${error}`);
  }
  if (ok && wasDown) console.log(`[ai-health] ${which} backend reachable again`);
  h.reachable = ok;
  h.checkedAt = now;
  h.lastError = ok ? null : error;
  h.warning = ok ? warning : null;
  if (ok) h.downSince = null;
  if (ok && wasDown && which === 'embeddings') for (const hook of recoveryHooks) hook();
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export async function probeChat(): Promise<void> {
  if (!aiEnabled) return;
  try {
    const page = await getClient().models.list({ timeout: PROBE_TIMEOUT_MS });
    const ids = page.data.map((m) => m.id);
    // The server answered: it is up. A model it does not list is only a
    // warning — servers spell ids differently (Ollama "x:latest" for "x",
    // LM Studio quantisation suffixes) and a false "down" would switch off
    // working AI.
    const base = (id: string) => id.replace(/(:latest|@[^/]+)$/, '');
    const listed = ids.some((id) => id === AI_MODEL_NAME || base(id) === base(AI_MODEL_NAME));
    record('chat', true, null, listed ? null : `model ${AI_MODEL_NAME} is not in the server's list (has: ${ids.slice(0, 5).join(', ') || 'none'})`);
  } catch (err) {
    record('chat', false, errText(err));
  }
}

export async function probeEmbeddings(): Promise<void> {
  if (!embedEnabled) return;
  try {
    await probeEmbedding(EMBED_PROBE_TIMEOUT_MS);
    record('embeddings', true, null);
  } catch (err) {
    record('embeddings', false, errText(err));
  }
}

/**
 * Down, not merely refused: no connection, a timeout, or a 5xx. A 4xx
 * (one oversized or malformed input) says nothing about the host and
 * must not switch embeddings off for everyone.
 */
export function isBackendDownError(err: unknown): boolean {
  if (err instanceof OpenAI.APIConnectionError) return true; // incl. timeouts
  if (err instanceof OpenAI.APIError) return (err.status ?? 0) >= 500;
  return false;
}

/** A real embedding call failed: if the host is down, stop sending more until the probe sees it back. */
export function markEmbeddingsFailed(err: unknown): void {
  if (isBackendDownError(err)) record('embeddings', false, errText(err));
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
