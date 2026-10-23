import { describe, it, expect } from 'vitest';
import { sanitizePlanQuestions, proseWithAnswers, planQuestionsUserPrompt, PLAN_QUESTIONS_SYSTEM_PROMPT } from '../planQuestions.js';

describe('sanitizePlanQuestions', () => {
  it('keeps up to three clean questions, dropping numbering, duplicates and junk', () => {
    expect(
      sanitizePlanQuestions({
        questions: ['1. Who uses it?', '- What must the first version do?', 42, '', 'Who uses it?', 'Any deadline?', 'A fourth one?'],
      }),
    ).toEqual(['Who uses it?', 'What must the first version do?', 'Any deadline?']);
  });

  it('reads anything else as no questions', () => {
    expect(sanitizePlanQuestions(null)).toEqual([]);
    expect(sanitizePlanQuestions({ questions: 'Who?' })).toEqual([]);
    expect(sanitizePlanQuestions({ questions: [] })).toEqual([]);
  });
});

describe('proseWithAnswers', () => {
  it('appends the answered questions; blank answers are left out', () => {
    expect(
      proseWithAnswers('A bakery shop.', [
        { question: 'Who uses it?', answer: ' Customers and the baker. ' },
        { question: 'Any deadline?', answer: '  ' },
      ]),
    ).toBe('A bakery shop.\n\nAnswers to planning questions:\n- Who uses it? Customers and the baker.');
  });

  it('is the prose alone without answers', () => {
    expect(proseWithAnswers(' A bakery shop. ', [])).toBe('A bakery shop.');
  });
});

describe('planQuestionsUserPrompt', () => {
  it('names the project, the description and the areas already planned', () => {
    const prompt = planQuestionsUserPrompt({ projectName: 'Shop', prose: 'Bread online.', existingAreas: ['Ordering'] });
    expect(prompt).toContain('Project: Shop');
    expect(prompt).toContain('Bread online.');
    expect(prompt).toContain('Areas already in the plan: Ordering');
    expect(PLAN_QUESTIONS_SYSTEM_PROMPT).toContain('{"questions"');
  });
});
