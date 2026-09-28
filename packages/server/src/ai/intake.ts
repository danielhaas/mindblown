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
import {
  estimateEffort as defaultEstimateEffort,
  AiBadResponseError,
  type EstimateResult,
} from './estimate.js';
import {
  searchForgeIssues as defaultSearchForgeIssues,
  keywordQuery,
  preSearchLines,
  nodeMatchFacts,
  type ForgeIssueHit,
  type IntakeExisting,
  type IntakeVerdict,
  type IntakeRecommendation,
  type SearchForgeIssues,
} from './intakeExisting.js';

export type { IntakeExisting, IntakeVerdict, IntakeRecommendation } from './intakeExisting.js';

// ── Sessions ──────────────────────────────────────────────────────

export interface IntakeSession {
  id: string;
  mapId: string;
  userId: string;
  messages: NormalizedMessage[];
  /** Tickets accepted in this session, oldest first — prompt context for dependencies. */
  accepted: Array<{ nodeId: string; title: string }>;
  /** Forge-only issues the pre-search surfaced, by number — so a draft can refer to them. */
  forgeHits: Map<number, ForgeIssueHit>;
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
    forgeHits: new Map(),
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
  /**
   * Does this already exist? `new` = nothing found; `covered` = an
   * existing ticket already covers it; `extends` = existing ticket, new
   * information; `regression` = it was done and is back.
   */
  verdict: IntakeVerdict;
  /** The existing tickets behind the verdict, each with a recommended action. */
  existing: IntakeExisting[];
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
const VERDICT = z.enum(['new', 'covered', 'extends', 'regression']);
const RECOMMENDATION = z.enum(['nothing', 'comment', 'reopen', 'create']);

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
    verdict: VERDICT.optional().describe(
      'new = nothing existing matches; covered = an existing ticket already covers the request; extends = an existing ticket, but the user brings new information; regression = it was done and the problem is back.',
    ),
    existing: z
      .array(
        z.object({
          nodeId: z.string().optional().describe('Map node id from the tree or the server note'),
          issueNumber: z.number().int().optional().describe('Issue number for a forge-only hit from the server note'),
          reason: z.string(),
          recommendation: RECOMMENDATION.describe(
            'nothing = already covered, no action; comment = add the new information to the existing ticket; reopen = it was closed without shipped code and is back; create = new ticket anyway (always when the existing one was fixed by a merged PR).',
          ),
        }),
      )
      .optional()
      .describe('The existing tickets behind a non-new verdict. Empty for verdict new.'),
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
  /** Forge-only hits the session has seen, so `existing[].issueNumber` resolves. */
  forgeHits?: Map<number, ForgeIssueHit>;
}

const TREE_CAP = 400;

/**
 * How the model hands the draft back. `tools`: Claude calls propose_ticket /
 * ask_user and may search first. `json`: one JSON object per turn, no tool
 * use — what a local 14B-class model does reliably (it drifts on a multi-
 * tool loop, so the duplicate pre-search is its only search).
 */
export type IntakeMode = 'tools' | 'json';

export function intakeModeFor(provider: Pick<ChatProvider, 'name'>): IntakeMode {
  return provider.name === 'anthropic' ? 'tools' : 'json';
}

const EXISTING_RULE = `Existing work first. A server note under the user's message lists existing tickets that look related: map nodes with status, done date, linked issue and whether a merged PR fixed them, and issues on the repo that are NOT in this map. Decide the verdict:
   - new: nothing related, or only loosely related.
   - covered: an existing ticket already asks for exactly this → recommendation "nothing".
   - extends: an existing open or unfinished ticket, and the user brings new information → "comment".
   - regression: it was done and the problem is back. If it was fixed by a merged PR, that fix shipped and this is a NEW bug → "create" (the new ticket relates to the old one). If it was closed by hand or without shipped code → "reopen".
   Say the verdict in one sentence and ALWAYS still propose the draft, so the user can create it anyway.`;

