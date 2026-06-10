/**
 * AI client module — thin wrapper around the OpenAI SDK pointed at a local
 * Ollama instance (or any OpenAI-compatible endpoint).
 *
 * Env vars:
 *   AI_BASE_URL   — e.g. http://192.168.178.101:11434/v1  (required for AI features)
 *   AI_MODEL      — chat model, default "qwen2.5:14b"
 *   AI_EMBED_MODEL — embedding model, default "nomic-embed-text"
 */

import OpenAI from 'openai';

// ── Configuration ──────────────────────────────────────────────

const AI_BASE_URL = process.env.AI_BASE_URL ?? '';
const AI_MODEL = process.env.AI_MODEL ?? 'qwen2.5:14b';
const AI_EMBED_MODEL = process.env.AI_EMBED_MODEL ?? 'nomic-embed-text';

/** True when AI_BASE_URL is configured — gates all AI features. */
export const aiEnabled = AI_BASE_URL.length > 0;

// ── Concurrency guard ──────────────────────────────────────────
//
// Ollama serves one request per loaded model at a time; piling parallel
// requests on it deadlocks the host and surfaces here as 502s from the
// route handlers. We gate every chat/embed call through a small semaphore
// so concurrent callers queue instead of fan out. Default 1 (strict
// serialization); override with AI_MAX_CONCURRENCY for a beefier backend.
const AI_MAX_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.AI_MAX_CONCURRENCY ?? '1', 10) || 1,
);

let _inFlight = 0;
const _waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (_inFlight < AI_MAX_CONCURRENCY) {
    _inFlight += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    _waiters.push(() => {
      _inFlight += 1;
      resolve();
    });
  });
}

function release(): void {
  _inFlight -= 1;
  const next = _waiters.shift();
  if (next) next();
}

export async function withAiSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

// ── Client singleton ───────────────────────────────────────────

let _client: OpenAI | null = null;

export function getClient(): OpenAI {
  if (!_client) {
    if (!aiEnabled) {
      throw new Error('AI features are disabled — set AI_BASE_URL env var');
    }
    _client = new OpenAI({
      baseURL: AI_BASE_URL,
      apiKey: 'ollama',          // Ollama ignores this but the SDK requires it
    });
  }
  return _client;
}

// ── Chat completion ────────────────────────────────────────────

export type ChatMessage = OpenAI.ChatCompletionMessageParam;

export interface ChatOptions {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** If provided, request JSON output matching this schema description. */
  jsonSchema?: { name: string; description?: string };
}

/**
 * Run a chat completion against the configured model.
 * Returns the assistant's message content as a string.
 */
export async function chatCompletion(opts: ChatOptions): Promise<string> {
  const client = getClient();

  const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
    model: opts.model ?? AI_MODEL,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 2048,
  };

  // Request JSON mode when a schema hint is provided
  if (opts.jsonSchema) {
    params.response_format = { type: 'json_object' };
  }

  return withAiSlot(async () => {
    const res = await client.chat.completions.create(params);
    return res.choices[0]?.message?.content ?? '';
  });
}

/**
 * Stream a chat completion. Returns an async iterable of content deltas.
 */
export async function chatCompletionStream(
  opts: Omit<ChatOptions, 'jsonSchema'>,
): Promise<AsyncIterable<string>> {
  const client = getClient();

  const stream = await client.chat.completions.create({
    model: opts.model ?? AI_MODEL,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 2048,
    stream: true,
  });

  return {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
    },
  };
}

// ── Embeddings ─────────────────────────────────────────────────

/**
 * Compute embeddings for one or more texts.
 * Returns an array of float arrays, one per input text.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  const client = getClient();

  return withAiSlot(async () => {
    const res = await client.embeddings.create({
      model: AI_EMBED_MODEL,
      input: texts,
    });

    return res.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  });
}

// ── Helpers ────────────────────────────────────────────────────

/** Return current AI config (safe to log — no secrets). */
export function aiConfig() {
  return {
    enabled: aiEnabled,
    baseUrl: AI_BASE_URL || '(not set)',
    model: AI_MODEL,
    embedModel: AI_EMBED_MODEL,
  };
}
