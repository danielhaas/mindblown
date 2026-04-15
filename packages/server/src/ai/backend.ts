/**
 * Direct-DB backend for @mindblown/tool-kit — runs inside the server process,
 * used by the in-app AI chat. Mirrors what packages/mcp/src/backend.ts does over
 * HTTP, but hits the database directly and broadcasts WebSocket events for each
 * mutation so connected map viewers update in real time.
 */

import type { ToolBackend, MapDetail, MapSummary, NodeWithComputed } from '@mindblown/tool-kit';
import { computeTree } from '@mindblown/core';
import type { Node as CoreNode, MindMap } from '@mindblown/core';
import * as mapDb from '../db/maps.js';
import * as nodeDb from '../db/nodes.js';
import { broadcast } from '../ws.js';
import { scheduleEmbedNode } from './embeddings.js';

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date().toISOString();
}

function toMapSummary(m: MindMap, computedProgress = 0, healthSignal = 'on_track'): MapSummary {
  return {
    id: m.id,
    workspaceId: m.workspaceId,
    name: m.name,
    description: m.description,
    rootNodeId: m.rootNodeId,
    effortUnit: m.effortUnit,
    healthThreshold: m.healthThreshold,
    computedProgress,
    healthSignal,
    createdAt: toIsoString((m as unknown as { createdAt: unknown }).createdAt),
    updatedAt: toIsoString((m as unknown as { updatedAt: unknown }).updatedAt),
  };
}

function toNodeWithComputed(
  node: CoreNode,
  computed: { computedEffort: number; computedProgress: number; healthSignal: string } | undefined,
): NodeWithComputed {
  return {
    id: node.id,
    mapId: node.mapId,
    parentId: node.parentId,
    childrenIds: node.childrenIds,
    text: node.text,
    description: node.description,
    effortEstimate: node.effortEstimate,
    actualEffort: node.actualEffort,
    percentComplete: node.percentComplete,
    status: node.status,
    assigneeIds: node.assigneeIds,
    priority: node.priority,
    dueDate: node.dueDate,
    startDate: node.startDate,
    tags: node.tags,
    dependencies: node.dependencies.map((d) => ({
      targetNodeId: d.targetNodeId,
      type: d.type,
      lag: d.lag,
    })),
    isMilestone: node.isMilestone,
    versionId: node.versionId,
    milestoneId: node.milestoneId,
    cycleId: node.cycleId,
    externalLinks: node.externalLinks.map((l) => ({
      provider: l.provider,
      externalId: l.externalId,
      url: l.url,
      syncEnabled: l.syncEnabled,
      lastSyncedAt: l.lastSyncedAt,
    })),
    collapsed: node.collapsed,
    createdAt: toIsoString((node as unknown as { createdAt: unknown }).createdAt),
    updatedAt: toIsoString((node as unknown as { updatedAt: unknown }).updatedAt),
    computedEffort: computed?.computedEffort ?? 0,
    computedProgress: computed?.computedProgress ?? 0,
    healthSignal: computed?.healthSignal ?? 'on_track',
  };
}

/**
 * Builds a backend scoped to a single authenticated user. Mutations broadcast
 * on the relevant mapId so connected frontends update in real time.
 */
export function createChatBackend(userId: string): ToolBackend {
  return {
    async listMaps(): Promise<MapSummary[]> {
      const all = await mapDb.listMaps();
      return Promise.all(
        all.map(async (m) => {
          const data = await mapDb.getMap(m.id);
          if (!data || data.nodes.length === 0) return toMapSummary(m);
          const computed = computeTree(data.nodes, m.healthThreshold);
          const rootComputed = computed.get(m.rootNodeId);
          return toMapSummary(
            m,
            rootComputed?.computedProgress ?? 0,
            rootComputed?.healthSignal ?? 'on_track',
          );
        }),
      );
    },

    async getMap(mapId: string): Promise<MapDetail> {
      const data = await mapDb.getMap(mapId);
      if (!data) throw new Error(`Map ${mapId} not found`);
      const computed = computeTree(data.nodes, data.map.healthThreshold);
      const nodesWithComputed = data.nodes.map((node) => toNodeWithComputed(node, computed.get(node.id)));
      const rootComputed = computed.get(data.map.rootNodeId);
      const summary = toMapSummary(
        data.map,
        rootComputed?.computedProgress ?? 0,
        rootComputed?.healthSignal ?? 'on_track',
      );
      return {
        map: {
          ...summary,
          statusWorkflow: data.map.statusWorkflow,
          baselines: data.map.baselines,
          wipLimit: data.map.wipLimit,
        },
        nodes: nodesWithComputed,
      };
    },

    async createMap(name, description) {
      const result = await mapDb.createMap({
        name,
        description,
        workspaceId: 'default',
        createdBy: userId,
      });
      return { id: result.map.id, name: result.map.name };
    },

    async updateMap(mapId, fields) {
      const updated = await mapDb.updateMap(mapId, fields);
      if (!updated) throw new Error(`Map ${mapId} not found`);
      return toMapSummary(updated);
    },

    async deleteMap(mapId) {
      const ok = await mapDb.deleteMap(mapId);
      if (!ok) throw new Error(`Map ${mapId} not found`);
    },

    async createNode(mapId, parentId, text, fields) {
      const node = await nodeDb.createNode({
        mapId,
        parentId,
        text,
        createdBy: userId,
        ...(fields ?? {}),
      });
      broadcast(mapId, { type: 'node:created', node });
      scheduleEmbedNode(node.id);
      return toNodeWithComputed(node, undefined);
    },

    async updateNode(mapId, nodeId, fields) {
      const updated = await nodeDb.updateNode(nodeId, fields);
      if (!updated) throw new Error(`Node ${nodeId} not found`);
      broadcast(mapId, {
        type: 'node:updated',
        nodeId,
        fields: Object.keys(fields),
        node: updated,
      });
      if ('text' in fields || 'description' in fields) {
        scheduleEmbedNode(nodeId);
      }
      return toNodeWithComputed(updated, undefined);
    },

    async deleteNode(mapId, nodeId) {
      const deletedIds = await nodeDb.deleteNode(nodeId);
      if (deletedIds.length === 0) throw new Error(`Node ${nodeId} not found`);
      broadcast(mapId, { type: 'node:deleted', nodeId, deletedIds });
    },

    async moveNode(mapId, nodeId, newParentId, _position) {
      const moved = await nodeDb.moveNode(nodeId, newParentId);
      if (!moved) throw new Error(`Node ${nodeId} not found`);
      broadcast(mapId, { type: 'node:moved', nodeId, newParentId });
      return toNodeWithComputed(moved, undefined);
    },
  };
}
