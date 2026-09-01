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
import * as orchestrationService from '../services/orchestration.js';
import { unblockNode as unblockNodeService } from '../services/unblock.js';
import * as fleetDb from '../db/fleet.js';
import { auditClosedIssues } from '../sync/closedIssueAudit.js';
import { getGitHubContextForMap } from '../lib/githubContext.js';

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
    versionId: node.versionId,
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
    requirementId: node.requirementId,
    requirementPriority: node.requirementPriority,
    requirementText: node.requirementText,
    phaseId: node.phaseId,
    claimedBySession: node.claimedBySession,
    claimedAt: node.claimedAt,
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
      const all = await mapDb.listMapsForUser(userId);
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
          phases: data.map.phases,
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
      // Attributed + broadcast like the REST route: a dispatch-knob write
      // from the in-app chat must show the chatting user in the audit and
      // reach an open cockpit without a reload.
      const updated = await mapDb.updateMap(mapId, fields, userId);
      if (!updated) throw new Error(`Map ${mapId} not found`);
      broadcast(mapId, { type: 'map:updated', map: updated });
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
      const { deletedIds } = await nodeDb.deleteNode(nodeId);
      if (deletedIds.length === 0) throw new Error(`Node ${nodeId} not found`);
      broadcast(mapId, { type: 'node:deleted', nodeId, deletedIds });
    },

    async moveNode(mapId, nodeId, newParentId, _position) {
      const moved = await nodeDb.moveNode(nodeId, newParentId);
      if (!moved) throw new Error(`Node ${nodeId} not found`);
      broadcast(mapId, { type: 'node:moved', nodeId, newParentId });
      return toNodeWithComputed(moved, undefined);
    },

    // ── Soft-delete + restore (#107) ────────────────────────────
    async restoreNode(mapId, nodeId, opts) {
      const result = await nodeDb.restoreNode(nodeId, {
        recursive: opts?.recursive === true,
      });
      const node = await nodeDb.getNode(nodeId);
      broadcast(mapId, {
        type: 'node:restored',
        nodeId,
        restoredIds: result.restoredIds,
        affectedParentIds: result.affectedParentIds,
      });
      return {
        restoredIds: result.restoredIds,
        node: node ? toNodeWithComputed(node, undefined) : null,
      };
    },

    async listDeleted(mapId, opts) {
      return nodeDb.listDeleted(mapId, opts ?? {});
    },

    // ── Triage (#96 Phase 3) ────────────────────────────────────
    // The in-app chat backend doesn't expose the triage surface — the
    // routes enforce a session-JWT-only gate (API-key auth is 403'd) for
    // blast-radius reasons (#69 / #100), which doesn't map cleanly to the
    // chat's in-process backend. Operators use the MCP HTTP backend
    // (Eve, claude code) for triage; the chat refuses the same call with
    // a clear directive rather than half-applying it.
    async listTriageDecisions(_mapId, _filters) {
      throw new Error(
        'list_triage_decisions is not available through the in-app chat — call it via the MCP HTTP endpoint.',
      );
    },
    async overrideTriage(_mapId, _decisionId, _body) {
      throw new Error(
        'override_triage is not available through the in-app chat — call it via the MCP HTTP endpoint.',
      );
    },
    async reclassifyTriage(_mapId, _decisionId) {
      throw new Error(
        'reclassify_triage is not available through the in-app chat — call it via the MCP HTTP endpoint.',
      );
    },
    async confirmTriage(_mapId, _decisionId) {
      throw new Error(
        'confirm_triage is not available through the in-app chat — call it via the MCP HTTP endpoint.',
      );
    },
    async listNotInMindBlown(_mapId, _filters) {
      throw new Error(
        'list_not_in_mindblown is not available through the in-app chat — call it via the MCP HTTP endpoint.',
      );
    },

    // ── Orchestration substrate (#111) ──────────────────────────
    // Delegates to packages/server/src/services/orchestration.ts so the
    // chat backend and the HTTP routes share one implementation.
    readyNodes: (mapId, opts) => orchestrationService.readyNodes(mapId, opts),
    getNextTicket: (mapId, sessionId, profile?) => orchestrationService.getNextTicket(mapId, sessionId, profile),
    claimNode: (mapId, nodeId, sessionId) => orchestrationService.claimNode(mapId, nodeId, sessionId),
    releaseNode: (mapId, nodeId, sessionId) => orchestrationService.releaseNode(mapId, nodeId, sessionId),
    async unblockNode(mapId, nodeId) {
      const result = await unblockNodeService(mapId, nodeId, userId);
      broadcast(mapId, { type: 'node:updated', nodeId, fields: result.changedFields, node: result.node });
      return {
        node: { id: result.node.id, text: result.node.text, status: result.node.status, claimedBySession: result.node.claimedBySession },
        statusReset: result.statusReset,
      };
    },
    conflictScan: (mapId, candidateNodeId?) => orchestrationService.conflictScan(mapId, candidateNodeId),
    async getFleetStatus(mapId) {
      const [hosts, ticks] = await Promise.all([fleetDb.listRollups(mapId), fleetDb.listTicks(mapId, 20)]);
      return { hosts, ticks, now: new Date().toISOString() };
    },

    // ── Closed-issue audit (premature-close backfill) ─────────────
    //
    // Deliberately read-only on this surface: the in-app chat backend
    // runs as whichever user is typing, with none of the admin gate the
    // HTTP route enforces. An LLM turn must not be able to reopen a
    // hundred tickets because a sentence read like a request to. The
    // write path stays on the admin REST route (and the MCP tool that
    // calls it), where `requireAdmin` is real.
    auditClosedIssues: async (mapId, opts) => {
      const ctx = await getGitHubContextForMap(mapId);
      if (!ctx) throw new Error(`Map ${mapId} has no GitHub integration configured`);
      return auditClosedIssues({
        owner: ctx.owner,
        repo: ctx.repo,
        token: ctx.token,
        dryRun: true,
        closedBy: opts.closedBy,
        since: opts.since ?? null,
        limit: opts.limit,
      });
    },
  };
}
