/**
 * Brief drafts (19.11.2026): writing a brief is fleet work.
 *
 * A ready leaf with no brief (core hasBrief: no description, no linked
 * issue, a title under ten words) is refused by the pull and used to wait
 * on a person forever. Every few minutes this job takes the ready,
 * approved leaves with no brief and no person hold (core dispatchHold —
 * `needs-<person>` tags included, so a ticket kept for Dan never gets one)
 * and asks the map's AI for a brief from the title, the parent path, the
 * parent's and siblings' descriptions and the repo README. The answer goes
 * into the description marked `descriptionSource: 'ai'` ("Brief drafted by
 * AI — edit or accept" in the panel), and the ticket is dispatchable.
 *
 * When the AI cannot write one — the title is too vague and it answers with
 * a question — nothing is drafted: the brief row on the Questions card asks
 * the person that question (`briefRowState`). Every attempt is stored per
 * node with a hash of the title it read, so the AI is asked once per title.
 *
 * The map's AI policy applies (`none` = never; `local` = local model only)
 * and the map's `aiBriefDrafts` switch turns it off. Off or no model: the
 * brief row stays the generic "write a brief" ask, the step stays a person's.
 */
import { createHash } from 'node:crypto';
import { isNull } from 'drizzle-orm';
import {
  buildIsDonePredicate,
  dispatchHold,
  dispatchQueueSnapshot,
  hasBrief,
  NEEDS_BRIEF_TAG,
  proseMirrorToPlainText,
  type MindMap,
  type Node as CoreNode,
} from '@mindblown/core';
import { db } from '../db/connection.js';
import { maps } from '../db/schema.js';
import * as mapDb from '../db/maps.js';
import * as nodeDb from '../db/nodes.js';
import { listBriefDrafts, saveBriefDraft, type StoredBriefDraft } from '../db/briefDrafts.js';
import { recordEvent } from '../db/events.js';
import { capabilitiesForMap, resolveProviderForMap } from '../ai/policy.js';
import { withProviderFallback } from '../ai/providers/fallback.js';
import { readRepoDoc } from './repoDocs.js';
import { broadcast } from '../ws.js';

/** Briefs asked for per tick, over all maps — the local backend has one slot, shared with the fleet. */
export const BRIEFS_PER_TICK = 3;
/** Failed attempts on the same title before the person is asked instead. */
export const MAX_ATTEMPTS = 3;
/** A failed attempt waits this long before the next. */
const RETRY_AFTER_MS = 30 * 60 * 1000;
const DRAFT_TIMEOUT_MS = 3 * 60 * 1000;
const README_MAX = 4000;
const DESC_MAX = 1500;
const SIBLINGS_MAX = 8;

export const BRIEF_DRAFT_SYSTEM_PROMPT = `You write the brief for a ticket in a project plan, so an AI coding agent can work on it unattended. The ticket has only a short title. You get the title, where it sits in the plan, the descriptions of its parent and siblings, and the project's README when there is one.

Write a brief only when the context makes clear what is to be done. A brief has:
- one or two sentences: what is wanted and why, in the project's terms;
- "Done when:" and 2–5 short checkable points.
Do not invent requirements the context does not support. No preamble.

If the title is too vague to brief — you would have to guess what is wanted — do not write one. Ask the ONE question whose answer would let you write it, as a person would answer it in a sentence.

Return ONLY a JSON object, no markdown fences: {"brief": "..."} or {"question": "..."}.`;

/** The hash an attempt is keyed by: the title it read (a title edit asks again). */
export function briefTextHash(title: string): string {
  return createHash('sha256').update(title.trim()).digest('hex').slice(0, 32);
}

export interface BriefDraftContext {
  mapName: string;
  title: string;
  path: string[];
  parentDescription: string;
  siblings: Array<{ title: string; description: string }>;
  readme: string | null;
}

export function briefDraftUserPrompt(c: BriefDraftContext): string {
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const lines = [`Project: ${c.mapName}`];
  if (c.path.length > 0) lines.push(`Filed under: ${c.path.join(' › ')}`);
  if (c.parentDescription.trim()) lines.push('', 'Parent description:', cut(c.parentDescription.trim(), DESC_MAX));
  if (c.siblings.length > 0) {
    lines.push('', 'Sibling tickets:');
    for (const s of c.siblings) lines.push(`- ${s.title}${s.description.trim() ? `: ${cut(s.description.replace(/\s+/g, ' ').trim(), 300)}` : ''}`);
  }
  if (c.readme?.trim()) lines.push('', 'README:', cut(c.readme.trim(), README_MAX));
  lines.push('', `Ticket title: ${c.title}`);
  return lines.join('\n');
}

