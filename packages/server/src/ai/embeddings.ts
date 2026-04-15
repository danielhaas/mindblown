/**
 * Semantic search support — embed node text via Ollama's embedding model,
 * store the vector as jsonb on the nodes table, rank by cosine similarity
 * in JS. Runs fire-and-forget after node mutations so write latency stays flat.
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { nodes } from '../db/schema.js';
import { embed, aiEnabled } from './client.js';

// ── Pure helpers ───────────────────────────────────────────────

/** Cosine similarity between two equal-length float vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Build the text we embed for a node: title + stripped description.
 * Description is ProseMirror JSON — we extract any `text` fields recursively
 * so the vector captures body content too.
 */
export function embeddingSourceText(node: {
  text: string;
  description?: unknown;
}): string {
  const parts: string[] = [node.text];
  if (node.description) {
    const body = extractProseMirrorText(node.description);
    if (body) parts.push(body);
  }
  return parts.join('\n').trim();
}

function extractProseMirrorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const v = value as Record<string, unknown>;
  const chunks: string[] = [];
  if (typeof v.text === 'string') chunks.push(v.text);
  if (Array.isArray(v.content)) {
    for (const child of v.content) chunks.push(extractProseMirrorText(child));
  }
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

// ── Embedding computation ──────────────────────────────────────

/** Compute a single embedding; returns null if AI is disabled. */
export async function embedText(text: string): Promise<number[] | null> {
  if (!aiEnabled) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const [vec] = await embed([trimmed]);
  return vec ?? null;
}

/**
 * Compute (or reuse) an embedding for a node and write it back to the DB.
 * Idempotent: if the source text matches the last-embedded text, skips.
 * Callers that care about latency should not await this.
 */
export async function embedNodeById(nodeId: string): Promise<void> {
  if (!aiEnabled) return;
  try {
    const [row] = await db
      .select({
        id: nodes.id,
        text: nodes.text,
        description: nodes.description,
        embeddingText: nodes.embeddingText,
      })
      .from(nodes)
      .where(eq(nodes.id, nodeId));
    if (!row) return;
    const source = embeddingSourceText({ text: row.text, description: row.description });
    if (!source) return;
    if (row.embeddingText === source) return; // unchanged — skip
    const vec = await embedText(source);
    if (!vec) return;
    await db
      .update(nodes)
      .set({
        embedding: vec,
        embeddingText: source,
        embeddingUpdatedAt: new Date(),
      })
      .where(eq(nodes.id, nodeId));
  } catch (err) {
    // Never let embedding failures bubble up — this is best-effort
    // background work. Log and move on.
    console.warn(`[embeddings] failed for node ${nodeId}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Schedule an embedding refresh as a microtask — callers can fire this
 * immediately after a DB mutation without awaiting.
 */
export function scheduleEmbedNode(nodeId: string): void {
  if (!aiEnabled) return;
  queueMicrotask(() => {
    void embedNodeById(nodeId);
  });
}

// ── Semantic search ────────────────────────────────────────────

export interface SemanticMatch {
  nodeId: string;
  text: string;
  score: number;
}

/**
 * Return the top-k nodes in a map ranked by cosine similarity to `query`.
 * Nodes without an embedding are skipped silently.
 */
export async function semanticSearch(
  mapId: string,
  query: string,
  limit = 10,
): Promise<SemanticMatch[]> {
  if (!aiEnabled) return [];
  const queryVec = await embedText(query);
  if (!queryVec) return [];

  const rows = await db
    .select({
      id: nodes.id,
      text: nodes.text,
      embedding: nodes.embedding,
    })
    .from(nodes)
    .where(and(eq(nodes.mapId, mapId), isNotNull(nodes.embedding)));

  const scored: SemanticMatch[] = [];
  for (const r of rows) {
    if (!Array.isArray(r.embedding)) continue;
    const score = cosineSimilarity(queryVec, r.embedding as number[]);
    scored.push({ nodeId: r.id, text: r.text, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Math.min(limit, 50)));
}

/**
 * Embed every node in the map that's missing or stale. Returns counts.
 */
export async function backfillMapEmbeddings(
  mapId: string,
): Promise<{ embedded: number; skipped: number; total: number }> {
  if (!aiEnabled) return { embedded: 0, skipped: 0, total: 0 };

  const rows = await db
    .select({
      id: nodes.id,
      text: nodes.text,
      description: nodes.description,
      embeddingText: nodes.embeddingText,
    })
    .from(nodes)
    .where(eq(nodes.mapId, mapId));

  let embedded = 0;
  let skipped = 0;

  for (const row of rows) {
    const source = embeddingSourceText({ text: row.text, description: row.description });
    if (!source) {
      skipped++;
      continue;
    }
    if (row.embeddingText === source) {
      skipped++;
      continue;
    }
    try {
      const vec = await embedText(source);
      if (!vec) {
        skipped++;
        continue;
      }
      await db
        .update(nodes)
        .set({
          embedding: vec,
          embeddingText: source,
          embeddingUpdatedAt: new Date(),
        })
        .where(eq(nodes.id, row.id));
      embedded++;
    } catch (err) {
      console.warn(`[embeddings] backfill failed for ${row.id}:`, err instanceof Error ? err.message : err);
      skipped++;
    }
  }

  return { embedded, skipped, total: rows.length };
}
