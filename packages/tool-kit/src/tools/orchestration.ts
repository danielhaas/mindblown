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
import { summarizeFleet, effectiveWorkerState, silentSatellites, summarizeTick, TICK_WINDOW_MAX_LIMIT } from '@mindblown/core';
import { defineTool } from '../spec.js';
import type { FleetStatusResult } from '../backend.js';

export const readyNodesTool = defineTool({
  name: 'ready_nodes',
  description: [
    'Return the developer queue: LEAF nodes that are ready to be picked up.',
    '',
    'A node is ready when:',
    '  - It is a leaf (a node with children is a container — its children are the work)',
    '  - It is not tagged for a person (kira-skip, needs-human, needs-daniel-input, needs-rita-review)',
    '    and carries no manual blocker (blockedReason, see flag_blocker) — on itself or on',
    '    any not-done ancestor (a held epic holds its subtree)',
    '  - Its status is in the "todo" category (or status is null)',
    '  - It is not currently claimed by any session (claimedBySession = null)',
    '  - Every dependency predecessor (FS/SS/FF/SF) has status in the "done" category',
    '',
    'Scoped to the map\'s ACTIVE sprint by default (the node or an ancestor carries it);',
    'pass sprint: "all" for the whole map, or a sprint id. A map with no active sprint',
    'falls back to the whole map and says so.',
    '',
    'Ordered priority (P0–P3, unset last) → priorityRank within a priority → oldest first.',
    'Each row shows where the leaf sits (parent path) and how many nodes wait on it.',
    'This is a read-only view; get_next_ticket is the atomic pull (it applies the map\'s',
    'dispatch gate and policy, so its order can differ).',
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
    sprint: z
      .string()
      .optional()
      .describe('"active" (default) = the map\'s active sprint(s); "all" = no sprint filter; or a sprint id (list_cycles).'),
  },
  handler: async (backend, { mapId, limit, scopeFilter, sprint }) => {
    const result = await backend.readyNodes(mapId, { limit, scopeFilter, sprint });
    const scope = result.sprintScope;
    const scopeText =
      scope == null || scope.mode === 'all' || scope.cycles.length === 0
        ? 'whole map'
        : `sprint ${scope.cycles.map((c) => `"${c.name}"`).join(', ')}`;

    if (result.ready.length === 0) {
      const base = scopeFilter && scopeFilter.length > 0
        ? `No ready leaves in map ${mapId} (${scopeText}) matching scopes [${scopeFilter.join(', ')}].`
        : `No ready leaves in map ${mapId} (${scopeText}). Everything is done, in progress, claimed, or waiting on dependencies.`;
      return [base, scope?.note, scope?.mode === 'active' && scope.cycles.length > 0 ? 'Pass sprint: "all" to look beyond the sprint.' : null]
        .filter(Boolean)
        .join('\n');
    }

    const lines: string[] = [
      `Ready leaves in map ${mapId} — ${scopeText} (${result.returned} of ${result.total}):`,
    ];
    if (scope?.note) lines.push(scope.note);
    lines.push('');
    for (const n of result.ready) {
      const priority = n.priority ? ` [${n.priority}]` : '';
      const scopes = n.scopes.length > 0 ? ` scopes=[${n.scopes.join(', ')}]` : '';
      const where = n.breadcrumb && n.breadcrumb.length > 0 ? ` — in ${n.breadcrumb.join(' › ')}` : '';
      const waiting = n.dependents ? ` · ${n.dependents} waiting on it` : '';
      lines.push(`  - ${n.id} "${n.text}"${priority}${where}${waiting}${scopes}`);
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
    '     refused with reason "cap" (reason "hold" when the map\'s cap is 0). A map in',
    '     a fleet is also refused with "fleet_cap" when the fleet\'s total cap is reached.',
    '  2. dispatchGate AND-filter fences the ready set ("version:<id>", "type:bug",',
    '     or "type:bug|version:<id>" = either; empty = no fence). Tickets outside',
    '     the gate are invisible, not deprioritized.',
    '  3. dispatchPolicy orders what\'s left (default ["bugs","priority","age"]).',
    '     A "mix:bugs=<0-100>" entry deterministically interleaves bug and',
    '     non-bug tickets at that percentage (0 = inert, 100 = all bugs first;',
    '     a drained class is back-filled by the other). The weave phase is',
    '     persisted per map and advances only on actual grants, so repeated',
    '     single-ticket pulls walk the pattern instead of restarting it.',
    '  4. Empty-brief guard: ready nodes with no description and no linked',
    '     issue are refused, auto-tagged "needs-brief", and listed in skipped[].',
    '  5. Human-only guard: tickets tagged kira-skip, needs-human, needs-daniel-input',
    '     or needs-rita-review, or flagged with a blocker (blockedReason), are never',
    '     granted (a person must act) and are listed in skipped[] with reason',
    '     "human-only". A tag/blocker on a not-done ancestor holds the whole subtree',
    '     (heldBy names that ancestor; on the map root it holds the whole map).',
    '     Clear whatever holds it (the blocker via',
    '     clear_blocker, the tag, or both) to put it back.',
    '',
    'On success you get the full self-contained brief: title, plain-text',
    'description, priority, scopes, tags, effective version, issue links.',
    'Finish with set_status("done") (auto-releases the claim) or release_node',
    'to hand the ticket back. Unlike claim_node, a pull NEVER steals an',
    'existing claim.',
    '',
    'reason values when granted=false: "hold" (cap 0), "cap" (at capacity),',
    '"fleet_cap" (the map\'s fleet is at its total cap across all its maps,',
    'although the map itself has room), "empty" (nothing dispatchable inside the',
    'gate — if skipped[] is non-empty, the queue has work that needs briefs',
    'written first).',
    '',
    'Fleet pull: pass fleetId instead of mapId to take the next ticket from ANY',
    'map connected to that fleet that you may work on, optionally narrowed with',
    'mapIds to the projects you have checked out. Each map applies its own cap,',
    'gate, policy and profile routing exactly as above; between maps with ready',
    'work the fleet picks by their fleetShare (weighted round-robin), within the',
    'fleet cap. The result names the granted ticket\'s map — work in that repo.',
  ].join('\n'),
  schema: {
    mapId: z.string().optional().describe('The map ID to pull from. Pass exactly one of mapId or fleetId.'),
    fleetId: z
      .string()
      .uuid()
      .optional()
      .describe('Pull from any map of this fleet instead (id from list_fleets). Pass exactly one of mapId or fleetId.'),
    mapIds: z
      .array(z.string())
      .min(1)
      .optional()
      .describe('With fleetId: only these maps — the projects this worker can serve (has the repo checked out). Omitted = every connected map you may work on.'),
    sessionId: z
      .string()
      .describe('Session identifier of the pulling worker (e.g. "claudia:worker-3:acct1"). Opaque to MindBlown; used as the claim owner.'),
    profile: z
      .string()
      .optional()
      .describe('Worker profile: "heavy" | "standard" | "light". On maps with a profilePolicy this filters eligibility — heavy gets first refusal on P0/big tickets, light gets only small P2/P3 tickets, standard (also unknown/absent — fail open) gets everything else; unestimated tickets go to every profile. Maps without a profilePolicy ignore it.'),
  },
  handler: async (backend, { mapId, fleetId, mapIds, sessionId, profile }) => {
    if ((mapId === undefined) === (fleetId === undefined)) {
      throw new Error('Pass exactly one of mapId or fleetId');
    }
    if (mapIds !== undefined && fleetId === undefined) {
      throw new Error('mapIds only applies to a fleet pull (fleetId)');
    }
    const result =
      fleetId !== undefined
        ? await backend.pullFleetTicket(fleetId, sessionId, { profile, mapIds })
        : await backend.getNextTicket(mapId!, sessionId, profile);

    const lines: string[] = [];
    // A fleet cap of 0 is no limit — "3/0" would read as over capacity.
    const fleetClaims = (active: number, cap: number) => (cap === 0 ? `${active}, no fleet cap` : `${active}/${cap}`);
    const fleetLine = result.fleet
      ? ` — fleet "${result.fleet.name}" ${fleetClaims(result.fleet.active, result.fleet.cap)}`
      : '';
    if (result.granted && result.ticket) {
      const t = result.ticket;
      const claims =
        fleetId === undefined
          ? `${result.active}/${result.cap} map claims active${fleetLine}`
          : result.cap === 0
            ? `${result.active} fleet claims active, no fleet cap`
            : `${result.active}/${result.cap} fleet claims active`;
      lines.push(`Ticket granted to session "${sessionId}" (${claims}):`);
      lines.push('');
      lines.push(`  map: ${result.mapName ?? '—'} (mapId: ${t.mapId})`);
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
      lines.push(t.description ? `Brief:\n${t.description}` : 'Brief: (no description — read the linked issue)');
    } else {
      const fleetPull = fleetId !== undefined;
      const why =
        result.reason === 'fleet_cap'
          ? `the fleet is full (${result.fleet?.active ?? result.active}/${result.fleet?.cap ?? result.cap} claims across its maps)`
          : result.reason === 'hold'
            ? fleetPull
              ? 'every map you can pull from is on hold (maxActiveClaims = 0)'
              : 'the map is on hold (maxActiveClaims = 0)'
            : result.reason === 'cap'
              ? fleetPull
                ? 'every map you can pull from is at its own claim ceiling'
                : `the claim cap is reached (${result.active}/${result.cap} active)`
              : fleetPull
                ? 'no dispatchable ticket in any map you can pull from'
                : 'no dispatchable ticket inside the dispatch gate';
      lines.push(`No ticket granted — ${why}.${result.reason === 'fleet_cap' ? '' : fleetLine ? ` (${fleetLine.slice(3)})` : ''}`);
      if (result.maps && result.maps.length > 0) {
        lines.push('');
        lines.push('Per map:');
        for (const m of result.maps) lines.push(`  - ${m.name} (mapId: ${m.mapId}): ${m.reason}`);
      } else if (fleetPull && result.reason === 'empty' && result.skipped.length === 0) {
        lines.push('(No connected map you may work on matched — check mapIds and your access.)');
      }
    }
    const noBrief = result.skipped.filter((s) => s.reason !== 'human-only');
    const humanOnly = result.skipped.filter((s) => s.reason === 'human-only');
    if (noBrief.length > 0) {
      lines.push('');
      lines.push(`Skipped ${noBrief.length} ready node(s) with no brief (tagged "${'needs-brief'}"):`);
      for (const s of noBrief) lines.push(`  - ${s.id} "${s.text}"${s.mapId && fleetId !== undefined ? ` (map ${s.mapId})` : ''}`);
    }
    if (humanOnly.length > 0) {
      lines.push('');
      lines.push(`Skipped ${humanOnly.length} ready node(s) held for a human (tag or blocker) — never granted to a worker:`);
      for (const s of humanOnly) {
        const why = [s.tag, s.blockedReason ? `blocked: ${s.blockedReason}` : undefined].filter(Boolean).join('; ')
          + (s.heldBy ? ` — via parent ${s.heldBy.id} "${s.heldBy.text}"` : '');
        lines.push(`  - ${s.id} "${s.text}" [${why}]${s.mapId && fleetId !== undefined ? ` (map ${s.mapId})` : ''}`);
      }
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
    reason: z
      .string()
      .optional()
      .describe(
        'Why the claim is let go, free text ("never started", "dead worker", "handing off"). Recorded in the node\'s claim trail; does not gate the release.',
      ),
  },
  handler: async (backend, { mapId, nodeId, sessionId, reason }) => {
    const result = await backend.releaseNode(mapId, nodeId, sessionId, reason);
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
    'DUPLICATE DETECTION: the scan also reports issue links attached to more',
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
        return 'Map-wide duplicate sweep: no issue link is attached to more than one node. Clean.';
      }
      lines.push(
        `Map-wide duplicate sweep: ${result.duplicateLinks.length} issue link(s) attached to multiple nodes:`,
        '',
      );
      formatDupes();
      lines.push('');
      lines.push(
        'Resolution pattern: keep the node with real progress/children, strip the duplicate\'s links via unlink_issue BEFORE deleting it — deleting a still-linked node closes its issue as not_planned.',
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
      lines.push(`⚠ ${result.duplicateLinks.length} duplicate issue link(s) involving this node:`);
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
    'With `since`, a "Tick history" section follows: one line per tick in the',
    'window (oldest first) — claims/cap, in-gate, needs-brief, knob writes,',
    'warn+ anomalies — to see how a night went without a terminal.',
    'Pass `mapId` (that map\'s fleet, hosts serving the map) or `fleetId` (every',
    'host of the fleet; claims on maps you can\'t view show as redacted).',
  ].join('\n'),
  schema: {
    mapId: z.string().optional().describe('The map ID the fleet pulls from — one of mapId / fleetId'),
    fleetId: z.string().optional().describe('A fleet ID (list_fleets): the whole fleet'),
    since: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp — render the tick history since this time instead of only the latest tick (ticks are kept ~7 days)'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(TICK_WINDOW_MAX_LIMIT)
      .optional()
      .describe(`Max ticks in the history (newest kept), 1..${TICK_WINDOW_MAX_LIMIT}; default ${TICK_WINDOW_MAX_LIMIT} with since`),
  },
  handler: async (backend, { mapId, fleetId, since, limit }) => {
    if (!mapId === !fleetId) throw new Error('Pass exactly one of mapId or fleetId');
    const window = since !== undefined || limit !== undefined ? { since, limit } : undefined;
    const r = fleetId ? await backend.getFleetStatusForFleet(fleetId, window) : await backend.getFleetStatus(mapId!, window);
    const now = new Date(r.now);
    const summary = summarizeFleet(r.hosts.map((h) => ({ rollup: h.rollup, receivedAt: h.receivedAt })), now);
    const lines: string[] = [];
    if (summary.hosts.length === 0) {
      lines.push(
        r.fleetId === null
          ? `Map ${mapId} is not connected to a fleet — connect it (update_map fleetId) before its satellites can report.`
          : `No satellite rollup received yet for ${fleetId ? `fleet ${fleetId}` : `map ${mapId}`} — the fleet-status push is not wired, or the fleet is off.`,
      );
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
        const served = r.hosts.find((x) => x.host === h.host)?.mapIds ?? [];
        lines.push(`${h.host} (${age}${flag}${drain})${fleetId && served.length > 0 ? ` — serves maps ${served.join(', ')}` : ''}`);
        for (const w of h.workers) {
          const state = effectiveWorkerState(w, now);
          const bits = [[w.agent, w.model].filter(Boolean).join(' '), state];
          if (w.claim?.redacted) bits.push('claim: on a map you can\'t view');
          else if (w.claim?.title) bits.push(`claim: ${w.claim.title}`);
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
    if (since !== undefined) lines.push(...renderTickHistory(r, since));
    return lines.join('\n');
  },
});

/**
 * One line per tick, oldest first, so a night reads top-down. Times are
 * UTC (`HH:MMZ`) with a date line whenever the day changes — the tool runs
 * on whatever host the MCP client sits on, and a local-time rendering would
 * differ between the chat backend on prod and an MCP client in Zurich.
 */
function renderTickHistory(r: FleetStatusResult, since: string): string[] {
  const lines: string[] = [''];
  const rows = [...r.ticks].reverse().map(summarizeTick);
  const window = r.window;
  const n = (v: number | null) => (v === null ? '–' : String(v));
  if (rows.length === 0) {
    lines.push(`Tick history since ${since}: no ticks in this window (ticks are kept ~7 days).`);
    return lines;
  }
  const truncated = window && rows.length >= window.limit ? ` — newest ${window.limit} only, narrow the window for the rest` : '';
  lines.push(`Tick history since ${since} — ${rows.length} ticks, oldest first (times UTC)${truncated}:`);
  let day = '';
  let capWrites = 0;
  let policyWrites = 0;
  let anomalies = 0;
  let noJudgment = 0;
  for (const t of rows) {
    // Receipt time — the axis the window and the order use (a lagging orchestrator clock would run tick_at backwards).
    const d = new Date(t.receivedAt);
    const valid = !Number.isNaN(d.getTime());
    const iso = valid ? d.toISOString() : t.receivedAt;
    const today = valid ? iso.slice(0, 10) : '';
    if (today && today !== day) {
      day = today;
      lines.push(`  ${day}`);
    }
    const bits = [`claims ${n(t.claims)}/${n(t.cap)}`, `in-gate ${n(t.pullableInGate)}`, `needs-brief ${n(t.needsBrief)}`];
    if (t.capWrite) {
      capWrites += 1;
      bits.push(`cap→${t.capWrite.set}${t.capWrite.reason ? ` (${t.capWrite.reason})` : ''}`);
    }
    if (t.policyWrite) {
      policyWrites += 1;
      bits.push(`policy→${t.policyWrite.set.join(' › ')}${t.policyWrite.reason ? ` (${t.policyWrite.reason})` : ''}`);
    }
    if (t.gateRecommendation) bits.push(`gate? ${t.gateRecommendation.set.join(' + ')}`);
    for (const a of t.anomalies) bits.push(`[${a.severity}] ${a.what}`);
    anomalies += t.anomalies.length;
    if (t.asksCount > 0) bits.push(`${t.asksCount} ask${t.asksCount === 1 ? '' : 's'}`);
    if (t.noJudgment) {
      noJudgment += 1;
      bits.push(`NO JUDGMENT (${t.noJudgment})`);
    }
    lines.push(`  ${valid ? iso.slice(11, 16) : iso} ${bits.join(' · ')}`);
  }
  const totals = [`${rows.length} ticks`, `${capWrites} cap write${capWrites === 1 ? '' : 's'}`];
  if (policyWrites > 0) totals.push(`${policyWrites} policy write${policyWrites === 1 ? '' : 's'}`);
  totals.push(`${anomalies} anomal${anomalies === 1 ? 'y' : 'ies'} warn+`);
  if (noJudgment > 0) totals.push(`${noJudgment} without judgment`);
  lines.push(`Total: ${totals.join(' · ')}`);
  return lines;
}

export const orchestrationTools = [
  readyNodesTool,
  getNextTicketTool,
  claimNodeTool,
  releaseNodeTool,
  conflictScanTool,
  fleetStatusTool,
];
