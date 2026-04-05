import { db } from './connection.js';
import { comments, users } from './schema.js';
import { eq, and } from 'drizzle-orm';

export interface CreateCommentInput {
  nodeId: string;
  userId: string;
  text: string;
}

export async function createComment(input: CreateCommentInput) {
  const [comment] = await db.insert(comments).values({
    nodeId: input.nodeId,
    userId: input.userId,
    text: input.text,
  }).returning();
  return comment;
}

export async function listComments(nodeId: string) {
  const rows = await db
    .select({
      id: comments.id,
      nodeId: comments.nodeId,
      userId: comments.userId,
      text: comments.text,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
      userName: users.name,
      userEmail: users.email,
    })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .where(eq(comments.nodeId, nodeId))
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

export async function deleteComment(commentId: string) {
  const [deleted] = await db
    .delete(comments)
    .where(eq(comments.id, commentId))
    .returning();
  return deleted ?? null;
}
