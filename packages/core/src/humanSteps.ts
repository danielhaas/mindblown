/**
 * "Your steps" — tickets only a person can do, as rows on the Questions card.
 *
 * The Kanban "Needs you" badge counts every ticket held for a person
 * (`dispatchHold`), but the Questions card only listed questions: on Navy
 * (21.10.2026) the board said 15, the card said 2. The other 13 were steps
 * tagged needs-human — a phone check, a store upload, a server move — that
 * nobody is asked about because they are not questions. Listed here, the
 * card says everything waiting on a person: questions to answer, steps to do.
 *
 * Like stalled asks (stalled.ts) they are derived on read, never stored
 * while open: the tag is the truth, and answering changes the tag.
 */
import { questionParts, type Ask, type QuestionParts } from './asks.js';
import { dispatchSkipTag } from './dispatch.js';
import { proseMirrorToPlainText } from './richtext.js';
import { isForgeLink, type ExternalLink } from './types.js';
import { STALLED_ASK_OPTIONS, stalledAnswerAction, stalledAskNodeId } from './stalled.js';

export const STEP_ASK_PREFIX = 'step-';
export const STEP_ASK_OPTIONS = ['Done', 'Fleet can do it'] as const;
/**
 * What an answer does — the lint fix of the same name. Free text runs
 * needs-human with the text as the note: it becomes the new next step.
 */
export type StepAnswer = 'mark-done' | 'to-fleet' | 'needs-human';

export function stepAskId(nodeId: string): string {
  return STEP_ASK_PREFIX + nodeId;
}

/** The node a step row is about, or null for any other ask id. */
export function stepAskNodeId(askId: string): string | null {
  return askId.startsWith(STEP_ASK_PREFIX) && askId.length > STEP_ASK_PREFIX.length ? askId.slice(STEP_ASK_PREFIX.length) : null;
}

/** Rows MindBlown derives itself (stalled work, a person's steps) — not the collector's. */
export function isDerivedAsk(a: Pick<Ask, 'id'>): boolean {
  return stalledAskNodeId(a.id) !== null || stepAskNodeId(a.id) !== null;
}

/** The step a needs-human node carries: "Next step (a person): …" at the top of its description. */
export function nextStepOf(description: unknown): string | null {
  const text = typeof description === 'string' ? description : description ? proseMirrorToPlainText(description) : '';
  const m = /Next step \(a person\):\s*([^\n*]+)/.exec(text ?? '');
  return m ? m[1].trim() : null;
}

const SUMMARY_MAX = 1000;

/**
 * What the step row says when no "Next step (a person):" line is there: the
 * description's first paragraph, headings skipped. Most needs-human nodes
 * (audit findings, ops tickets) say what is left in it, and the bare
 * "Tagged needs-human" sent the reader into the node for every row.
 */
