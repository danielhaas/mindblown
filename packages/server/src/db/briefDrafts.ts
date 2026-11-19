/** Rows of brief_drafts — what the brief-draft job did per node (services/briefDrafts.ts). */
import { inArray } from 'drizzle-orm';
import { db } from './connection.js';
import { briefDrafts } from './schema.js';

export type BriefDraftOutcome = 'drafted' | 'question';

export interface StoredBriefDraft {
  nodeId: string;
  textHash: string;
  outcome: BriefDraftOutcome;
  /** The AI's question, when it could not write a brief. */
  question: string | null;
  provider: string | null;
}

export async function listBriefDrafts(nodeIds: string[]): Promise<StoredBriefDraft[]> {
  if (nodeIds.length === 0) return [];
  const rows = await db.select().from(briefDrafts).where(inArray(briefDrafts.nodeId, nodeIds));
  return rows.map((r) => ({
    nodeId: r.nodeId,
    textHash: r.textHash,
    outcome: r.outcome === 'question' ? 'question' : 'drafted',
    question: r.question ?? null,
    provider: r.provider ?? null,
  }));
}

/** One row per node: a new attempt replaces the old one. */
export async function saveBriefDraft(row: StoredBriefDraft): Promise<void> {
  const values = { ...row, createdAt: new Date() };
  const { nodeId: _id, ...set } = values;
  await db.insert(briefDrafts).values(values).onConflictDoUpdate({ target: briefDrafts.nodeId, set });
}
