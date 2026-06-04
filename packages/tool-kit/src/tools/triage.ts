/**
 * Triage MCP tools (#96, Phase 3).
 *
 * Four operator-equivalent surfaces for Eve so she can drive the triage
 * pipeline through MCP rather than touching the HTTP API directly:
 *
 *   - `list_triage_decisions` — paginated query with the full Phase 2
 *     filter set (reviewed, decision, confidence range, issueState, since).
 *   - `override_triage`       — apply an operator override; for `place`,
 *     reparent or create the node under the supplied parentNodeId. Honors
 *     the SELF_LOOP_BLOCKED guard from #100 by surfacing the server's
 *     error string verbatim (the backend already rejects parentNodeId ===
 *     placedNodeId).
 *   - `reclassify_triage`     — re-run the LLM against the current map
 *     context. Decision/reason/confidence are refreshed in place.
 *   - `confirm_triage`        — mark a row reviewed without parentage
 *     change (the dedicated #100 Round 2 path).
 *
 * Auth flow: tools call through the abstract `ToolBackend`. The HTTP
 * MCP backend (`packages/mcp/src/backend.ts`) drives the standard
 * /api/maps/:mapId/triage-decisions routes, which enforce the
 * session-JWT-only gate from `routes/triage.ts` — API-key auth is
 * 403'd there. So Eve's calls land with whatever auth the MCP transport
 * carries (the HTTP MCP server mints a JWT from the user's API key
 * at request boundary per #63/#80, which gives Eve a session-equivalent
 * surface on triage).
 */

import { z } from 'zod';
import { defineTool } from '../spec.js';
import type {
  TriageDecisionKind,
  TriageDecisionRow,
} from '../backend.js';

// Shared decision enum used by `list_triage_decisions.decision`,
// `override_triage.decision`, etc.
const decisionEnum = z.enum(['place', 'skip', 'uncertain']);

// ── Helpers ──────────────────────────────────────────────────────

function renderDecisionLine(d: TriageDecisionRow): string {
  const reviewed = d.reviewed ? 'reviewed' : 'pending';
  const by = d.decidedBy;
  const placed = d.placedNodeId ? ` placed=${d.placedNodeId}` : '';
  return `- [${d.id}] ${d.externalId} "${d.issueTitle}" — ${d.decision} (${d.confidence}%, by=${by}, ${reviewed})${placed}\n    reason: ${d.reason}`;
}

// ── Tool: list_triage_decisions ──────────────────────────────────

