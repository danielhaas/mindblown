/**
 * Asks inbox — the fleet's open human questions, as MindBlown stores them.
 *
 * The truth is the collector (claude-fleet `bin/leidang-asks-collect`): it
 * reads the tick, the satellite rollups, pending-notes and GitHub, folds
 * the same question into one record keyed on its ticket, and pushes the
 * whole open set here every tick. MindBlown does NOT re-derive the list
 * from its own blocked nodes — that would be a second list that disagrees
 * with the terminal round. What this module owns is the reading (counts,
 * ordering, the "keine Frage" folds) and the write plan of an answer,
 * which mirrors `bin/leidang-asks-apply` line for line.
 */

export const ASK_ANSWERERS = ['Dan', 'Rita', 'Susi', 'Dana', 'Thomas', 'Kunde'] as const;
export type AskAnswerer = (typeof ASK_ANSWERERS)[number];

export const ASK_HINTS = ['decision', 'ops-task', 'waiting-external', 'already-decided', 'parked-plan'] as const;
export type AskHint = (typeof ASK_HINTS)[number];

export const ASK_ACTIONS = ['answered', 'later', 'delegate'] as const;
export type AskAction = (typeof ASK_ACTIONS)[number];

export const ASK_STATUSES = ['open', 'answered', 'later', 'delegated'] as const;
export type AskStatus = (typeof ASK_STATUSES)[number];

/** Hints that are not a question for the answerer — folded away in the inbox. */
export const ASK_NO_QUESTION_HINTS: readonly AskHint[] = ['already-decided', 'parked-plan'];

/** One collected question — the collector's item verbatim (the contract). */
export interface Ask {
  id: string;
  ticket: number | null;
  requirement: string | null;
  title: string | null;
  url: string | null;
  sources: string[];
  question: string;
  question_author: string | null;
  /** Every wording the collector folded into this record, by source (the «Mehr» view). */
  questions?: { source: string; author: string | null; text: string }[];
  options: string[];
  answerer: AskAnswerer | string;
  answerers?: string[];
  hint: AskHint | string;
  priority: string | null;
  milestone: string | null;
  needs_version: boolean;
  labels?: string[];
  idle_hours: number | null;
  unblocks: {
    node_id: string | null;
    node_title: string | null;
    node_status: string | null;
    claimed_by: string | null;
    worker: string | null;
    pr: number | string | null;
    pr_state: string | null;
  };
  moot: boolean;
  stale?: boolean;
  ticket_state?: string;
}

export interface AskDocumentMeta {
  generated_at?: string;
  tick?: string | null;
  sources_read?: string[];
  repo?: string;
  map_id?: string;
  counts?: { total?: number; by_answerer?: Record<string, number>; by_hint?: Record<string, number> };
}

/** What the collector pushes: `leidang-asks-collect --json-out`. */
export interface AskDocument {
  meta: AskDocumentMeta;
  items: Ask[];
}

/** The answer a human gave — same fields as `leidang-asks-apply`'s flags. */
export interface AskAnswerInput {
  action: AskAction;
  decision?: string;
  by?: string;
  milestone?: string;
  noRequeue?: boolean;
  delegateTo?: string;
}

/** One planned or executed write, as the ledger records it. */
export interface AskWrite {
  kind:
    | 'gh-comment'
    | 'gh-edit'
    | 'mb-put'
    | 'mb-skip'
    | 'worker-note'
    | 'worker-skip'
    | 'moot-skip'
    | 'ledger-only';
  target: string;
  detail: string;
  done: boolean;
  error?: string;
}

/** A stored ask: the collector item plus MindBlown's answer state. */
export interface AskRow {
  ask: Ask;
  status: AskStatus;
  /** When the collector last included this question. */
  pushedAt: string;
  firstSeenAt: string;
  answer: AskAnswerInput | null;
  answeredBy: string | null;
  answeredAt: string | null;
  writes: AskWrite[];
  /**
   * True when a PROMPT-BLOCKED worker still has to get this answer: the
   * note into the ops pane stays claudia-side (tmux), the next tick reads
   * answered rows and runs `leidang-asks-apply` for the worker path.
   */
  workerPending: boolean;
}