export function stepSummaryOf(description: unknown): string | null {
  const text = typeof description === 'string' ? description : description ? proseMirrorToPlainText(description) : '';
  for (const para of (text ?? '').split(/\n\s*\n/)) {
    const body = para
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join(' ')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (body) return body.length > SUMMARY_MAX ? `${body.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : body;
  }
  return null;
}

/** A step split for reading — `ordered` false when the items are separate points, not a sequence. */
export interface StepParts extends QuestionParts {
  ordered: boolean;
}

// An audit finding opens with its severity: "MEDIUM (needs prior RCE …)." or "LOW / policy.".
const SEVERITY = /^((?:CRITICAL|HIGH|MEDIUM|LOW)\b(?:[^.(]|\([^)]*\))*\.)\s+/;
const ABBREV = /\b(?:e\.g|i\.e|etc|vs|ca|approx)\.$/i;

function sentences(text: string): string[] {
  const out: string[] = [];
  for (const piece of text.split(/(?<=\.)\s+(?=\S)/)) {
    if (out.length > 0 && ABBREV.test(out[out.length - 1])) out[out.length - 1] += ` ${piece}`;
    else out.push(piece);
  }
  return out;
}

/**
 * A run of ≥3 items joined by `sep` — "Left: a; b; c" or "needs: a → b → c" —
 * as lead (up to the colon, or the sentence start), items and what follows.
 */
function runOf(t: string, sep: string): QuestionParts | null {
  const first = t.indexOf(sep);
  const last = t.lastIndexOf(sep);
  if (first < 0 || t.split(sep).length < 3) return null;
  const sentenceStart = Math.max(0, t.lastIndexOf('. ', first) + 2);
  const colon = t.lastIndexOf(': ', first);
  const start = colon >= sentenceStart ? colon + 2 : sentenceStart;
  const endMatch = /\.\s+(?=[A-Z])/.exec(t.slice(last));
  const end = endMatch ? last + endMatch.index + 1 : t.length;
  const items = t
    .slice(start, end)
    .split(sep)
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter(Boolean);
  return { lead: t.slice(0, start).trim(), items, tail: t.slice(end).trim() };
}

/**
 * Steps are written as one paragraph like questions, but list differently:
 * "Left: a; b; c" and "a → b → c" are a sequence (numbered); an audit
 * finding — "LOW. Sentence. Sentence." — is separate points under its
 * severity (bullets). Numbered lines go through questionParts.
 */
export function stepParts(text: string): StepParts {
  const t = (text ?? '').trim();
  const q = questionParts(t);
  if (q.items.length > 0) return { ...q, ordered: true };
  const sev = SEVERITY.exec(t);
  if (sev) {
    const points = sentences(t.slice(sev[0].length));
    if (points.length >= 2) return { lead: sev[1], items: points, tail: '', ordered: false };
  }
  for (const sep of ['; ', ' → ']) {
    const run = runOf(t, sep);
    if (run) return { ...run, ordered: true };
  }
  return { lead: t, items: [], tail: '', ordered: false };
}

export function buildStepAsk(
  node: { id: string; text: string; tags: string[]; description?: unknown; priority?: string | null; externalLinks?: ExternalLink[]; percentComplete?: number | null },
  mapId: string,
): Ask {
  const issue = (node.externalLinks ?? []).find((l) => isForgeLink(l) && !l.isPullRequest);
  const tag = dispatchSkipTag(node) ?? 'needs-human';
  const step = nextStepOf(node.description);
  const summary = step ? null : stepSummaryOf(node.description);
  return {
    id: stepAskId(node.id),
    map_id: mapId,
    ticket: null,
    requirement: null,
    title: node.text,
    url: issue?.url ?? null,
    sources: ['mindblown-step'],
    question: step
      ? `Next step: ${step}`
      : summary
        ? summary
        : `Tagged ${tag} — the fleet leaves it to a person. Open the node for what is left.`,
    question_author: 'MindBlown',
    options: [...STEP_ASK_OPTIONS],
    answerer: 'Dan',
    hint: 'ops-task',
    priority: node.priority ?? null,
    milestone: null,
    needs_version: false,
    idle_hours: null,
    unblocks: {
      node_id: node.id,
      node_title: node.text,
      node_status: `${tag}${node.percentComplete ? ` · ${node.percentComplete} %` : ''}`,
      claimed_by: null,
      worker: null,
      pr: null,
      pr_state: null,
    },
    moot: false,
  };
}

/** Which write an answer to a step means: Done, Fleet can do it, else the text is the new next step. */
export function stepAnswerAction(decision: string): StepAnswer {
  const d = decision.trim().toLowerCase();
  if (d === 'done' || d === 'mark done' || d === 'mark-done') return 'mark-done';
  if (d === 'fleet can do it' || d === 'to-fleet' || d === 'fleet') return 'to-fleet';
  return 'needs-human';
}

/**
 * What answering a derived row writes, for the card's preview — the
 * collector's rows preview through planAskWrites instead.
 */
export function derivedAnswerPreview(a: Pick<Ask, 'id'>, decision: string): string[] | null {
  const d = decision.trim();
  if (stalledAskNodeId(a.id)) {
    switch (stalledAnswerAction(d)) {
      case 'mark-done':
        return ['Node: done, 100 % (the linked issue closes via sync)'];
      case 'requeue':
        return ['Node: back to the queue — todo, progress kept, the fleet can take it'];
      default:
        return [
          STALLED_ASK_OPTIONS.some((o) => o.toLowerCase() === d.toLowerCase()) || !d
            ? 'Node: tagged needs-human — the fleet leaves it; it moves to Your steps'
            : `Node: tagged needs-human, "Next step (a person): ${d}" at the top of the description`,
        ];
    }
  }
  if (stepAskNodeId(a.id)) {
    switch (stepAnswerAction(d)) {
      case 'mark-done':
        return ['Node: done, 100 % (the linked issue closes via sync)'];
      case 'to-fleet':
        return ['Node: needs-human (and other skip tags) removed, back to the queue as todo — the fleet takes it'];
      default:
        return [`Node: "Next step (a person): ${d || '…'}" at the top of the description — the step stays yours`];
    }
  }
  return null;
}
