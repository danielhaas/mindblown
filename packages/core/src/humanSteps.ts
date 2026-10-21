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
import type { Ask } from './asks.js';
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

export function buildStepAsk(
  node: { id: string; text: string; tags: string[]; description?: unknown; priority?: string | null; externalLinks?: ExternalLink[]; percentComplete?: number | null },
  mapId: string,
): Ask {
  const issue = (node.externalLinks ?? []).find((l) => isForgeLink(l) && !l.isPullRequest);
  const tag = dispatchSkipTag(node) ?? 'needs-human';
  const step = nextStepOf(node.description);
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