const TURN_RULES_TOOLS = `How a turn works:
1. ${EXISTING_RULE} Use semantic_search or search_nodes when the note is not enough.
2. Placement. Pick parentId from the tree below: a functional area, never a release. Prefer the parent hint unless the work clearly belongs elsewhere. Say why in parentReason.
3. Version and phase. Suggest what the siblings under that parent use; leave null and ask when it is genuinely ambiguous.
4. Dependencies. Only ids from the tree or from tickets accepted earlier in this session, each with a reason. Most tickets have none.
5. Call propose_ticket on EVERY turn where you have enough to draft — the first one included. If details are missing that change the ticket, ALSO call ask_user with at most three questions (options where a choice is natural). Never ask what you can infer. When the user answers, call propose_ticket again with the updated draft.
6. Keep prose to one or two sentences; the draft carries the content.`;

const TURN_RULES_JSON = `How a turn works:
1. ${EXISTING_RULE}
2. Placement. Pick "parentId" from the tree below: a functional area, never a release. Prefer the parent hint unless the work clearly belongs elsewhere. Say why in "parentReason".
3. Version and phase. Suggest what the siblings under that parent use; use null when unsure.
4. Dependencies. Only ids from the tree or from tickets accepted earlier in this session, each with a reason. Most tickets have none.
5. Produce the draft on EVERY turn where you have enough — the first one included. If details are missing that change the ticket, ALSO list at most three questions (options where a choice is natural). Never ask what you can infer. When the user answers, produce the updated draft.
6. Keep "text" to one or two sentences; the draft carries the content.

Return ONLY one JSON object, no markdown fences, no prose outside it:
{
  "text": "<one or two sentences>",
  "draft": {
    "title": "<one line>",
    "description": "<markdown with the four headings>",
    "parentId": "<id from the tree>",
    "parentReason": "<one sentence>",
    "priority": "P0" | "P1" | "P2" | "P3" | null,
    "versionId": "<id from the versions list>" | null,
    "phaseId": "<id from the phases list>" | null,
    "tags": ["<tag>"],
    "dependencies": [{"nodeId": "<id>", "reason": "<why>"}],
    "verdict": "new" | "covered" | "extends" | "regression",
    "existing": [{"nodeId": "<id>" | null, "issueNumber": <number> | null, "reason": "<why>", "recommendation": "nothing" | "comment" | "reopen" | "create"}]
  } | null,
  "questions": [{"id": "<key>", "question": "<text>", "options": ["<a>", "<b>"], "why": "<what it decides>"}]
}`;

export function buildIntakeSystemPrompt(ctx: IntakeContext, mode: IntakeMode = 'tools'): string {
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

${mode === 'tools' ? TURN_RULES_TOOLS : TURN_RULES_JSON}

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
    ...existingRefs(args, byId, ctx.forgeHits ?? new Map()),
  };
}

/**
 * Resolve the model's `existing` list against the map and the session's
 * forge hits; invented ids are dropped. A verdict without survivors
 * becomes `new`; survivors without a verdict become `extends`. Accepts
 * the pre-#409 `duplicates` name too.
 */
