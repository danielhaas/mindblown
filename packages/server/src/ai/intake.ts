/**
 * Ticket intake (#387): the user describes a piece of work in rough prose,
 * the model turns it into a well-formed ticket that fits THIS plan, asks
 * up to three targeted questions, and hands the draft back for review.
 * Nothing is written until the user accepts — the accept route in
 * routes/ai.ts does the create.
 *
 * Plan-aware parts the model gets for free, so a generic CLI cannot match
 * them:
 *   - duplicate check: the server pre-runs a semantic search over the raw
 *     description and injects the closest existing nodes into the turn;
 *   - placement: the tree with ids is in the system prompt, the model
 *     picks a parent and says why;
 *   - version / phase: the map's lists are in the prompt;
 *   - estimate: computed server-side from the map's own calibration data
 *     (ai/estimate.ts) once a draft exists — the model never estimates.
 *
 * Sessions live in memory for the modal's lifetime (v1 decision): one
 * intakeId per dialog, TTL 30 min idle, lost on restart. Tickets accepted
 * in the session are fed back into the prompt so ticket three can depend
 * on ticket one.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool, allTools as sharedTools, type ToolSpec } from '@mindblown/tool-kit';
import type {
  Node as CoreNode,
  MindMap,
  Version,
  PhaseDef,
  Priority,
} from '@mindblown/core';
import type { ChatProvider, NormalizedMessage, NormalizedToolCall } from './providers/types.js';
import { executeTool as defaultExecuteTool, getChatToolSpecs, renderTreeForPrompt } from './tools.js';
import { semanticSearch as defaultSemanticSearch } from './embeddings.js';
import { estimateEffort as defaultEstimateEffort, type EstimateResult } from './estimate.js';

// ── Sessions ──────────────────────────────────────────────────────

export interface IntakeSession {
  id: string;
  mapId: string;
  userId: string;
  messages: NormalizedMessage[];
  /** Tickets accepted in this session, oldest first — prompt context for dependencies. */
  accepted: Array<{ nodeId: string; title: string }>;
  touchedAt: number;
}

export const SESSION_TTL_MS = 30 * 60 * 1000;
const sessions = new Map<string, IntakeSession>();

