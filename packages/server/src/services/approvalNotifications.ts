/**
 * Push when tickets wait for approval (#493).
 *
 * Batched per map: a push goes out once the oldest ticket nobody was told
 * about has waited SETTLE_MS, so a burst of proposals lands as one push,
 * and never more than one push per map per hour. A ticket still proposed
 * after 24 h is named in one more push, then never again. The recipient is
 * the configured Pushover user key — in v1 it stands for the map's trusted
 * people. State lives in approval_notifications (per map) and
 * approval_reminders (per node), so a restart does not re-send.
 */
import { inArray, isNull } from 'drizzle-orm';
import { buildIsDonePredicate } from '@mindblown/core';
import { db } from '../db/connection.js';
import { approvalNotifications, approvalReminders, maps } from '../db/schema.js';
import * as mapDb from '../db/maps.js';
import * as nodeDb from '../db/nodes.js';
import { pushoverConfigured, sendPush } from '../lib/pushover.js';

export const RATE_LIMIT_MS = 60 * 60 * 1000;
export const SETTLE_MS = 10 * 60 * 1000;
export const REMINDER_AFTER_MS = 24 * 60 * 60 * 1000;

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5180';

export interface WaitingTicket {
  nodeId: string;
  /** When it became proposed (the stamp's `at`). */
  proposedAt: Date;
  /** Already named in a 24 h reminder. */
  reminded: boolean;
}

export interface ApprovalPushPlan {
  /** Every ticket waiting on the map — the number the push names. */
  waiting: number;
  /** Tickets this push reminds about; mark them reminded once it is sent. */
  remind: string[];
}

/** Should this map get a push now? null = no. Pure; the clock comes in as `now`. */
export function planApprovalPush(now: Date, lastPushedAt: Date | null, waiting: WaitingTicket[]): ApprovalPushPlan | null {
  if (waiting.length === 0) return null;
  const t = now.getTime();
  if (lastPushedAt && t - lastPushedAt.getTime() < RATE_LIMIT_MS) return null;
  const fresh = waiting.filter((w) => !lastPushedAt || w.proposedAt > lastPushedAt);
  const settled = fresh.some((w) => t - w.proposedAt.getTime() >= SETTLE_MS);
  const remind = waiting.filter((w) => !w.reminded && t - w.proposedAt.getTime() >= REMINDER_AFTER_MS).map((w) => w.nodeId);
  if (!settled && remind.length === 0) return null;
  return { waiting: waiting.length, remind };
}

export function approvalPushMessage(plan: ApprovalPushPlan, mapName: string): string {
  const head = `${plan.waiting} ${plan.waiting === 1 ? 'ticket' : 'tickets'} waiting for approval (${mapName})`;
  return plan.remind.length > 0 ? `${head} — ${plan.remind.length} for over 24 h` : head;
}

export interface ApprovalNotificationResult {
  pushed: number;
  errors: string[];
}

/** One tick: a push for each map that is due. No-op without Pushover keys. */
export async function runApprovalNotifications(now: Date = new Date()): Promise<ApprovalNotificationResult> {
  const result: ApprovalNotificationResult = { pushed: 0, errors: [] };
  if (!pushoverConfigured()) return result;

  const activeMaps = await db.select({ id: maps.id, name: maps.name }).from(maps).where(isNull(maps.archivedAt));
  const proposed = await nodeDb.listProposedNodes(activeMaps.map((m) => m.id));
  if (proposed.length === 0) return result;

  // Done by the map's own workflow is not waiting on anyone (as listPendingApprovals reads it).
  const isDone = new Map<string, (status: string | null) => boolean>();
  const byMap = new Map<string, WaitingTicket[]>();
  const reminded = new Set(
    (await db.select({ nodeId: approvalReminders.nodeId }).from(approvalReminders).where(inArray(approvalReminders.nodeId, proposed.map((n) => n.id))))
      .map((r) => r.nodeId),
  );
  for (const n of proposed) {
    if (!n.approval) continue;
    if (!isDone.has(n.mapId)) isDone.set(n.mapId, buildIsDonePredicate((await mapDb.getStatusWorkflow(n.mapId)) ?? []));
    if (n.status === 'done' || n.status === 'cancelled' || isDone.get(n.mapId)!(n.status)) continue;
    const list = byMap.get(n.mapId) ?? [];
    list.push({ nodeId: n.id, proposedAt: new Date(n.approval.at), reminded: reminded.has(n.id) });
    byMap.set(n.mapId, list);
  }
  if (byMap.size === 0) return result;

  const last = new Map(
    (await db.select().from(approvalNotifications).where(inArray(approvalNotifications.mapId, [...byMap.keys()])))
      .map((r) => [r.mapId, r.lastPushedAt]),
  );
  const names = new Map(activeMaps.map((m) => [m.id, m.name]));
  for (const [mapId, waiting] of byMap) {
    const plan = planApprovalPush(now, last.get(mapId) ?? null, waiting);
    if (!plan) continue;
    try {
      const sent = await sendPush({
        title: 'MindBlown',
        message: approvalPushMessage(plan, names.get(mapId) ?? 'a map'),
        url: `${FRONTEND_URL}/?map=${mapId}&view=fleet#approvals`,
        urlTitle: 'Open approvals',
      });
      if (!sent) {
        result.errors.push(`map ${mapId}: push not accepted`);
        continue;
      }
      await db
        .insert(approvalNotifications)
        .values({ mapId, lastPushedAt: now })
        .onConflictDoUpdate({ target: approvalNotifications.mapId, set: { lastPushedAt: now } });
      if (plan.remind.length > 0) {
        await db
          .insert(approvalReminders)
          .values(plan.remind.map((nodeId) => ({ nodeId, remindedAt: now })))
          .onConflictDoNothing();
      }
      result.pushed++;
    } catch (err) {
      result.errors.push(`map ${mapId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