function existingRefs(
  args: Record<string, unknown>,
  byId: Map<string, CoreNode>,
  forgeHits: Map<number, ForgeIssueHit>,
): { verdict: IntakeVerdict; existing: IntakeExisting[] } {
  const raw = Array.isArray(args.existing) ? args.existing : Array.isArray(args.duplicates) ? args.duplicates : [];
  const out: IntakeExisting[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const reason = str(r.reason);
    const recRaw = str(r.recommendation);
    const recommendation = RECOMMENDATION.safeParse(recRaw).success ? (recRaw as IntakeRecommendation) : 'comment';
    const nodeId = str(r.nodeId);
    const node = nodeId ? byId.get(nodeId) : undefined;
    if (node) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      const f = nodeMatchFacts(node);
      out.push({
        nodeId: node.id,
        issueNumber: f.issueNumber,
        url: f.issueUrl,
        text: node.text,
        status: f.status,
        closedAt: f.closedAt,
        fixedByPr: f.fixedByPr,
        reason,
        // A shipped fix is not reopened — the draft relates to it instead.
        recommendation: f.fixedByPr && recommendation === 'reopen' ? 'create' : recommendation,
      });
      continue;
    }
    const num = typeof r.issueNumber === 'number' ? r.issueNumber : Number(str(r.issueNumber));
    const hit = Number.isInteger(num) ? forgeHits.get(num) : undefined;
    if (!hit) continue; // invented reference
    const key = `#${hit.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      nodeId: null,
      issueNumber: hit.number,
      url: hit.url,
      text: hit.title,
      status: hit.state,
      closedAt: hit.closedAt,
      fixedByPr: false,
      reason,
      recommendation,
    });
  }
  const verdictRaw = str(args.verdict);
  let verdict: IntakeVerdict = VERDICT.safeParse(verdictRaw).success ? (verdictRaw as IntakeVerdict) : 'new';
  if (out.length === 0) verdict = 'new';
  else if (verdict === 'new') verdict = 'extends';
  return { verdict, existing: out };
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
  searchForgeIssues: SearchForgeIssues;
}

const defaultIo: IntakeIo = {
  executeTool: defaultExecuteTool,
  semanticSearch: defaultSemanticSearch,
  estimateEffort: defaultEstimateEffort,
  searchForgeIssues: defaultSearchForgeIssues,
};

export const INTAKE_MAX_STEPS = 8;
/** JSON mode: how many prior messages (user + assistant) travel with each turn. */
const JSON_HISTORY_CAP = 12;

/** Strip fences and trailing chatter a small model adds even in JSON mode. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
  const candidates = [cleaned];
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
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

  // Deterministic "does it exist?" pre-check: the model may search further,
  // but the closest map nodes (with status / done date / linked issue) and
  // the repo's own matching issues are always in front of it.
  let userContent = opts.message.trim();
  const [nodeHits, forgeHits] = await Promise.all([
    io
      .semanticSearch(ctx.map.id, userContent, 5)
      .then((hits) => hits.filter((h) => h.score >= DUPLICATE_MIN_SCORE))
      .catch(() => []), // no embeddings, no node hits — the model can still search by hand
    io.searchForgeIssues(ctx.map.id, keywordQuery(userContent)).catch(() => []),
  ]);
  for (const f of forgeHits) session.forgeHits.set(f.number, f);
  ctx.forgeHits = session.forgeHits;
  const noteLines = preSearchLines({ nodeHits, forgeHits, nodes: ctx.nodes });
  if (noteLines.length > 0) {
    userContent +=
      `\n\n[Server note — existing work that looks related; decide the verdict before drafting:\n` +
      noteLines.join('\n') +
      `]`;
  }
  session.messages.push({ role: 'user', content: userContent });

  const mode = intakeModeFor(provider);
  const systemPrompt = buildIntakeSystemPrompt(ctx, mode);

  let text = '';
  let draftArgs: Record<string, unknown> | null = null;
  let questionArgs: Record<string, unknown> | null = null;
  let stepLimit = false;

  if (mode === 'json') {
    // One completion per turn. The conversation so far is rendered into the
    // user turn (the local backend has no prompt caching to lose), capped
    // so a long session cannot overrun a small context window.
    const history = session.messages.slice(-JSON_HISTORY_CAP);
    const rendered = history
      .map((m) =>
        m.role === 'user'
          ? `User:\n${m.content}`
          : m.role === 'assistant'
            ? `Assistant (JSON):\n${m.content}`
            : '',
      )
      .filter((s) => s.length > 0)
      .join('\n\n');
    const raw = await provider.complete({
      systemPrompt,
      parts: [{ text: rendered }, { text: 'Return the JSON object now.' }],
      format: 'json',
      temperature: 0,
      maxTokens: 2048,
      signal: opts.signal,
    });
    const parsed = parseJsonObject(raw);
    if (!parsed) throw new AiBadResponseError('Model did not return a usable JSON object');
    session.messages.push({ role: 'assistant', content: JSON.stringify(parsed), toolCalls: [] });
    text = str(parsed.text);
    if (parsed.draft && typeof parsed.draft === 'object') {
      draftArgs = parsed.draft as Record<string, unknown>;
    }
    if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
      questionArgs = { questions: parsed.questions };
    }
  }

  const tools = mode === 'tools' ? intakeToolSpecs(provider) : [];
  for (let step = 0; mode === 'tools' && step < INTAKE_MAX_STEPS; step++) {
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

/** Remember a non-create outcome so the next turn does not re-propose the same ticket. */
export function recordDecision(session: IntakeSession, note: string): void {
  session.messages.push({ role: 'user', content: `[Server note — ${note} Next ticket follows.]` });
  session.touchedAt = Date.now();
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