/** The model's reply as a brief or a question; null when it is neither. */
export function parseBriefReply(raw: string): { brief: string } | { question: string } | null {
  const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let v: { brief?: unknown; question?: unknown };
  try {
    v = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  const brief = typeof v.brief === 'string' ? v.brief.trim() : '';
  const question = typeof v.question === 'string' ? v.question.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  // A "brief" that is only a question is the AI asking.
  if (brief && !(brief.length < 200 && /\?\s*$/.test(brief) && !brief.includes('\n'))) return { brief: brief.slice(0, 4000) };
  if (question) return { question };
  if (brief) return { question: brief.replace(/\s+/g, ' ') };
  return null;
}

/**
 * The tickets the job may brief — exactly the ones the pull refuses for
 * want of a brief (core dispatchQueueSnapshot.needsBriefIds): ready leaves
 * inside the gate with no hold of any kind (skip tag incl. needs-<person>,
 * blocker, approval, parked, epic — on it or an open ancestor) and no
 * brief. A map on hold (cap 0) pulls nothing, so nothing is briefed. Pure.
 */
export function briefDraftCandidates(nodes: CoreNode[], map: Pick<MindMap, 'statusWorkflow' | 'maxActiveClaims' | 'dispatchGate'>): CoreNode[] {
  const cap = map.maxActiveClaims ?? 0;
  if (cap <= 0) return [];
  const live = nodes.filter((n) => !n.deletedAt);
  const ids = new Set(dispatchQueueSnapshot(live, { workflow: map.statusWorkflow ?? [], cap, gate: map.dispatchGate ?? [] }).needsBriefIds);
  return live.filter((n) => ids.has(n.id)).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
}

/** In memory: node id → failed attempts on its current title. A restart tries again at once. */
const failures = new Map<string, { hash: string; count: number; at: number }>();
export function __resetBriefDraftFailures(): void {
  failures.clear();
}

function failedOut(nodeId: string, hash: string): boolean {
  const f = failures.get(nodeId);
  return !!f && f.hash === hash && f.count >= MAX_ATTEMPTS;
}

function retryDue(nodeId: string, hash: string, now: number): boolean {
  const f = failures.get(nodeId);
  if (!f || f.hash !== hash) return true;
  if (f.count >= MAX_ATTEMPTS) return false;
  return now - f.at >= RETRY_AFTER_MS;
}

/** Is drafting on for this map: the switch, and an AI the policy allows that answers now. */
export async function briefDraftingOn(map: Pick<MindMap, 'id' | 'aiBriefDrafts'>): Promise<boolean> {
  if (map.aiBriefDrafts === false) return false;
  return (await capabilitiesForMap(map.id)).structured;
}

/**
 * What the brief row of each briefless ticket says. `ask: false` = no row
 * yet, the AI has it; a string = the AI's question; null = the plain
 * "write a brief" ask (drafting off, no AI, or the AI kept failing).
 */
export async function briefRowState(
  map: Pick<MindMap, 'id' | 'aiBriefDrafts'>,
  nodes: Array<Pick<CoreNode, 'id' | 'text'>>,
): Promise<Map<string, { ask: false } | { ask: true; question: string | null }>> {
  const out = new Map<string, { ask: false } | { ask: true; question: string | null }>();
  if (nodes.length === 0) return out;
  const on = await briefDraftingOn(map).catch(() => false);
  const stored = on ? new Map((await listBriefDrafts(nodes.map((n) => n.id))).map((r) => [r.nodeId, r])) : new Map<string, StoredBriefDraft>();
  for (const n of nodes) {
    if (!on) {
      out.set(n.id, { ask: true, question: null });
      continue;
    }
    const hash = briefTextHash(n.text);
    const row = stored.get(n.id);
    if (row && row.textHash === hash) {
      // The AI asked; or it drafted and a person emptied the description since — theirs now.
      out.set(n.id, { ask: true, question: row.outcome === 'question' ? row.question : null });
    } else if (failedOut(n.id, hash)) out.set(n.id, { ask: true, question: null });
    // Not tried on this title yet: the AI has it.
    else out.set(n.id, { ask: false });
  }
  return out;
}

function plain(description: unknown): string {
  return proseMirrorToPlainText(description as CoreNode['description']).trim();
}

/** Context for one ticket, from the map's nodes and its repo README. */
export async function briefContext(map: MindMap, node: CoreNode, byId: Map<string, CoreNode>, readme: string | null): Promise<BriefDraftContext> {
  const path: string[] = [];
  for (let p = node.parentId ? byId.get(node.parentId) : undefined, i = 0; p && p.parentId && i < 8; p = p.parentId ? byId.get(p.parentId) : undefined, i++) {
    path.unshift(p.text);
  }
  const parent = node.parentId ? byId.get(node.parentId) : undefined;
  const siblings = (parent?.childrenIds ?? [])
    .filter((id) => id !== node.id)
    .map((id) => byId.get(id))
    .filter((n): n is CoreNode => !!n && !n.deletedAt)
    .slice(0, SIBLINGS_MAX)
    .map((n) => ({ title: n.text, description: plain(n.description) }));
  return { mapName: map.name, title: node.text, path, parentDescription: parent ? plain(parent.description) : '', siblings, readme };
}

async function readmeOf(map: MindMap): Promise<string | null> {
  if (!map.githubRepoOwner || !map.githubRepoName) return null;
  try {
    return (await readRepoDoc(map.id, 'README.md')).text;
  } catch {
    return null;
  }
}

/** Ask the map's model for one ticket's brief. Throws when there is no usable answer. */
export async function draftBrief(mapId: string, context: BriefDraftContext): Promise<{ reply: { brief: string } | { question: string }; provider: string }> {
  const userPrompt = briefDraftUserPrompt(context);
  const { raw, provider } = await withProviderFallback(
    () => resolveProviderForMap(mapId),
    async (p) => ({
      raw: await p.complete({
        systemPrompt: BRIEF_DRAFT_SYSTEM_PROMPT,
        parts: [{ text: userPrompt }],
        format: 'json',
        temperature: 0,
        maxTokens: 3000,
        signal: AbortSignal.timeout(DRAFT_TIMEOUT_MS),
      }),
      provider: p.name,
    }),
  );
  const reply = parseBriefReply(raw);
  if (!reply) throw new Error('model returned neither a brief nor a question');
  return { reply, provider };
}

export interface BriefDraftsResult {
  drafted: number;
  asked: number;
  errors: string[];
}

/** One tick: brief up to BRIEFS_PER_TICK tickets across the active maps. */
export async function runBriefDrafts(now: Date = new Date()): Promise<BriefDraftsResult> {
  const result: BriefDraftsResult = { drafted: 0, asked: 0, errors: [] };
  const active = await db.select({ id: maps.id }).from(maps).where(isNull(maps.archivedAt));
  let budget = BRIEFS_PER_TICK;
  for (const { id: mapId } of active) {
    if (budget <= 0) break;
    const detail = await mapDb.getMap(mapId);
    if (!detail) continue;
    const { map, nodes } = detail;
    const candidates = briefDraftCandidates(nodes, map);
    if (candidates.length === 0) continue;
    if (!(await briefDraftingOn(map))) continue;
    const stored = new Map((await listBriefDrafts(candidates.map((n) => n.id))).map((r) => [r.nodeId, r]));
    const due = candidates.filter((n) => {
      const hash = briefTextHash(n.text);
      return stored.get(n.id)?.textHash !== hash && retryDue(n.id, hash, now.getTime());
    });
    if (due.length === 0) continue;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const readme = await readmeOf(map);
    for (const node of due.slice(0, budget)) {
      budget--;
      const textHash = briefTextHash(node.text);
      try {
        const { reply, provider } = await draftBrief(mapId, await briefContext(map, node, byId, readme));
        failures.delete(node.id);
        if ('question' in reply) {
          await saveBriefDraft({ nodeId: node.id, textHash, outcome: 'question', question: reply.question, provider });
          result.asked++;
          continue;
        }
        // A person may have written a brief, tagged or claimed it while the
        // model thought — their change wins.
        const fresh = await nodeDb.getNode(node.id);
        if (!fresh || fresh.deletedAt || hasBrief(fresh) || fresh.claimedBySession !== null || fresh.text !== node.text) continue;
        const hold = dispatchHold(fresh, { nodeMap: new Map([...byId, [fresh.id, fresh]]), isDone: buildIsDonePredicate(map.statusWorkflow ?? []) });
        if (hold) continue;
        const updated = await nodeDb.updateNode(node.id, {
          description: reply.brief,
          descriptionSource: 'ai',
          ...(fresh.tags.includes(NEEDS_BRIEF_TAG) ? { tagsRemove: [NEEDS_BRIEF_TAG] } : {}),
        });
        if (!updated) continue;
        await saveBriefDraft({ nodeId: node.id, textHash, outcome: 'drafted', question: null, provider });
        // In the history under no person (userId null = the system).
        await recordEvent({ mapId, nodeId: node.id, userId: null, eventType: 'node.field_changed', fieldName: 'description', oldValue: null, newValue: reply.brief }).catch(() => {});
        broadcast(mapId, { type: 'node:updated', nodeId: node.id, fields: ['description', 'descriptionSource', 'tags'], node: updated });
        result.drafted++;
      } catch (err) {
        const prev = failures.get(node.id);
        failures.set(node.id, { hash: textHash, count: prev?.hash === textHash ? prev.count + 1 : 1, at: now.getTime() });
        result.errors.push(`node ${node.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return result;
}
