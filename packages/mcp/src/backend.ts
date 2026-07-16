/**
 * HTTP backend for @mindblown/tool-kit — forwards each call to the
 * REST API via the existing api.ts helpers.
 */

import type { ToolBackend } from '@mindblown/tool-kit';
import * as api from './api.js';

export const httpBackend: ToolBackend = {
  listMaps: () => api.listMaps(),
  getMap: (mapId) => api.getMap(mapId),
  createMap: (name, description) => api.createMap(name, description),
  updateMap: (mapId, fields) => api.updateMap(mapId, fields),
  deleteMap: (mapId) => api.deleteMap(mapId),
  createNode: (mapId, parentId, text, fields) => api.createNode(mapId, parentId, text, fields),
  updateNode: (mapId, nodeId, fields) => api.updateNode(mapId, nodeId, fields),
  deleteNode: (mapId, nodeId) => api.deleteNode(mapId, nodeId),
  moveNode: (mapId, nodeId, newParentId, position) => api.moveNode(mapId, nodeId, newParentId, position),
  // ── Soft-delete + restore (#107) ────────────────────────────────
  restoreNode: (mapId, nodeId, opts) => api.restoreNode(mapId, nodeId, opts),
  listDeleted: (mapId, opts) => api.listDeleted(mapId, opts),
  // ── Triage (#96 Phase 3) ────────────────────────────────────────
  listTriageDecisions: (mapId, filters) => api.listTriageDecisions(mapId, filters),
  overrideTriage: (mapId, decisionId, body) => api.overrideTriage(mapId, decisionId, body),
  reclassifyTriage: (mapId, decisionId) => api.reclassifyTriage(mapId, decisionId),
  confirmTriage: (mapId, decisionId) => api.confirmTriage(mapId, decisionId),
  // ── Not-in-MindBlown unified view (#140) ────────────────────────
  listNotInMindBlown: (mapId, filters) => api.listNotInMindBlown(mapId, filters),
  // ── Orchestration substrate (#111) ──────────────────────────────
  readyNodes: (mapId, opts) => api.readyNodes(mapId, opts),
  claimNode: (mapId, nodeId, sessionId) => api.claimNode(mapId, nodeId, sessionId),
  releaseNode: (mapId, nodeId, sessionId) => api.releaseNode(mapId, nodeId, sessionId),
  conflictScan: (mapId, candidateNodeId?) => api.conflictScan(mapId, candidateNodeId),
};
