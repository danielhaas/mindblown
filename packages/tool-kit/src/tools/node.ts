import { z } from 'zod';
import { defineTool } from '../spec.js';
import { formatClaim } from '../formatters.js';

export const createNodeTool = defineTool({
  name: 'create_node',
  description: 'Create a new node (task/idea) in a map under a parent node',
  schema: {
    mapId: z.string().describe('The map ID'),
    parentId: z.string().describe('Parent node ID to create under'),
    text: z.string().describe('Node title/label'),
    effortEstimate: z.number().optional().describe('Effort estimate (leaf nodes only)'),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Priority level'),
    status: z.string().optional().describe("Status (must match map's status workflow)"),
    dueDate: z.string().optional().describe('Due date (ISO 8601)'),
    startDate: z.string().optional().describe('Start date (ISO 8601)'),
    versionId: z.string().optional().describe('Version ID to assign this node to'),
    autoProgress: z
      .enum(['off', 'children'])
      .optional()
      .describe(
        "Parent-epic auto-progress mode. When set to 'children', the node's percentComplete is auto-computed from the closed/total child-PR ratio based on title-pattern matching (e.g. `[#NNNN-followup]`, `(#NNNN follow-up)`). Use this on parent epics whose work is decomposed across child PRs in GitHub. Default 'off' leaves percentComplete under manual control. Note: this is distinct from the normal leaf-rollup, which always derives a parent's progress from its tree children's weighted estimates × progress regardless of this flag.",
      ),
    priorityRank: z
      .number()
      .nullable()
      .optional()
      .describe(
        'Fractional rank for sibling ordering within the same parent (Gantt slice 1). Lower numbers appear earlier. Use (A.rank + B.rank) / 2 for midpoint insertion. null = no explicit rank (sorts after ranked siblings).',
      ),
  },
  handler: async (backend, { mapId, parentId, text, ...fields }) => {
    const cleanFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) cleanFields[k] = v;
    }
    const node = await backend.createNode(mapId, parentId, text, cleanFields);
    return `Created node "${text}" (id: ${node.id}) under parent ${parentId}`;
  },
});

export const updateNodeTool = defineTool({
  name: 'update_node',
  description: 'Update any field on a node',
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID to update'),
    text: z.string().optional().describe('New title/label'),
    description: z.string().optional().describe('Rich text description'),
    effortEstimate: z.number().nullable().optional().describe('Effort estimate'),
    percentComplete: z.number().nullable().optional().describe('Percent complete (0-100)'),
    status: z.string().nullable().optional().describe('Status'),
    blockedReason: z
      .string()
      .nullable()
      .optional()
      .describe('Why this node is blocked (e.g. "waiting on legal"). null/empty to clear.'),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).nullable().optional().describe('Priority'),
    dueDate: z.string().nullable().optional().describe('Due date (ISO 8601)'),
    startDate: z.string().nullable().optional().describe('Start date (ISO 8601)'),
    tags: z.array(z.string()).optional().describe('Tags'),
    assigneeIds: z.array(z.string()).optional().describe('Assignee user IDs'),
    versionId: z.string().nullable().optional().describe('Version ID (null to unassign)'),
    autoProgress: z
      .enum(['off', 'children'])
      .optional()
      .describe(
        "Parent-epic auto-progress mode. When set to 'children', the node's percentComplete is auto-computed from the closed/total child-PR ratio based on title-pattern matching (e.g. `[#NNNN-followup]`, `(#NNNN follow-up)`). Use this on parent epics whose work is decomposed across child PRs in GitHub. Default 'off' leaves percentComplete under manual control. Note: this is distinct from the normal leaf-rollup, which always derives a parent's progress from its tree children's weighted estimates × progress regardless of this flag.",
      ),
    priorityRank: z
      .number()
      .nullable()
      .optional()
      .describe(
        'Fractional rank for sibling ordering within the same parent (Gantt slice 1). Lower numbers appear first. Use (A.rank + B.rank) / 2 to insert between two nodes. null clears the rank.',
      ),
    // Orchestration substrate (#111)
    scopes: z
      .array(z.string())
      .optional()
      .describe(
        "Free-form scope tags declaring what work this node touches. Used by conflict_scan to surface in-flight nodes that might conflict with this node when it's dispatched. Examples: 'apps/workflows', 'model:Mandate', 'migration:workflows', 'frontend:contacts'. Empty array clears all scopes.",
      ),
  },
  handler: async (backend, { mapId, nodeId, ...fields }) => {
    const cleanFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) cleanFields[k] = v;
    }
    if (Object.keys(cleanFields).length === 0) return 'No fields to update.';
    await backend.updateNode(mapId, nodeId, cleanFields);
    return `Updated node ${nodeId}: ${Object.keys(cleanFields).join(', ')}`;
  },
});