// ── parsing ────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Minimal shape check on one collector item; returns null when it is not one. */
export function parseAsk(raw: unknown): Ask | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 200) return null;
  if (typeof o.question !== 'string') return null;
  const u = (o.unblocks && typeof o.unblocks === 'object' ? o.unblocks : {}) as Record<string, unknown>;
  const ticket = typeof o.ticket === 'number' && Number.isInteger(o.ticket) ? o.ticket : null;
  return {
    id: o.id,
    ticket,
    requirement: str(o.requirement),
    title: str(o.title),
    url: str(o.url),
    sources: strList(o.sources),
    questions: Array.isArray(o.questions)
      ? o.questions
          .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object' && typeof (q as Record<string, unknown>).text === 'string')
          .map((q) => ({ source: str(q.source) ?? '?', author: str(q.author), text: q.text as string }))
      : [],
    question: o.question,
    question_author: str(o.question_author),
    options: strList(o.options),
    answerer: str(o.answerer) ?? 'Dan',
    answerers: strList(o.answerers),
    hint: str(o.hint) ?? 'decision',
    priority: str(o.priority),
    milestone: str(o.milestone),
    needs_version: o.needs_version === true,
    labels: strList(o.labels),
    idle_hours: typeof o.idle_hours === 'number' ? o.idle_hours : null,
    unblocks: {
      node_id: str(u.node_id),
      node_title: str(u.node_title),
      node_status: str(u.node_status),
      claimed_by: str(u.claimed_by),
      worker: str(u.worker),
      pr: typeof u.pr === 'number' || typeof u.pr === 'string' ? u.pr : null,
      pr_state: str(u.pr_state),
    },
    moot: o.moot === true,
    ...(o.stale === true ? { stale: true } : {}),
    ...(typeof o.ticket_state === 'string' ? { ticket_state: o.ticket_state } : {}),
  };
}

/** The whole push. Items that fail the shape check are dropped, not the document. */
export function parseAskDocument(raw: unknown): AskDocument | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.items)) return null;
  const items: Ask[] = [];
  const seen = new Set<string>();
  for (const it of o.items) {
    const a = parseAsk(it);
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    items.push(a);
  }
  const meta = (o.meta && typeof o.meta === 'object' ? o.meta : {}) as AskDocumentMeta;
  return { meta, items };
}

// ── the answer, as text ────────────────────────────────────────────

/** `Entscheid (Dan, 2026-09-03): …` — the same line on the issue and in the node. */
export function decisionLine(by: string, decision: string, date: string): string {
  return `Entscheid (${by}, ${date}): ${decision}`;
}

/** Body of the GitHub comment `leidang-asks-apply` posts. */
export function decisionCommentBody(by: string, decision: string, date: string): string {
  return `**${decisionLine(by, decision, date)}**\n\n_via /leidang-asks_`;
}

function pmParagraph(text: string, bold: boolean): unknown {
  return { type: 'paragraph', content: [{ type: 'text', text, ...(bold ? { marks: [{ type: 'bold' }] } : {}) }] };
}

/**
 * Put the decision at the top of a node description. Descriptions are a
 * plain string (the property panel's textarea, every MCP write) or a
 * ProseMirror doc (older rich-text nodes); the apply script only knew the
 * string case and would have corrupted a doc.
 */
export function prependDecision(description: unknown, line: string): unknown {
  if (description == null || description === '') return `**${line}**`;
  if (typeof description === 'string') return `**${line}**\n\n${description}`.trimEnd();
  if (typeof description === 'object') {
    const doc = description as { type?: string; content?: unknown[] };
    if (doc.type === 'doc' && Array.isArray(doc.content)) {
      return { ...doc, content: [pmParagraph(line, true), ...doc.content] };
    }
  }
  return `**${line}**`;
}