export const listTriageDecisionsTool = defineTool({
  name: 'list_triage_decisions',
  description:
    "List AI triage decisions for a map. Returns auto + operator-decided rows with their decision (place/skip/uncertain), confidence (0-100), parent node id, and reason. Mirrors the operator UI surface so Eve can review the triage queue without leaving MCP. Filter by reviewed/decision/confidence-range/issueState/since to narrow the result set; default limit 50, max 200.",
  schema: {
    mapId: z.string().describe('The map ID'),
    reviewed: z
      .boolean()
      .optional()
      .describe('Filter by reviewed flag — true=human-confirmed, false=pending review'),
    decision: decisionEnum.optional().describe('Filter by decision kind'),
    minConfidence: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe('Lower bound on confidence (inclusive, 0-100)'),
    maxConfidence: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe('Upper bound on confidence (inclusive, 0-100)'),
    issueState: z
      .enum(['open', 'closed'])
      .optional()
      .describe("Filter by GitHub issue state captured at triage time"),
    since: z
      .string()
      .optional()
      .describe('ISO 8601 — only return rows with decided_at >= this instant'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Max rows to return (default 50, hard cap 200)'),
  },
  handler: async (backend, { mapId, reviewed, decision, minConfidence, maxConfidence, issueState, since, limit }) => {
    const result = await backend.listTriageDecisions(mapId, {
      reviewed,
      decision: decision as TriageDecisionKind | undefined,
      minConfidence,
      maxConfidence,
      issueState,
      since,
      limit,
    });
    if (result.total === 0) {
      return `No triage decisions found in map ${mapId} matching the supplied filters.`;
    }
    const lines = result.decisions.map(renderDecisionLine);
    // Phase 3 follow-up (#104 item 12): "Showing N of M" wording so the
    // operator (or Eve) can see at a glance whether the page was clipped
    // by the limit. Older single-line "Found N" was misleading when the
    // limit clipped the result set — the operator might assume N rows
    // matched the filter when in reality only N rows fit the page.
    const returned = result.returned;
    const total = result.total;
    const summary =
      total > returned
        ? `Showing ${returned} of ${total} triage decision(s) in map ${mapId} (raise \`limit\` to see more, max 200)`
        : `Showing ${returned} triage decision(s) in map ${mapId}`;
    return `${summary}:\n${lines.join('\n')}`;
  },
});

// ── Tool: override_triage ────────────────────────────────────────

export const overrideTriageTool = defineTool({
  name: 'override_triage',
  description:
    "Override an AI triage decision. When decision='place', the row's node is created under parentNodeId (or reparented if a node already exists). When decision='skip' or 'uncertain', the row is updated but no node is created. The server rejects parentNodeId === placedNodeId with SELF_LOOP_BLOCKED — use confirm_triage instead to accept the existing decision without reparenting. Caller must have edit permission on the map; API-key auth is rejected for triage surfaces (use a session login).",
  schema: {
    mapId: z.string().describe('The map ID'),
    decisionId: z.string().describe('The triage decision row ID'),
    decision: decisionEnum.describe(
      "The new decision. 'place' requires parentNodeId.",
    ),
    parentNodeId: z
      .string()
      .optional()
      .describe(
        "Required when decision='place'. Must be a node in this map. Must differ from the row's current placedNodeId (use confirm_triage instead).",
      ),
    reason: z
      .string()
      .optional()
      .describe('Override reason — persisted verbatim in the audit log'),
  },
  handler: async (backend, { mapId, decisionId, decision, parentNodeId, reason }) => {
    const result = await backend.overrideTriage(mapId, decisionId, {
      decision: decision as TriageDecisionKind,
      parentNodeId,
      reason,
    });
    const parts: string[] = [
      `Override applied on decision ${decisionId} → status=${result.status}`,
    ];
    if (result.nodeId) parts.push(`nodeId=${result.nodeId}`);
    return parts.join(', ');
  },
});

// ── Tool: reclassify_triage ──────────────────────────────────────

export const reclassifyTriageTool = defineTool({
  name: 'reclassify_triage',
  description:
    "Re-run the LLM triage against the current map context for an existing decision row. Use after the map's epic structure has changed (new top-level epics, renamed/described differently) and you want the AI to take another pass at a previously-decided row. Decision/reason/confidence are refreshed in place; decidedBy becomes 'auto' and reviewed resets to false. No node is created here — apply with override_triage afterwards if needed. Caller must have edit permission.",
  schema: {
    mapId: z.string().describe('The map ID'),
    decisionId: z.string().describe('The triage decision row ID'),
  },
  handler: async (backend, { mapId, decisionId }) => {
    const result = await backend.reclassifyTriage(mapId, decisionId);
    const conf = result.confidence != null ? ` (${result.confidence}%)` : '';
    const parent = result.parentNodeId ? `, parentNodeId=${result.parentNodeId}` : '';
    return `Reclassified ${decisionId}: decision=${result.decision ?? 'unknown'}${conf}${parent}\nreason: ${result.reason ?? '(none)'}`;
  },
});

// ── Tool: confirm_triage ─────────────────────────────────────────

export const confirmTriageTool = defineTool({
  name: 'confirm_triage',
  description:
    "Mark a triage decision row as reviewed without changing parentage. Use this when the existing auto-decision (place/skip/uncertain) is correct and you just want to accept it. Does NOT take a parentNodeId — the dedicated route prevents the #100 Round 2 self-loop where 'confirm' was previously routed through override with parentNodeId === placedNodeId. Caller must have edit permission.",
  schema: {
    mapId: z.string().describe('The map ID'),
    decisionId: z.string().describe('The triage decision row ID'),
  },
  handler: async (backend, { mapId, decisionId }) => {
    const result = await backend.confirmTriage(mapId, decisionId);
    const node = result.nodeId ? ` (nodeId=${result.nodeId})` : '';
    return `Confirmed ${decisionId} → status=${result.status}${node}`;
  },
});

export const triageTools = [
  listTriageDecisionsTool,
  overrideTriageTool,
  reclassifyTriageTool,
  confirmTriageTool,
];
