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
};
