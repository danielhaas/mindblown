/**
 * Comment rules shared by the REST routes and the in-app chat backend —
 * mostly for the fleet note (claude-fleet#92): a person's note to the agent
 * running a ticket. The worker polls `?kind=fleet-note&since=<claim time>`,
 * hands each note to its agent and marks it delivered.
 */
import { isCommentKind, type CommentKind, type NodeComment } from '@mindblown/core';
import * as commentDb from '../db/comments.js';

export interface CommentError {
  status: 400 | 404 | 409;
  code: 'VALIDATION_ERROR' | 'COMMENT_NOT_FOUND' | 'NOT_A_FLEET_NOTE';
  message: string;
}

const invalid = (message: string): CommentError => ({ status: 400, code: 'VALIDATION_ERROR', message });

/** A comment kind from a request — absent means 'comment'. */
export function parseCommentKind(v: unknown): CommentKind | CommentError {
  if (v === undefined || v === null || v === '') return 'comment';
  return isCommentKind(v) ? v : invalid(`kind must be 'comment' or 'fleet-note'`);
}

function parseInstant(v: unknown, field: string): Date | CommentError {
  const d = typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : invalid(`${field} must be an ISO 8601 timestamp`);
}

/** The list filter from `?kind=&since=`. */
export function parseCommentFilter(q: { kind?: unknown; since?: unknown }): commentDb.ListCommentsFilter | CommentError {
  const filter: commentDb.ListCommentsFilter = {};
  if (q.kind !== undefined && q.kind !== '') {
    if (!isCommentKind(q.kind)) return invalid(`kind must be 'comment' or 'fleet-note'`);
    filter.kind = q.kind;
  }
  if (q.since !== undefined && q.since !== '') {
    const since = parseInstant(q.since, 'since');
    if ('status' in since) return since;
    filter.since = since;
  }
  return filter;
}

export function isCommentError(v: unknown): v is CommentError {
  return typeof v === 'object' && v !== null && 'status' in v && 'code' in v && 'message' in v;
}

/**
 * The worker picked a fleet note up. `deliveredAt` defaults to now. Marking
 * an already delivered note again keeps the first time — the card says when
 * the agent got it, and a retried request must not move that.
 */
export async function ackFleetNote(
  nodeId: string,
  commentId: string,
  deliveredAt?: unknown,
): Promise<NonNullable<Awaited<ReturnType<typeof commentDb.getComment>>> | CommentError> {
  let at = new Date();
  if (deliveredAt !== undefined && deliveredAt !== null && deliveredAt !== true) {
    const parsed = parseInstant(deliveredAt, 'deliveredAt');
    if ('status' in parsed) return parsed;
    at = parsed;
  }
  const existing = await commentDb.getComment(commentId);
  if (!existing || existing.nodeId !== nodeId) {
    return { status: 404, code: 'COMMENT_NOT_FOUND', message: `Comment ${commentId} not found on this node` };
  }
  if (existing.kind !== 'fleet-note') {
    return { status: 409, code: 'NOT_A_FLEET_NOTE', message: 'Only a fleet note can be marked delivered' };
  }
  if (existing.deliveredAt) return existing;
  return (await commentDb.markCommentDelivered(commentId, at)) ?? existing;
}

type CommentRow = {
  id: string;
  nodeId: string;
  userId: string;
  userName?: string | null;
  text: string;
  kind: string;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** A DB row as the API shape (what JSON serialisation of the route's reply gives). */
export function toNodeComment(row: CommentRow): NodeComment {
  return {
    id: row.id,
    nodeId: row.nodeId,
    userId: row.userId,
    ...(row.userName !== undefined ? { userName: row.userName } : {}),
    text: row.text,
    kind: isCommentKind(row.kind) ? row.kind : 'comment',
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
