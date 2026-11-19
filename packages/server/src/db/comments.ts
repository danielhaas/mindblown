import { db } from './connection.js';
import { comments, users } from './schema.js';
import { eq, and, gt, type SQL } from 'drizzle-orm';
import type { CommentKind } from '@mindblown/core';

export interface CreateCommentInput {
  nodeId: string;
  userId: string;
  text: string;
  /** Default 'comment'. */
  kind?: CommentKind;
}

export interface ListCommentsFilter {
  kind?: CommentKind;
  /** Only comments created after this instant. */
  since?: Date;
}

export async function createComment(input: CreateCommentInput) {
  const [comment] = await db.insert(comments).values({
    nodeId: input.nodeId,
    userId: input.userId,
    text: input.text,
    kind: input.kind ?? 'comment',
  }).returning();
  return comment;
}

export async function listComments(nodeId: string, filter: ListCommentsFilter = {}) {
  const where: SQL[] = [eq(comments.nodeId, nodeId)];
  if (filter.kind) where.push(eq(comments.kind, filter.kind));
  if (filter.since) where.push(gt(comments.createdAt, filter.since));
  const rows = await db
    .select({
      id: comments.id,
      nodeId: comments.nodeId,
      userId: comments.userId,
      text: comments.text,
      kind: comments.kind,
      deliveredAt: comments.deliveredAt,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
      userName: users.name,
      userEmail: users.email,
    })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .where(and(...where))
    .orderBy(comments.createdAt);

  return rows;
}

export async function getComment(commentId: string) {
  const [comment] = await db
    .select()
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1);
  return comment ?? null;
}

export async function updateComment(commentId: string, text: string) {
  const [updated] = await db
    .update(comments)
    .set({ text, updatedAt: new Date() })
    .where(eq(comments.id, commentId))
    .returning();
  return updated ?? null;
}

/** Mark a fleet note as picked up by the worker. Returns the updated row with the author's name. */
export async function markCommentDelivered(commentId: string, deliveredAt: Date) {
  const [updated] = await db
    .update(comments)
    .set({ deliveredAt, updatedAt: new Date() })
    .where(eq(comments.id, commentId))
    .returning();
  return updated ?? null;
}

export async function deleteComment(commentId: string) {
  const [deleted] = await db
    .delete(comments)
    .where(eq(comments.id, commentId))
    .returning();
  return deleted ?? null;
}