// ── the write plan ─────────────────────────────────────────────────

export interface AskNodeState {
  status: string | null;
  claimedBySession: string | null;
  /** Status category as the map's workflow reads it — done nodes are never re-opened. */
  isDone: boolean;
}

export interface AskWritePlan {
  /** Comment to post on the ticket, when it has one and the question is not moot. */
  github: { ticket: number; body: string; milestone: string | null } | null;
  /** Node update, when the question hangs on a node. */
  node: { nodeId: string; requeue: boolean; why: string } | null;
  /** A PROMPT-BLOCKED worker still has to receive the answer (claudia side). */
  worker: { worker: string } | null;
  /** Nothing is written and why (moot, later, delegate). */
  skip: string | null;
}

/**
 * What answering this ask writes — the decision table of `leidang-asks-apply`:
 *   moot        → nothing (the PR behind the worker's dialog is merged/closed)
 *   ticket      → gh comment (+ milestone/label edit when NEEDS-VERSION and a milestone came)
 *   node        → decision into description, blockedReason null, tag off; status → todo
 *                 unless done, claimed, or --no-requeue
 *   worker      → note for the fleet, delivered claudia-side
 * `later` and `delegate` are ledger-only.
 * Pure so the panel can show "was diese Antwort schreibt" before the click.
 */
export function planAskWrites(ask: Ask, input: AskAnswerInput, node: AskNodeState | null, date: string): AskWritePlan {
  const none: AskWritePlan = { github: null, node: null, worker: null, skip: null };
  if (input.action !== 'answered') {
    return { ...none, skip: input.action === 'delegate' ? `delegiert an ${input.delegateTo ?? '?'}` : 'vertagt — nichts geschrieben' };
  }
  if (ask.moot) {
    return { ...none, skip: `PR ${ask.unblocks.pr_state ?? '?'} — Frage ist hinfällig, nur der Dialog ist wegzuklicken` };
  }
  const by = input.by?.trim() || 'Dan';
  const decision = (input.decision ?? '').trim();
  const plan: AskWritePlan = { ...none };
  if (ask.ticket != null) {
    plan.github = {
      ticket: ask.ticket,
      body: decisionCommentBody(by, decision, date),
      milestone: ask.needs_version && input.milestone ? input.milestone : null,
    };
  }
  const nid = ask.unblocks.node_id;
  if (nid) {
    const st = node?.status ?? ask.unblocks.node_status;
    const claimed = node ? node.claimedBySession : ask.unblocks.claimed_by;
    if (node?.isDone || st === 'done' || st === 'cancelled') {
      plan.node = { nodeId: nid, requeue: false, why: `Knoten ist ${st} — fertige Arbeit wird nie wieder geöffnet` };
    } else if (input.noRequeue) {
      plan.node = { nodeId: nid, requeue: false, why: 'kein Requeue: Antwort notiert, Status bleibt' };
    } else if (claimed) {
      plan.node = { nodeId: nid, requeue: false, why: `geclaimt von ${claimed}: Status bleibt (Claim-Owner macht weiter)` };
    } else {
      plan.node = { nodeId: nid, requeue: true, why: 'Status → todo (beim nächsten Tick pullbar)' };
    }
  }
  if (ask.unblocks.worker) plan.worker = { worker: ask.unblocks.worker };
  return plan;
}

// ── reading ────────────────────────────────────────────────────────

const PRIO_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function prioRank(p: string | null): number {
  return p != null && p in PRIO_RANK ? PRIO_RANK[p] : 4;
}

