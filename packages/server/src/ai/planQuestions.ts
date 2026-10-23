/**
 * Questions before a plan is drafted (setup wizard → "Draft the plan with
 * AI"). The model reads the project description and asks the few things
 * whose answers would change the plan most; the answers are appended to the
 * prose the brain dump drafts from. No questions when the description
 * already covers what matters.
 */

export const MAX_PLAN_QUESTIONS = 3;

export const PLAN_QUESTIONS_SYSTEM_PROMPT = `You help plan a new project. A plan (a tree of work areas and tasks) will be drafted from the description you are given. Before that, ask the person the questions whose answers would change the plan the most.

Good topics, in order of value:
- who uses it and for what
- what must be in the first usable version, and what is explicitly out
- hard constraints: deadline, platform, integrations, existing systems

Rules:
- At most ${MAX_PLAN_QUESTIONS} questions; fewer is fine
- Skip anything the description already answers. If it answers everything that matters, return no questions
- One short sentence each, plain words, no jargon, no numbering
- Write in English
- Return ONLY a JSON object: {"questions": ["...", "..."]} — no preamble, no markdown fences`;

export function planQuestionsUserPrompt(input: { projectName: string; prose: string; existingAreas: string[] }): string {
  let prompt = `Project: ${input.projectName}\n\nDescription:\n${input.prose.trim()}`;
  if (input.existingAreas.length > 0) prompt += `\n\nAreas already in the plan: ${input.existingAreas.join(', ')}`;
  return prompt;
}

/** The model's reply as up to three clean questions; anything malformed is dropped. */
export function sanitizePlanQuestions(value: unknown): string[] {
  const list = (value as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const q of list) {
    if (typeof q !== 'string') continue;
    const text = q.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (text && !out.includes(text)) out.push(text);
    if (out.length === MAX_PLAN_QUESTIONS) break;
  }
  return out;
}

/** The prose the plan is drafted from: the description plus the answered questions. */
export function proseWithAnswers(prose: string, answers: Array<{ question: string; answer: string }>): string {
  const answered = answers.filter((a) => a.answer.trim());
  if (answered.length === 0) return prose.trim();
  return `${prose.trim()}\n\nAnswers to planning questions:\n${answered.map((a) => `- ${a.question} ${a.answer.trim()}`).join('\n')}`;
}
