/** Rows of approval_reviews — the AI's read of a proposed ticket (services/approvalReview.ts). */
import { and, eq, inArray } from 'drizzle-orm';
import type { ApprovalReview, ApprovalReviewVerdict } from '@mindblown/core';
import { db } from './connection.js';
import { approvalReviews } from './schema.js';

export interface StoredApprovalReview extends ApprovalReview {
  nodeId: string;
  textHash: string;
}

export async function listApprovalReviews(nodeIds: string[]): Promise<StoredApprovalReview[]> {
  if (nodeIds.length === 0) return [];
  const rows = await db.select().from(approvalReviews).where(inArray(approvalReviews.nodeId, nodeIds));
  return rows.map((r) => ({
    nodeId: r.nodeId,
    textHash: r.textHash,
    verdict: r.verdict as ApprovalReviewVerdict,
    reason: r.reason,
    questions: r.questions,
    provider: r.provider,
    reviewedAt: r.reviewedAt.toISOString(),
    askedAt: r.askedAt ? r.askedAt.toISOString() : null,
  }));
}

/** A new review is about new words: it replaces the row, `askedAt` included. */
export async function saveApprovalReview(row: StoredApprovalReview): Promise<void> {
  const values = {
    nodeId: row.nodeId,
    textHash: row.textHash,
    verdict: row.verdict,
    reason: row.reason,
    questions: row.questions,
    provider: row.provider,
    reviewedAt: new Date(row.reviewedAt),
    askedAt: row.askedAt ? new Date(row.askedAt) : null,
  };
  const { nodeId: _id, ...set } = values;
  await db.insert(approvalReviews).values(values).onConflictDoUpdate({ target: approvalReviews.nodeId, set });
}

/** Mark the review of this text as asked on the issue. No row for this text = nothing marked. */
export async function markReporterAsked(nodeId: string, textHash: string, at: Date): Promise<void> {
  await db
    .update(approvalReviews)
    .set({ askedAt: at })
    .where(and(eq(approvalReviews.nodeId, nodeId), eq(approvalReviews.textHash, textHash)));
}
