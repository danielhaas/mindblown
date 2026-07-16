/**
 * Orchestration substrate MCP tools (#111).
 *
 * Implements the 4 new tools that turn MindBlown into a work-queue +
 * soft-conflict detector for parallel Claude coding sessions:
 *
 *   ready_nodes     — list nodes ready to be claimed + dispatched
 *   claim_node      — claim a node for a session
 *   release_node    — release a claim (rejects if caller doesn't own it)
 *   conflict_scan   — detect in-flight nodes that share scopes with a candidate
 */

import { z } from 'zod';
import { defineTool } from '../spec.js';

export const readyNodesTool = defineTool({
  name: 'ready_nodes',
  description: [
    'Return nodes that are ready to be claimed and dispatched.',
    '',
    'A node is ready when:',
    '  - Its status is in the "todo" category (or status is null)',
    '  - It is not currently claimed by any session (claimedBySession = null)',
    '  - Every dependency predecessor (FS/SS/FF/SF) has status in the "done" category',
    '',
    'Results are ordered by priorityRank ASC NULLS LAST → priority (P0–P3) → createdAt ASC.',
    'This is the canonical dispatch queue: call this before dispatching coding agents.',
  ].join('\n'),
  schema: {
    mapId: z.string().describe('The map ID'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum nodes to return (default 10, max 100)'),
    scopeFilter: z
      .array(z.string())
      .optional()
      .describe(
        'Optional scope tags to filter by. When provided, only nodes that declare at least one matching scope tag are returned. Example: ["apps/workflows", "migration:workflows"]',
      ),
  },
  handler: async (backend, { mapId, limit, scopeFilter }) => {
    const result = await backend.readyNodes(mapId, { limit, scopeFilter });

    if (result.ready.length === 0) {
      return scopeFilter && scopeFilter.length > 0
        ? `No ready nodes found in map ${mapId} matching scopes [${scopeFilter.join(', ')}].`
        : `No ready nodes in map ${mapId}. All nodes are either done, in progress, claimed, or blocked by dependencies.`;
    }

    const lines: string[] = [
      `Ready nodes in map ${mapId} (${result.returned} of ${result.total} total):`,
      '',
    ];
    for (const n of result.ready) {
      const priority = n.priority ? ` [${n.priority}]` : '';
      const scopes = n.scopes.length > 0 ? ` scopes=[${n.scopes.join(', ')}]` : '';
      lines.push(`  - ${n.id} "${n.text}"${priority}${scopes}`);
    }
    return lines.join('\n');
  },
});

export const claimNodeTool = defineTool({
  name: 'claim_node',
  description: [
    'Claim a node for a session, marking it as in-flight.',
    '',
    'Sets claimedBySession and claimedAt on the node. If the node is already',
    'claimed by a different session, the call succeeds but returns a soft warning',
    '(the claim is transferred to the new session — this is intentional: if the',
    'original session crashed, the orchestrator should be able to reclaim).',
    '',
    'After claiming, dispatch your coding agent and let it call set_status("done")',
    'when it finishes — that automatically clears the claim.',
  ].join('\n'),
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID to claim'),
    sessionId: z
      .string()
      .describe('Session identifier for the claiming session (e.g. "sess-001", "claude-session-uuid")'),
  },
  handler: async (backend, { mapId, nodeId, sessionId }) => {
    const result = await backend.claimNode(mapId, nodeId, sessionId);

    const lines: string[] = [
      `Claimed node ${nodeId} ("${result.node.text}") for session "${sessionId}".`,
    ];
    if (result.warned && result.warning) {
      lines.push('');
      lines.push(`WARNING: ${result.warning}`);
    }
    return lines.join('\n');
  },
});

export const releaseNodeTool = defineTool({
  name: 'release_node',
  description: [
    'Release a claim on a node.',
    '',
    'Clears claimedBySession and claimedAt. The call is rejected with an error',
    'if the caller\'s sessionId does not match the current claim owner — this',
    'prevents one session from inadvertently releasing another session\'s work.',
    '',
    'You generally do NOT need to call this manually: set_status("done") on the',
    'node auto-releases the claim. Use release_node when a task is being deferred',
    'or handed off without marking it done.',
  ].join('\n'),
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID to release'),
    sessionId: z
      .string()
      .describe('Session identifier of the releasing session. Must match the current claim owner.'),
  },
  handler: async (backend, { mapId, nodeId, sessionId }) => {
    const result = await backend.releaseNode(mapId, nodeId, sessionId);
    if (result.alreadyReleased) {
      return `Node ${nodeId} ("${result.node.text}") was not claimed — no-op.`;
    }
    return `Released claim on node ${nodeId} ("${result.node.text}").`;
  },
});

