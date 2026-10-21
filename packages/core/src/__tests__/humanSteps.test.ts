import { describe, it, expect } from 'vitest';
import { buildStepAsk, derivedAnswerPreview, isDerivedAsk, nextStepOf, stepAnswerAction, stepAskNodeId } from '../humanSteps.js';

describe('a person\'s steps', () => {
  it('read the next step from a markdown or rich-text description', () => {
    expect(nextStepOf('**Next step (a person): check on a real phone**\n\nInter everywhere.')).toBe('check on a real phone');
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Next step (a person): upload the AAB' }] }] };
    expect(nextStepOf(doc)).toBe('upload the AAB');
    expect(nextStepOf('Just a description')).toBeNull();
    expect(nextStepOf(null)).toBeNull();
  });

  it('a step row names the node, its tag and its next step; Done / Fleet can do it', () => {
    const ask = buildStepAsk(
      { id: 'n1', text: 'Typeface', tags: ['ui', 'needs-human'], description: '**Next step (a person): check on a real phone**', priority: 'P3', percentComplete: 40 },
      'map-1',
    );
    expect(ask).toMatchObject({
      id: 'step-n1',
      map_id: 'map-1',
      hint: 'ops-task',
      answerer: 'Dan',
      options: ['Done', 'Fleet can do it'],
      question: 'Next step: check on a real phone',
      unblocks: { node_id: 'n1', node_status: 'needs-human · 40 %' },
    });
    expect(buildStepAsk({ id: 'n2', text: 'x', tags: ['kira-skip'] }, 'm').question).toBe('Tagged kira-skip — the fleet leaves it to a person. Open the node for what is left.');
    expect(stepAskNodeId('step-n1')).toBe('n1');
    expect(stepAskNodeId('#12')).toBeNull();
  });

  it('answers map to fixes; free text is the new next step', () => {
    expect(stepAnswerAction('Done')).toBe('mark-done');
    expect(stepAnswerAction('Fleet can do it')).toBe('to-fleet');
    expect(stepAnswerAction('waiting for the key from Thomas')).toBe('needs-human');
  });

  it('derived rows preview their own writes; collector rows are not derived', () => {
    expect(isDerivedAsk({ id: 'stalled-n1' })).toBe(true);
    expect(isDerivedAsk({ id: 'step-n1' })).toBe(true);
    expect(isDerivedAsk({ id: 'fleet-50c69fc2' })).toBe(false);
    expect(derivedAnswerPreview({ id: 'step-n1' }, 'Fleet can do it')?.[0]).toMatch(/back to the queue/);
    expect(derivedAnswerPreview({ id: 'step-n1' }, 'ask Thomas')?.[0]).toBe('Node: "Next step (a person): ask Thomas" at the top of the description — the step stays yours');
    expect(derivedAnswerPreview({ id: 'stalled-n1' }, 'Back to the queue')?.[0]).toMatch(/progress kept/);
    expect(derivedAnswerPreview({ id: 'stalled-n1' }, 'For a person')?.[0]).toMatch(/Your steps/);
    expect(derivedAnswerPreview({ id: 'fleet-1' }, 'Done')).toBeNull();
  });
});