function sweepSessions(now = Date.now()): void {
  for (const [id, s] of sessions) {
    if (now - s.touchedAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

export function createIntakeSession(mapId: string, userId: string): IntakeSession {
  sweepSessions();
  const s: IntakeSession = {
    id: randomUUID(),
    mapId,
    userId,
    messages: [],
    accepted: [],
    touchedAt: Date.now(),
  };
  sessions.set(s.id, s);
  return s;
}

/** The live session, or null when unknown, expired, or bound to another map. */
export function getIntakeSession(id: string, mapId: string): IntakeSession | null {
  sweepSessions();
  const s = sessions.get(id);
  if (!s || s.mapId !== mapId) return null;
  s.touchedAt = Date.now();
  return s;
}

/** Test seam. */
export function resetIntakeSessions(): void {
  sessions.clear();
}

// ── Draft shape ───────────────────────────────────────────────────

export interface IntakeRef {
  nodeId: string;
  text: string;
  reason: string;
}

export interface IntakeDraft {
  title: string;
  /** Markdown with the fixed template headings (Why / What / Acceptance criteria / Out of scope). */
  description: string;
  parentId: string;
  parentText: string;
  parentReason: string;
  priority: Priority | null;
  versionId: string | null;
  versionName: string | null;
  phaseId: string | null;
  phaseName: string | null;
  tags: string[];
  dependencies: IntakeRef[];
  duplicates: IntakeRef[];
  /** Server-computed; null when the estimator failed or is unavailable. */
  estimate: EstimateResult | null;
}

export interface IntakeQuestion {
  id: string;
  question: string;
  options: string[];
  why: string | null;
}

export interface IntakeTurnResult {
  /** The model's prose for this turn (short by instruction). */
  text: string;
  draft: IntakeDraft | null;
  questions: IntakeQuestion[];
  /** The loop ran out of steps before the model handed back a draft. */
  stepLimit: boolean;
}

// ── Model-facing tools ────────────────────────────────────────────

const PRIORITY = z.enum(['P0', 'P1', 'P2', 'P3']);

const proposeTicketTool = defineTool({
  name: 'propose_ticket',
  description:
    'Hand the current ticket draft back to the user for review. Call it on EVERY turn where you have enough to draft — the first one included — and again with the updated draft after the user answers questions. Nothing is written until the user accepts.',
  schema: {
    title: z.string().min(1).describe('One line, imperative or noun phrase, no trailing period, no #-prefix'),
    description: z
      .string()
      .min(1)
      .describe('Markdown with exactly these headings: ## Why, ## What, ## Acceptance criteria, ## Out of scope'),
    parentId: z.string().describe('Id of the node the ticket goes under — a functional area from the tree, never a release'),
    parentReason: z.string().describe('One sentence: why this parent'),
    priority: PRIORITY.nullable().optional().describe('Only when the user said or clearly implied it'),
    versionId: z.string().nullable().optional().describe('From the versions list; null when unsure'),
    phaseId: z.string().nullable().optional().describe('From the phases list; null when unsure'),
    tags: z.array(z.string()).optional().describe('Tags the siblings under the parent already use, if any'),
    dependencies: z
      .array(z.object({ nodeId: z.string(), reason: z.string() }))
      .optional()
      .describe('Nodes this ticket cannot start before (finish-to-start). Existing tree ids or tickets accepted in this session.'),
    duplicates: z
      .array(z.object({ nodeId: z.string(), reason: z.string() }))
      .optional()
      .describe('Existing nodes that may already cover this request. The user decides.'),
  },
  handler: async () => 'Recorded.',
});

const askUserTool = defineTool({
  name: 'ask_user',
  description:
    'Ask the user up to three targeted questions whose answers change the draft. Never ask what you can infer from the map or the description. Give options where a choice is natural.',
  schema: {
    questions: z
      .array(
        z.object({
          id: z.string().describe('Short stable key, e.g. "scope" or "version"'),
          question: z.string().min(1),
          options: z.array(z.string()).optional().describe('2–4 short choices; omit for free text'),
          why: z.string().optional().describe('One clause: what the answer decides'),
        }),
      )
      .min(1)
      .max(3),
  },
  handler: async () => 'Recorded.',
});

const TERMINAL_TOOLS = new Set(['propose_ticket', 'ask_user']);
const READ_TOOLS = new Set(['search_nodes', 'semantic_search']);

/** Tool set for one intake turn: the two terminal tools plus read-only search. */
export function intakeToolSpecs(provider: ChatProvider): ToolSpec[] {
  const read = [
    ...sharedTools.filter((s) => READ_TOOLS.has(s.name)),
    ...getChatToolSpecs(provider).filter((s) => s.name === 'semantic_search'),
  ] as ToolSpec[];
  // Same widening the chat registry does: the concrete zod shape narrows the
  // handler's args; runtime safety comes from zod, not from this cast.
  return [proposeTicketTool as unknown as ToolSpec, askUserTool as unknown as ToolSpec, ...read];
}

// ── Prompt ────────────────────────────────────────────────────────

export interface IntakeContext {
  map: MindMap;
  nodes: CoreNode[];
  versions: Version[];
  parentHintId: string | null;
  accepted: IntakeSession['accepted'];
}

const TREE_CAP = 400;

export function buildIntakeSystemPrompt(ctx: IntakeContext): string {
  const byId = new Map(ctx.nodes.map((n) => [n.id, n]));
  const root = ctx.nodes.find((n) => n.parentId === null);
  const hint = ctx.parentHintId ? byId.get(ctx.parentHintId) : undefined;
  const effortUnit = ctx.map.effortUnit ?? 'days';

  const versionLines =
    ctx.versions.length > 0
      ? ctx.versions.map((v) => `- ${v.name} [${v.id}] (${v.status})`).join('\n')
      : '(none — leave versionId null)';
  const phases: PhaseDef[] = ctx.map.phases ?? [];
  const phaseLines =
    phases.length > 0
      ? phases.map((p) => `- ${p.name} [${p.id}]`).join('\n')
      : '(none — leave phaseId null)';
  const acceptedLines =
    ctx.accepted.length > 0
      ? ctx.accepted.map((a) => `- "${a.title}" [${a.nodeId}]`).join('\n')
      : '(none yet)';

  return `You are the ticket-intake assistant for the project mindmap "${ctx.map.name}". The user describes a piece of work in rough prose; you turn it into a well-formed ticket that fits THIS plan and hand it back for review. You never create nodes yourself — the user accepts the draft in the UI. Reply in the language the user writes in.

Effort unit of this map: ${effortUnit}. Estimation is done by the server after you draft — do not estimate.

How a turn works:
1. Duplicates first. A server note under the user's message lists existing nodes that are semantically close; use semantic_search or search_nodes when you need more. If an existing node already covers the request, say so in one sentence and list it under duplicates — still propose the draft so the user decides.
2. Placement. Pick parentId from the tree below: a functional area, never a release. Prefer the parent hint unless the work clearly belongs elsewhere. Say why in parentReason.
3. Version and phase. Suggest what the siblings under that parent use; leave null and ask when it is genuinely ambiguous.
4. Dependencies. Only ids from the tree or from tickets accepted earlier in this session, each with a reason. Most tickets have none.
5. Call propose_ticket on EVERY turn where you have enough to draft — the first one included. If details are missing that change the ticket, ALSO call ask_user with at most three questions (options where a choice is natural). Never ask what you can infer. When the user answers, call propose_ticket again with the updated draft.
6. Keep prose to one or two sentences; the draft carries the content.

Ticket template for description (markdown, exactly these headings, in the user's language):
## Why — one short paragraph: the problem or motivation
## What — the change, concrete
## Acceptance criteria — 2 to 5 checkable bullets
## Out of scope — what this ticket deliberately does not do
The title is one line, imperative or noun phrase, no trailing period.

Rules: only use ids shown in [brackets]; never invent ids. Do not put the title into the description.

mapId = "${ctx.map.id}"
Root node: "${root?.text ?? 'Root'}" [${root?.id ?? ''}]
Parent hint: ${hint ? `"${hint.text}" [${hint.id}]` : '(none — choose from the tree)'}

Versions:
${versionLines}

Phases:
${phaseLines}

Tickets accepted earlier in this session:
${acceptedLines}

Map tree:
${renderTreeForPrompt(ctx.nodes, TREE_CAP)}`;
}

// ── Draft sanitising ──────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function refs(
  raw: unknown,
  byId: Map<string, CoreNode>,
  extra: Map<string, string>,
): IntakeRef[] {
  if (!Array.isArray(raw)) return [];
  const out: IntakeRef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const nodeId = str(r.nodeId);
    if (!nodeId || seen.has(nodeId)) continue;
    const text = byId.get(nodeId)?.text ?? extra.get(nodeId);
    if (text === undefined) continue; // invented id — drop silently
    seen.add(nodeId);
    out.push({ nodeId, text, reason: str(r.reason) });
  }
  return out;
}

/**
 * Validate a propose_ticket call against the map: unknown ids are dropped
 * or fall back, so the client never sees an id it cannot resolve. Returns
 * null when the call has no usable title or description.
 */
export function sanitizeDraft(
  args: Record<string, unknown>,
  ctx: IntakeContext,
): Omit<IntakeDraft, 'estimate'> | null {
  const title = str(args.title);
  const description = str(args.description);
  if (!title || !description) return null;

  const byId = new Map(ctx.nodes.map((n) => [n.id, n]));
  const root = ctx.nodes.find((n) => n.parentId === null);
  const acceptedById = new Map(ctx.accepted.map((a) => [a.nodeId, a.title]));

  let parentId = str(args.parentId);
  let parentReason = str(args.parentReason);
  if (!byId.has(parentId)) {
    const fallback = (ctx.parentHintId && byId.has(ctx.parentHintId) ? ctx.parentHintId : root?.id) ?? '';
    parentReason = parentId
      ? `Proposed parent id was not in the map; placed under ${byId.get(fallback)?.text ?? 'the root'} instead.`
      : parentReason;
    parentId = fallback;
  }
  if (!parentId) return null;

  const priorityRaw = str(args.priority);
  const priority = PRIORITY.safeParse(priorityRaw).success ? (priorityRaw as Priority) : null;

  const versionId = str(args.versionId);
  const version = ctx.versions.find((v) => v.id === versionId) ?? null;
  const phaseId = str(args.phaseId);
  const phase = (ctx.map.phases ?? []).find((p) => p.id === phaseId) ?? null;

  const tags = Array.isArray(args.tags)
    ? Array.from(new Set(args.tags.map(str).filter((t) => t.length > 0)))
    : [];

  return {
    title,
    description,
    parentId,
    parentText: byId.get(parentId)?.text ?? '',
    parentReason,
    priority,
    versionId: version?.id ?? null,
    versionName: version?.name ?? null,
    phaseId: phase?.id ?? null,
    phaseName: phase?.name ?? null,
    tags,
    dependencies: refs(args.dependencies, byId, acceptedById),
    duplicates: refs(args.duplicates, byId, new Map()),
  };
}

export function sanitizeQuestions(args: Record<string, unknown>): IntakeQuestion[] {
  if (!Array.isArray(args.questions)) return [];
  const out: IntakeQuestion[] = [];
  for (const item of args.questions) {
    if (!item || typeof item !== 'object') continue;
    const q = item as Record<string, unknown>;
    const question = str(q.question);
    if (!question) continue;
    const options = Array.isArray(q.options)
      ? q.options.map(str).filter((o) => o.length > 0).slice(0, 4)
      : [];
    out.push({
      id: str(q.id) || `q${out.length + 1}`,
      question,
      options,
      why: str(q.why) || null,
    });
    if (out.length === 3) break;
  }
  return out;
}

// ── The turn ──────────────────────────────────────────────────────

/** Injectable side effects, so the loop is testable with a scripted provider. */
export interface IntakeIo {
  executeTool: typeof defaultExecuteTool;
  semanticSearch: typeof defaultSemanticSearch;
  estimateEffort: typeof defaultEstimateEffort;
}

const defaultIo: IntakeIo = {
  executeTool: defaultExecuteTool,
  semanticSearch: defaultSemanticSearch,
  estimateEffort: defaultEstimateEffort,
};

export const INTAKE_MAX_STEPS = 8;
/** Below this cosine score a pre-search hit is noise, not a duplicate candidate. */
const DUPLICATE_MIN_SCORE = 0.55;

export interface RunIntakeTurnOptions {
  provider: ChatProvider;
  session: IntakeSession;
  ctx: IntakeContext;
  message: string;
  signal?: AbortSignal;
  io?: Partial<IntakeIo>;
}

function ancestorPath(nodeId: string, byId: Map<string, CoreNode>): string {
  const parts: string[] = [];
  let cur = byId.get(nodeId);
  while (cur) {
    parts.unshift(cur.text);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(' → ');
}

export async function runIntakeTurn(opts: RunIntakeTurnOptions): Promise<IntakeTurnResult> {
  const io: IntakeIo = { ...defaultIo, ...(opts.io ?? {}) };
  const { provider, session, ctx } = opts;
  const byId = new Map(ctx.nodes.map((n) => [n.id, n]));

  // Deterministic duplicate pre-check: the model may search further, but
  // the closest existing nodes are always in front of it.
  let userContent = opts.message.trim();
  try {
    const hits = (await io.semanticSearch(ctx.map.id, userContent, 5)).filter(
      (h) => h.score >= DUPLICATE_MIN_SCORE,
    );
    if (hits.length > 0) {
      userContent +=
        `\n\n[Server note — existing nodes semantically close to this request; check for duplicates before drafting:\n` +
        hits.map((h, i) => `${i + 1}. "${h.text}" [${h.nodeId}] score ${h.score.toFixed(2)}`).join('\n') +
        `]`;
    }
  } catch {
    // No embeddings, no note — the model can still search by hand.
  }
  session.messages.push({ role: 'user', content: userContent });

  const systemPrompt = buildIntakeSystemPrompt(ctx);
  const tools = intakeToolSpecs(provider);

  let text = '';
  let draftArgs: Record<string, unknown> | null = null;
  let questionArgs: Record<string, unknown> | null = null;
  let stepLimit = false;

  for (let step = 0; step < INTAKE_MAX_STEPS; step++) {
    let assistantText = '';
    const toolCalls: NormalizedToolCall[] = [];
    for await (const ev of provider.runTurn({
      systemPrompt,
      messages: session.messages,
      tools,
      signal: opts.signal,
    })) {
      if (ev.type === 'text_delta') assistantText += ev.text;
      else if (ev.type === 'tool_call') toolCalls.push(ev.toolCall);
    }
    if (assistantText.trim()) text = assistantText.trim();

    // Anthropic rejects empty assistant turns on replay — skip a no-op turn.
    if (assistantText || toolCalls.length > 0) {
      session.messages.push({ role: 'assistant', content: assistantText, toolCalls });
    }
    if (toolCalls.length === 0) break;

    let terminal = false;
    for (const call of toolCalls) {
      let result: string;
      if (call.name === 'propose_ticket') {
        draftArgs = call.args;
        terminal = true;
        result = 'Recorded — the user sees this draft now.';
      } else if (call.name === 'ask_user') {
        questionArgs = call.args;
        terminal = true;
        result = 'Recorded — the user sees these questions now.';
      } else if (READ_TOOLS.has(call.name)) {
        result = await io.executeTool(call.name, call.args, {
          userId: session.userId,
          mapId: ctx.map.id,
        });
      } else {
        result = `Error: tool "${call.name}" is not available during ticket intake.`;
      }
      session.messages.push({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: result,
      });
    }
    if (terminal) break;
    if (step === INTAKE_MAX_STEPS - 1) stepLimit = true;
  }

  const base = draftArgs ? sanitizeDraft(draftArgs, ctx) : null;
  let draft: IntakeDraft | null = null;
  if (base) {
    let estimate: EstimateResult | null = null;
    try {
      estimate = await io.estimateEffort(provider, { map: ctx.map, nodes: ctx.nodes }, {
        text: base.title,
        description: base.description,
        path: ancestorPath(base.parentId, byId),
      });
    } catch {
      estimate = null;
    }
    draft = { ...base, estimate };
  }

  session.touchedAt = Date.now();
  return {
    text,
    draft,
    questions: questionArgs ? sanitizeQuestions(questionArgs) : [],
    stepLimit,
  };
}

/** Remember an accepted ticket so later drafts in the session can depend on it. */
export function recordAccepted(session: IntakeSession, nodeId: string, title: string): void {
  session.accepted.push({ nodeId, title });
  session.messages.push({
    role: 'user',
    content: `[Server note — the user accepted the draft. It is now node "${title}" [${nodeId}]. Next ticket follows.]`,
  });
  session.touchedAt = Date.now();
}

export { TERMINAL_TOOLS };