export const deleteNodeTool = defineTool({
  name: 'delete_node',
  description:
    'Soft-delete a node and all its descendants. The subtree moves to the Trash and stops appearing in get_map / search_nodes / triage. Use restore_node to undo within the retention window; the GC job hard-deletes Trash older than 30 days and only then closes linked GitHub issues as not_planned.',
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID to delete'),
  },
  handler: async (backend, { mapId, nodeId }) => {
    await backend.deleteNode(mapId, nodeId);
    return `Deleted node ${nodeId} and its descendants (moved to Trash; use restore_node to undo).`;
  },
});

export const restoreNodeTool = defineTool({
  name: 'restore_node',
  description:
    'Undelete a node from the Trash. Splices the subtree back into its parent\'s children_order at the original position. Fails if the parent is itself in the Trash unless `recursive: true` is passed, in which case the whole trashed ancestor chain is restored. Use list_recently_deleted to find candidates.',
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID to restore (a subtree root in the Trash)'),
    recursive: z
      .boolean()
      .optional()
      .describe(
        'When true, also restore any soft-deleted ancestors of this node (the parent chain that was in the Trash). When false or omitted, the call fails if the parent is still in the Trash.',
      ),
  },
  handler: async (backend, { mapId, nodeId, recursive }) => {
    const result = await backend.restoreNode(mapId, nodeId, { recursive: recursive === true });
    return `Restored ${result.restoredIds.length} node(s) including ${nodeId}.`;
  },
});

export const listRecentlyDeletedTool = defineTool({
  name: 'list_recently_deleted',
  description:
    'List subtree roots currently in the Trash for a map, newest deletion first. Returns one row per delete operation — internal descendants of trashed subtrees are filtered out. Used to find undelete candidates for restore_node.',
  schema: {
    mapId: z.string().describe('The map ID'),
    sinceDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Only deletions in the last N days. Default: all in retention window.'),
    limit: z.number().int().min(1).max(1000).optional().describe('Max rows (default 500).'),
  },
  handler: async (backend, { mapId, sinceDays, limit }) => {
    const rows = await backend.listDeleted(mapId, { sinceDays, limit });
    if (rows.length === 0) return 'No nodes in the Trash for this map.';
    const lines = rows.map(
      (r) =>
        `- ${r.text} (id: ${r.id}, deleted: ${r.deletedAt}, parent: ${r.parentId ?? '<none>'})`,
    );
    return `${rows.length} node(s) in Trash:\n${lines.join('\n')}`;
  },
});

export const moveNodeTool = defineTool({
  name: 'move_node',
  description: 'Move a node to a new parent',
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID to move'),
    newParentId: z.string().describe('The new parent node ID'),
    index: z.number().optional().describe('Position among siblings (0-based)'),
  },
  handler: async (backend, { mapId, nodeId, newParentId, index }) => {
    await backend.moveNode(mapId, nodeId, newParentId, index);
    return `Moved node ${nodeId} under parent ${newParentId}${index !== undefined ? ` at position ${index}` : ''}.`;
  },
});

export const flagBlockerTool = defineTool({
  name: 'flag_blocker',
  description:
    'Mark a node as blocked, recording the reason. This is the canonical "this is stuck" primitive — sets `blockedReason` so the node shows up in blocked_digest, risk_scan, and the blocked rollup propagates to ancestors. Use this when something external is holding work back (waiting on a vendor, legal review, a decision, an upstream team). Use clear_blocker (or set blockedReason via update_node) to unblock.',
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID to flag as blocked'),
    reason: z
      .string()
      .min(1)
      .describe('Short human-readable reason for the block (e.g. "waiting on legal review", "vendor SLA pending"). This is what surfaces in digests.'),
  },
  handler: async (backend, { mapId, nodeId, reason }) => {
    await backend.updateNode(mapId, nodeId, { blockedReason: reason });
    return `Flagged ${nodeId} as blocked: "${reason}".`;
  },
});

export const clearBlockerTool = defineTool({
  name: 'clear_blocker',
  description:
    'Clear the blocker on a node — removes `blockedReason` so the node stops surfacing in blocked_digest and ancestor blocked rollups. Use when the external thing that was holding the work back has resolved.',
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID to unblock'),
  },
  handler: async (backend, { mapId, nodeId }) => {
    await backend.updateNode(mapId, nodeId, { blockedReason: null });
    return `Cleared blocker on ${nodeId}.`;
  },
});