/** Answerer → priority → idle age, as the terminal round orders them. */
export function sortAsks<T extends { ask: Ask }>(rows: T[]): T[] {
  const idx = (a: string) => {
    const i = (ASK_ANSWERERS as readonly string[]).indexOf(a);
    return i === -1 ? 9 : i;
  };
  return [...rows].sort(
    (x, y) =>
      idx(x.ask.answerer) - idx(y.ask.answerer) ||
      prioRank(x.ask.priority) - prioRank(y.ask.priority) ||
      (y.ask.idle_hours ?? 0) - (x.ask.idle_hours ?? 0),
  );
}

/** Not a question for the answerer: the text already is the decision, or Dan parked it himself. */
export function isNoQuestion(ask: Ask): boolean {
  return (ASK_NO_QUESTION_HINTS as readonly string[]).includes(ask.hint);
}

/** Only the NEEDS-VERSION label is open — the answer is a milestone, not a decision. */
export function isVersionOnly(ask: Ask): boolean {
  return ask.sources.length === 1 && ask.sources[0] === 'github:needs-version';
}

export interface AskCounts {
  total: number;
  byAnswerer: Record<string, number>;
  byHint: Record<string, number>;
  byStatus: Record<string, number>;
}

export function countAsks(rows: { ask: Ask; status: AskStatus }[]): AskCounts {
  const c: AskCounts = { total: rows.length, byAnswerer: {}, byHint: {}, byStatus: {} };
  for (const r of rows) {
    c.byAnswerer[r.ask.answerer] = (c.byAnswerer[r.ask.answerer] ?? 0) + 1;
    c.byHint[r.ask.hint] = (c.byHint[r.ask.hint] ?? 0) + 1;
    c.byStatus[r.status] = (c.byStatus[r.status] ?? 0) + 1;
  }
  return c;
}

export interface AskDigest {
  answered: number;
  later: number;
  delegated: number;
  tickets: string[];
  requeued: string[];
  delegated_to: string[];
  workerPending: string[];
}

/** `leidang-asks-apply --digest` over stored rows: what a run wrote. */
export function digestAsks(rows: AskRow[], since?: string | null): AskDigest {
  const sinceMs = since ? Date.parse(since) : NaN;
  const d: AskDigest = { answered: 0, later: 0, delegated: 0, tickets: [], requeued: [], delegated_to: [], workerPending: [] };
  for (const r of rows) {
    if (r.status === 'open' || !r.answeredAt) continue;
    if (!Number.isNaN(sinceMs) && Date.parse(r.answeredAt) < sinceMs) continue;
    if (r.status === 'answered') {
      d.answered++;
      if (r.ask.ticket != null) d.tickets.push(`#${r.ask.ticket}`);
      for (const w of r.writes) {
        if (w.kind === 'mb-put' && w.done && w.detail.includes('todo')) d.requeued.push(w.target);
      }
      if (r.workerPending) d.workerPending.push(r.ask.unblocks.worker ?? r.ask.id);
    } else if (r.status === 'later') {
      d.later++;
    } else if (r.status === 'delegated') {
      d.delegated++;
      d.delegated_to.push(`${r.ask.id}→${r.answer?.delegateTo ?? '?'}`);
    }
  }
  d.tickets = [...new Set(d.tickets)];
  d.requeued = [...new Set(d.requeued)];
  return d;
}

/** One line, as the Pushover digest reads it. */
export function formatAskDigest(d: AskDigest, runLabel: string): string {
  return (
    `/leidang-asks ${runLabel}: ${d.answered} beantwortet, ${d.later} vertagt, ${d.delegated} delegiert` +
    (d.tickets.length ? ` · Tickets ${d.tickets.join(', ')}` : '') +
    (d.requeued.length ? ` · wieder pullbar: ${d.requeued.join(', ')}` : ' · wieder pullbar: keine') +
    (d.delegated_to.length ? ` · delegiert: ${d.delegated_to.join(', ')}` : '') +
    (d.workerPending.length ? ` · Worker-Notiz ausstehend: ${d.workerPending.join(', ')}` : '')
  );
}
