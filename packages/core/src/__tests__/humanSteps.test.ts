import { describe, it, expect } from 'vitest';
import { buildStepAsk, derivedAnswerPreview, isDerivedAsk, nextStepOf, stepAnswerAction, stepAskNodeId, stepParts, stepSummaryOf } from '../humanSteps.js';

describe('a step for reading', () => {
  it('without a next-step line the row shows the description\'s first paragraph, headings skipped', () => {
    expect(stepSummaryOf('## Goal\nA fleet is its own thing.\n\n## Target\nmore')).toBe('A fleet is its own thing.');
    expect(stepSummaryOf(null)).toBeNull();
    const ask = buildStepAsk({ id: 'n3', text: 'Ingress', tags: ['needs-human'], description: 'MEDIUM. Block the master realm.' }, 'm');
    expect(ask.question).toBe('MEDIUM. Block the master realm.');
  });

  it('"Left: a; b; c" is a numbered run under its lead (the Play internal-testing step)', () => {
    const t =
      'Next step: 2026-10-14: internal testing works — 0.1.1 (357) installed from Play. Left: app-signing SHA-256 into NAVY_ANDROID_CERT_SHA256; Play service account for uploads (deploy/play-upload.mjs); closed test with ≥12 testers for 14 days; deobfuscation ticket 0f956365.';
    expect(stepParts(t)).toEqual({
      lead: 'Next step: 2026-10-14: internal testing works — 0.1.1 (357) installed from Play. Left:',
      items: ['app-signing SHA-256 into NAVY_ANDROID_CERT_SHA256', 'Play service account for uploads (deploy/play-upload.mjs)', 'closed test with ≥12 testers for 14 days', 'deobfuscation ticket 0f956365'],
      tail: '',
      ordered: true,
    });
  });

  it('"a → b → c" is a numbered run, text after it stays the tail (the Garmin step)', () => {
    const t = 'Parked: the server will move. Sync needs: privacy policy online → Garmin application → approval → ~1 day build. Then ship.';
    expect(stepParts(t)).toEqual({
      lead: 'Parked: the server will move. Sync needs:',
      items: ['privacy policy online', 'Garmin application', 'approval', '~1 day build'],
      tail: 'Then ship.',
      ordered: true,
    });
  });

  it('an audit finding is bullets under its severity; e.g. and file names do not split', () => {
    const t =
      'MEDIUM (needs prior RCE in the web app). navy-web.service:37 ReadWritePaths=/opt/navy-releases, e.g. rollback.sh (rollback.sh:5) is writable. redeploy.sh reads from /opt/navy so it is fine. Fix: root-owned release dirs.';
    expect(stepParts(t)).toEqual({
      lead: 'MEDIUM (needs prior RCE in the web app).',
      items: [
        'navy-web.service:37 ReadWritePaths=/opt/navy-releases, e.g. rollback.sh (rollback.sh:5) is writable.',
        'redeploy.sh reads from /opt/navy so it is fine.',
        'Fix: root-owned release dirs.',
      ],
      tail: '',
      ordered: false,
    });
    expect(stepParts('LOW / policy. Height is health data. The team API returns it.').lead).toBe('LOW / policy.');
  });

  it('a plain paragraph, two "→" or one ";" stay one paragraph', () => {
    expect(stepParts('Needs a check on a real phone: fontWeight → Inter bold.').items).toEqual([]);
    expect(stepParts('Dry run first; then --apply.').items).toEqual([]);
    expect(stepParts('Tagged needs-human — the fleet leaves it to a person.').items).toEqual([]);
  });
});

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