export const conflictScanTool = defineTool({
  name: 'conflict_scan',
  description: [
    'Scan for in-flight nodes that share scope tags with a candidate node.',
    '',
    'Returns nodes that are currently in progress (status in "in_progress" category)',
    'OR claimed by a session, AND whose scopes overlap with the candidate\'s scopes.',
    '',
    'Use this before dispatching a coding agent to detect potential merge conflicts:',
    '  1. ready_nodes → pick candidate',
    '  2. conflict_scan(candidate) → if non-empty, decide: skip, wait, or dispatch anyway',
    '  3. claim_node → dispatch agent',
    '',
    'If the candidate has no scopes declared, scope conflicts are skipped (set scopes',
    'via update_node), but duplicate detection still runs.',
    '',
    'DUPLICATE DETECTION: the scan also reports GitHub issue links attached to more',
    'than one node — the duplicate-node pattern that falsifies progress rollups.',
    'Per-candidate scans check the candidate\'s links; calling WITHOUT candidateNodeId',
    'runs a map-wide duplicate sweep (hygiene check for housekeeping agents).',
  ].join('\n'),
  schema: {
    mapId: z.string().describe('The map ID'),
    candidateNodeId: z
      .string()
      .optional()
      .describe('The node ID to check. Omit for a map-wide duplicate-link sweep.'),
  },
  handler: async (backend, { mapId, candidateNodeId }) => {
    // Agents pass '' or whitespace to mean "no candidate" — treat like omitted
    // (an empty id would otherwise 404 as a node lookup on the server).
    const candidate = candidateNodeId?.trim() || undefined;
    const result = await backend.conflictScan(mapId, candidate);
    const lines: string[] = [];

    const formatDupes = () => {
      for (const g of result.duplicateLinks) {
        lines.push(`  - ${g.externalId} on ${g.nodes.length} nodes:`);
        for (const n of g.nodes) {
          const pct = n.percentComplete != null ? ` ${n.percentComplete}%` : '';
          lines.push(`      ${n.id} "${n.text.slice(0, 70)}"${pct}${n.hasChildren ? ' (has children)' : ''}`);
        }
      }
    };

    if (candidate === undefined) {
      if (result.duplicateLinks.length === 0) {
        return 'Map-wide duplicate sweep: no GitHub link is attached to more than one node. Clean.';
      }
      lines.push(
        `Map-wide duplicate sweep: ${result.duplicateLinks.length} GitHub link(s) attached to multiple nodes:`,
        '',
      );
      formatDupes();
      lines.push('');
      lines.push(
        'Resolution pattern: keep the node with real progress/children, strip the duplicate\'s links via unlink_github_issue BEFORE deleting it — deleting a still-linked node closes the GitHub issue as not_planned.',
      );
      return lines.join('\n');
    }

    if (result.candidateScopes.length === 0) {
      lines.push(
        `Node ${candidate} has no scopes declared — scope-conflict detection skipped. Set scopes via update_node to enable it.`,
      );
    } else if (result.conflicts.length === 0) {
      lines.push(
        `No scope conflicts for node ${candidate} (scopes: [${result.candidateScopes.join(', ')}]).`,
      );
    } else {
      lines.push(
        `${result.conflicts.length} conflict(s) found for node ${candidate} (scopes: [${result.candidateScopes.join(', ')}]):`,
        '',
      );
      for (const c of result.conflicts) {
        const status = c.status ? ` status=${c.status}` : '';
        const claimed = c.claimedBySession ? ` claimed_by=${c.claimedBySession}` : '';
        lines.push(`  - ${c.id} "${c.text}"${status}${claimed}`);
        lines.push(`    overlapping scopes: [${c.overlappingScopes.join(', ')}]`);
      }
      lines.push('');
      lines.push('Consider waiting for these to complete or dispatching with isolation: "worktree".');
    }

    if (result.duplicateLinks.length > 0) {
      lines.push('');
      lines.push(`⚠ ${result.duplicateLinks.length} duplicate GitHub link(s) involving this node:`);
      formatDupes();
    }
    return lines.join('\n');
  },
});

export const orchestrationTools = [
  readyNodesTool,
  claimNodeTool,
  releaseNodeTool,
  conflictScanTool,
];