export const searchNodesTool = defineTool({
  name: 'search_nodes',
  description:
    'Search nodes by text across a map, with optional structured filters. Pass an empty string or "*" as query to match all nodes and filter by status/priority/tag/unestimated/leavesOnly/versionId only. Common pre-flight check: query="*", unestimated:true, versionId:"<id>" to find any V-N leaves still missing estimates.',
  schema: {
    mapId: z.string().describe('The map ID'),
    query: z
      .string()
      .describe('Search text (case-insensitive substring match). Empty string or "*" matches all nodes.'),
    status: z.string().optional().describe('Filter by status (exact match)'),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Filter by priority'),
    tag: z.string().optional().describe('Filter by tag (nodes must include this tag)'),
    unestimated: z
      .boolean()
      .optional()
      .describe('When true, only nodes whose effortEstimate is null. Combine with leavesOnly:true and versionId to answer "do all V1 leaves have estimates?". When false, only nodes whose effortEstimate is set.'),
    leavesOnly: z
      .boolean()
      .optional()
      .describe('When true, only leaf nodes (no children) are returned. Useful with `unestimated` since estimates apply to leaves.'),
    versionId: z
      .string()
      .optional()
      .describe('Filter by version. Matches nodes whose own versionId is this OR any ancestor on the path inherits it.'),
  },
  handler: async (backend, { mapId, query, status, priority, tag, unestimated, leavesOnly, versionId }) => {
    const data = await backend.getMap(mapId);
    const trimmedQ = query.trim();
    const matchAll = trimmedQ === '' || trimmedQ === '*';
    const lowerQ = trimmedQ.toLowerCase();
    let matches = matchAll
      ? data.nodes.slice()
      : data.nodes.filter(
          (n) =>
            n.text.toLowerCase().includes(lowerQ) ||
            (n.description?.toLowerCase().includes(lowerQ) ?? false),
        );
    if (status) matches = matches.filter((n) => n.status === status);
    if (priority) matches = matches.filter((n) => n.priority === priority);
    if (tag) matches = matches.filter((n) => n.tags.includes(tag));
    if (leavesOnly) matches = matches.filter((n) => (n.childrenIds?.length ?? 0) === 0);
    if (unestimated === true) matches = matches.filter((n) => n.effortEstimate == null);
    else if (unestimated === false) matches = matches.filter((n) => n.effortEstimate != null);
    if (versionId) {
      const nodeById = new Map(data.nodes.map((n) => [n.id, n]));
      const inVersion = (id: string): boolean => {
        let cur = nodeById.get(id);
        while (cur) {
          if (cur.versionId === versionId) return true;
          cur = cur.parentId ? nodeById.get(cur.parentId) : undefined;
        }
        return false;
      };
      matches = matches.filter((n) => inVersion(n.id));
    }

    if (matches.length === 0) {
      const filters = [
        status && `status=${status}`,
        priority && `priority=${priority}`,
        tag && `tag=${tag}`,
        unestimated !== undefined && `unestimated=${unestimated}`,
        leavesOnly && `leavesOnly=true`,
        versionId && `versionId=${versionId}`,
      ].filter(Boolean);
      const filterStr = filters.length > 0 ? ` (filters: ${filters.join(', ')})` : '';
      const subject = matchAll ? 'nodes' : `nodes matching "${query}"`;
      return `No ${subject}${filterStr} found in map ${mapId}.`;
    }

    const lines = matches.map((n) => {
      const health =
        n.healthSignal === 'on_track' ? '[OK]' : n.healthSignal === 'at_risk' ? '[AT RISK]' : '[BEHIND]';
      const progress = Math.round(n.computedProgress);
      const links = n.externalLinks?.length > 0
        ? ' ' + n.externalLinks.map((l) => `[${l.externalId}]`).join(' ')
        : '';
      const claim = ' ' + formatClaim(n.claimedBySession, n.claimedAt);
      return `- "${n.text}" (id: ${n.id}) — ${progress}% ${health}${n.status ? ` [${n.status}]` : ''}${n.priority ? ` ${n.priority}` : ''}${links}${claim}`;
    });

    return `Found ${matches.length} node(s) matching "${query}":\n${lines.join('\n')}`;
  },
});

/**
 * set_priority_rank — single-node convenience for drag-to-reorder.
 *
 * Updates only the `priorityRank` field. Drop between sibling A (rank=a) and
 * sibling B (rank=b) by passing `rank: (a + b) / 2`. When ranks collide
 * within epsilon the caller should trigger a full renumber of the sibling
 * group (outside this tool's scope — UI handles renumber on its side).
 */
export const setPriorityRankTool = defineTool({
  name: 'set_priority_rank',
  description:
    'Update the priorityRank of a single node for drag-to-reorder within its sibling group. Drop a node between sibling A (rankA) and sibling B (rankB) by passing rank = (rankA + rankB) / 2. Pass null to clear the rank (node will sort after all ranked siblings). Use this on the dragged node after the user drops it into its new position in the Gantt task list.',
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID to rerank'),
    rank: z
      .number()
      .nullable()
      .describe(
        'New fractional rank. (A.rank + B.rank) / 2 to insert between A and B. null to clear.',
      ),
  },
  handler: async (backend, { mapId, nodeId, rank }) => {
    await backend.updateNode(mapId, nodeId, { priorityRank: rank });
    return rank === null
      ? `Cleared priorityRank on node ${nodeId}.`
      : `Set priorityRank = ${rank} on node ${nodeId}.`;
  },
});

export const nodeTools = [
  createNodeTool,
  updateNodeTool,
  deleteNodeTool,
  restoreNodeTool,
  listRecentlyDeletedTool,
  moveNodeTool,
  flagBlockerTool,
  clearBlockerTool,
  searchNodesTool,
  setPriorityRankTool,
];
