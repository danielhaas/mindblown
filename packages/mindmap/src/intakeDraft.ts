/**
 * Pure helpers for the ticket-intake card (#387): the editable state the
 * card holds, its defaults from a server draft, and the accept payload
 * built from it. Kept out of the component so the rules are testable
 * without React:
 *   - a low-confidence estimate is a suggestion, not a write (Dan's call);
 *   - dependencies default to kept, the user unticks;
 *   - answers go back as one numbered message so the model sees
 *     question and answer side by side.
 */

import type { IntakeDraft, IntakeAcceptDraft, IntakeQuestion } from './api.js';

export interface DraftEdits {
  title: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3' | null;
  versionId: string | null;
  phaseId: string | null;
  tags: string[];
  /** Write the server's estimate on accept. Default: medium/high only. */
  keepEstimate: boolean;
  /** Dependency node ids the user kept. */
  keptDependencies: string[];
}

export function editsFromDraft(d: IntakeDraft): DraftEdits {
  return {
    title: d.title,
    description: d.description,
    priority: d.priority,
    versionId: d.versionId,
    phaseId: d.phaseId,
    tags: [...d.tags],
    keepEstimate: d.estimate != null && d.estimate.confidence !== 'low',
    keptDependencies: d.dependencies.map((x) => x.nodeId),
  };
}

export function toAcceptPayload(d: IntakeDraft, e: DraftEdits): IntakeAcceptDraft {
  const payload: IntakeAcceptDraft = {
    title: e.title.trim(),
    description: e.description.trim(),
    parentId: d.parentId,
    priority: e.priority,
    versionId: e.versionId,
    phaseId: e.phaseId,
    tags: e.tags.map((t) => t.trim()).filter((t) => t.length > 0),
    dependencies: e.keptDependencies.map((nodeId) => ({ nodeId })),
  };
  if (e.keepEstimate && d.estimate != null) payload.effortEstimate = d.estimate.estimate;
  return payload;
}

/** Numbered "question → answer" lines; unanswered questions are skipped. */
export function answersToMessage(
  questions: IntakeQuestion[],
  answers: Record<string, string>,
): string {
  const lines: string[] = [];
  questions.forEach((q, i) => {
    const a = (answers[q.id] ?? '').trim();
    if (a) lines.push(`${i + 1}. ${q.question}\n   → ${a}`);
  });
  return lines.join('\n');
}

/** Comma-separated tag input → list, trimmed, deduped, empties dropped. */
export function parseTags(raw: string): string[] {
  const out: string[] = [];
  for (const t of raw.split(',')) {
    const v = t.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}
