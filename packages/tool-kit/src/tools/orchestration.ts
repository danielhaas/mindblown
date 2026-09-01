/**
 * Orchestration substrate MCP tools (#111).
 *
 * Implements the tools that turn MindBlown into a work-queue +
 * soft-conflict detector for parallel Claude coding sessions:
 *
 *   ready_nodes     — list nodes ready to be claimed + dispatched
 *   get_next_ticket — atomic pull: pick + claim the next ticket (Leidang)
 *   claim_node      — claim a node for a session (orchestrator/manual)
 *   release_node    — release a claim (rejects if caller doesn't own it)
 *   conflict_scan   — detect in-flight nodes that share scopes with a candidate
 */

import { z } from 'zod';
import { summarizeFleet, effectiveWorkerState, silentSatellites } from '@mindblown/core';
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

export const getNextTicketTool = defineTool({
  name: 'get_next_ticket',
  description: [
    'Pull the next ticket from a map\'s work queue — the one call a worker needs.',
    'Atomically picks the best ready node per the map\'s dispatch settings and',
    'claims it for your session, all serialized per map (no pull races).',
    '',
    'Selection pipeline (configured via update_map):',
    '  1. Cap gate: if the map\'s active claims >= maxActiveClaims, the pull is',
    '     refused with reason "cap" (reason "hold" when the cap is 0 — the fleet hold).',
    '  2. dispatchGate AND-filter fences the ready set ("version:<id>", "type:bug";',
    '     empty = no fence). Tickets outside the gate are invisible, not deprioritized.',
    '  3. dispatchPolicy orders what\'s left (default ["bugs","priority","age"]).',
    '  4. Empty-brief guard: ready nodes with no description and no linked GitHub',
    '     issue are refused, auto-tagged "needs-brief", and listed in skipped[].',
    '',
    'On success you get the full self-contained brief: title, plain-text',
    'description, priority, scopes, tags, effective version, GitHub links.',
    'Finish with set_status("done") (auto-releases the claim) or release_node',
    'to hand the ticket back. Unlike claim_node, a pull NEVER steals an',
    'existing claim.',
    '',
    'reason values when granted=false: "hold" (cap 0), "cap" (at capacity),',
    '"empty" (nothing dispatchable inside the gate — if skipped[] is non-empty,',
    'the queue has work that needs briefs written first).',
  ].join('\n'),
  schema: {
    mapId: z.string().describe('The map ID to pull from'),
    sessionId: z
      .string()
      .describe('Session identifier of the pulling worker (e.g. "claudia:worker-3:acct1"). Opaque to MindBlown; used as the claim owner.'),
    profile: z
      .string()
      .optional()
      .describe('Worker profile: "heavy" | "standard" | "light". On maps with a profilePolicy this filters eligibility — heavy gets first refusal on P0/big tickets, light gets only small P2/P3 tickets, standard (also unknown/absent — fail open) gets everything else; unestimated tickets go to every profile. Maps without a profilePolicy ignore it.'),
  },
  handler: async (backend, { mapId, sessionId, profile }) => {
    const result = await backend.getNextTicket(mapId, sessionId, profile);

    const lines: string[] = [];
    if (result.granted && result.ticket) {
      const t = result.ticket;
      lines.push(`Ticket granted to session "${sessionId}" (${result.active}/${result.cap} claims active):`);
      lines.push('');
      lines.push(`  id: ${t.id}`);
      lines.push(`  title: ${t.text}`);
      if (t.priority || t.priorityRank !== null) {
        lines.push(`  priority: ${t.priority ?? '—'}${t.priorityRank !== null ? ` (rank ${t.priorityRank})` : ''}`);
      }
      if (t.effortEstimate !== null) lines.push(`  estimate: ${t.effortEstimate}`);
      if (t.versionId) lines.push(`  version: ${t.versionId}`);
      if (t.tags.length > 0) lines.push(`  tags: [${t.tags.join(', ')}]`);
      if (t.scopes.length > 0) lines.push(`  scopes: [${t.scopes.join(', ')}]`);
      for (const l of t.githubLinks) lines.push(`  github: ${l.externalId} — ${l.url}`);
      lines.push('');
      lines.push(t.description ? `Brief:\n${t.description}` : 'Brief: (no description — read the linked GitHub issue)');
    } else {
      const why =
        result.reason === 'hold'
          ? 'the map is on hold (maxActiveClaims = 0)'
          : result.reason === 'cap'
            ? `the claim cap is reached (${result.active}/${result.cap} active)`
            : 'no dispatchable ticket inside the dispatch gate';
      lines.push(`No ticket granted — ${why}.`);
    }
    if (result.skipped.length > 0) {
      lines.push('');
      lines.push(`Skipped ${result.skipped.length} ready node(s) with no brief (tagged "${'needs-brief'}"):`);
      for (const s of result.skipped) lines.push(`  - ${s.id} "${s.text}"`);
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
    'Because of these transfer semantics this is a manual/orchestrator tool —',
    'pull-fleet workers should use get_next_ticket, which never steals claims.',
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

export const fleetStatusTool = defineTool({
  name: 'fleet_status',
  description: [
    'What MindBlown last heard from the Leidang worker fleet: one rollup per',
    'satellite host (workers with state working / parked / limit-parked /',
    'auth-parked / prompt, their claim, context fill, last activity) and the',
    'orchestrator\'s recent ticks (assessment, anomalies, asks for the human,',
    'knob writes). Read-only. A host whose rollup is older than 20 min is',
    'reported STALE — host down, paused, or agent stopped — and does not count',
    'as capacity. Use this to answer "why is nothing being worked on?" before',
    'touching maxActiveClaims: parked/limit-parked workers, not the cap, are the',
    'usual reason. Empty until the satellites push (fleet-status route).',
  ].join('\n'),
  schema: {
    mapId: z.string().describe('The map ID the fleet pulls from'),
  },
  handler: async (backend, { mapId }) => {
    const r = await backend.getFleetStatus(mapId);
    const now = new Date(r.now);
    const summary = summarizeFleet(r.hosts.map((h) => ({ rollup: h.rollup, receivedAt: h.receivedAt })), now);
    const lines: string[] = [];
    if (summary.hosts.length === 0) {
      lines.push(`No satellite rollup received yet for map ${mapId} — the fleet-status push is not wired, or the fleet is off.`);
    } else {
      const states = Object.entries(summary.totals)
        .sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `${s} ${n}`)
        .join(' · ');
      lines.push(
        `Fleet: ${summary.freshHosts}/${summary.hosts.length} hosts reporting, ${summary.workersTotal} workers on fresh hosts (${states || 'none'})` +
          (summary.staleWorkers > 0 ? ` — plus ${summary.staleWorkers} last seen on stale hosts, not counted` : ''),
      );
      for (const h of summary.hosts) {
        const age = `${Math.round(h.freshness.ageMin)}m ago`;
        const flag = h.freshness.stale ? ' — STALE: host down, paused, or agent stopped?' : '';
        const drain = h.draining ? ` — DRAINING: ${h.draining}` : '';
        lines.push('');
        lines.push(`${h.host} (${age}${flag}${drain})`);
        for (const w of h.workers) {
          const state = effectiveWorkerState(w, now);
          const bits = [w.model ?? '', state];
          if (w.claim?.title) bits.push(`claim: ${w.claim.title}`);
          else if (w.claim?.nodeId) bits.push(`claim: ${w.claim.nodeId}`);
          if (state === 'limit-parked' && w.limit_reset_at) bits.push(`reset ${w.limit_reset_at}`);
          if (state === 'prompt' && w.prompt_question) bits.push(`prompt: ${w.prompt_question}`);
          if (w.waiting?.reason) bits.push(`waiting: ${w.waiting.reason}`);
          if (typeof w.ctx_pct === 'number') bits.push(`ctx ${w.ctx_pct}%`);
          lines.push(`  - ${w.worker ?? w.session}: ${bits.filter(Boolean).join(' · ')}`);
        }
      }
    }
    const tick = r.ticks[0];
    if (tick) {
      const p = tick.payload;
      lines.push('');
      lines.push(`Last orchestrator tick ${tick.tickAt}${p.noJudgment ? ` — NO JUDGMENT (${p.noJudgment})` : ''}`);
      if (p.assessment) lines.push(`  ${p.assessment}`);
      if (p.summary?.heartbeat) lines.push(`  numbers: ${p.summary.heartbeat}`);
      const silent = silentSatellites(p.pullStatus, summary.hosts.map((h) => h.host));
      for (const s of silent) {
        lines.push(
          s.reason === 'unreachable'
            ? `  SILENT satellite ${s.sat}: unreachable over ssh`
            : s.reason === 'no-rollup'
              ? `  SILENT satellite ${s.sat}: up but delivered no rollup — agent not running`
              : `  note: ${s.sat} delivers to the orchestrator but does not push to MindBlown yet (sender patch not rolled out there)`,
        );
      }
      for (const a of p.anomalies ?? []) lines.push(`  [${a.severity}] ${a.what}`);
      if ((p.asks ?? []).length > 0) {
        lines.push('  asks for the human:');
        for (const a of p.asks ?? []) lines.push(`    - ${a}`);
      }
      if (p.cap?.set !== null && p.cap?.set !== undefined) lines.push(`  cap set → ${p.cap.set} (${p.cap.reason ?? ''})`);
      if (p.policy?.set) lines.push(`  policy set → ${p.policy.set.join(' › ')} (${p.policy.reason ?? ''})`);
      if (p.gate_recommendation?.set) lines.push(`  gate RECOMMENDED (needs the human) → ${p.gate_recommendation.set.join(' + ')} (${p.gate_recommendation.reason ?? ''})`);
    } else {
      lines.push('');
      lines.push('No orchestrator tick received yet.');
    }
    return lines.join('\n');
  },
});

export const orchestrationTools = [
  readyNodesTool,
  getNextTicketTool,
  claimNodeTool,
  releaseNodeTool,
  conflictScanTool,
  fleetStatusTool,
];
