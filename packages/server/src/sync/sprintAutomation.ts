/**
 * Sprint automation (#154, #192): sprints follow their dates on their own.
 *
 * Hourly, on every map that is not archived: planned sprints whose window
 * has opened become active, open sprints whose end date has passed are
 * completed and their unfinished items roll into the next open sprint of
 * the same version. The rules live in core `planSprintTransitions`; this
 * applies them through the same db calls the Sprint panel uses
 * (`updateCycle` — including the activation sweep that moves status-less
 * items to todo — and `autoRollover`), and broadcasts what changed.
 */
import { isNull } from 'drizzle-orm';
import { planSprintTransitions, type SprintLike } from '@mindblown/core';
import { db } from '../db/connection.js';
import { maps } from '../db/schema.js';
import * as cycleDb from '../db/cycles.js';
import * as nodeDb from '../db/nodes.js';
import { broadcast } from '../ws.js';

export interface SprintAutomationResult {
  activated: string[];
  completed: string[];
  rolledOver: number;
  errors: string[];
}

export async function runSprintAutomation(now: Date = new Date()): Promise<SprintAutomationResult> {
  const result: SprintAutomationResult = { activated: [], completed: [], rolledOver: 0, errors: [] };
  const liveMaps = await db.select({ id: maps.id }).from(maps).where(isNull(maps.archivedAt));

  for (const { id: mapId } of liveMaps) {
    const sprints = await cycleDb.listCycles(mapId);
    if (sprints.length === 0) continue;
    const transitions = planSprintTransitions(sprints as SprintLike[], now);
    for (const t of transitions) {
      try {
        if (t.action === 'complete') {
          if (t.rollToSprintId) {
            const rolled = await cycleDb.autoRollover(t.sprintId, t.rollToSprintId);
            result.rolledOver += rolled.movedCount;
            for (const id of rolled.movedNodeIds) {
              const node = await nodeDb.getNode(id);
              if (node) broadcast(mapId, { type: 'node:updated', nodeId: id, fields: ['cycleId'], node });
            }
          }
          await cycleDb.updateCycle(t.sprintId, { status: 'completed' });
          result.completed.push(t.sprintId);
        } else {
          const updated = await cycleDb.updateCycle(t.sprintId, { status: 'active' });
          for (const node of updated?.sweptNodes ?? []) {
            broadcast(mapId, { type: 'node:updated', nodeId: node.id, fields: ['status'], node });
          }
          result.activated.push(t.sprintId);
        }
        broadcast(mapId, { type: 'cycle:updated', cycleId: t.sprintId });
      } catch (err) {
        result.errors.push(`${t.action} ${t.sprintId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return result;
}
