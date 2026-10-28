import { describe, it, expect } from 'vitest';
import {
  autoCheckable,
  blockerAnswerAction,
  blockerAskNodeId,
  blockerFleetAction,
  buildBlockerAsk,
  buildStepAsk,
  derivedAnswerPreview,
  derivedAskNodeId,
  isDerivedAsk,
  isPersonStepAsk,
  nextStepOf,
  stepAnswerAction,
  stepAskNodeId,
  stepParts,
  stepSummaryOf,
} from '../humanSteps.js';

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

describe('a blocker as a step (Sonarpipe, 22.10.2026)', () => {
  const reason = 'Fleet worker big-blower:slot1:fleet-worker: CI failed on PR #995 (445fab60). Fix the branch or close the PR; it merges by itself once CI is green.';
  const pr = { provider: 'gitea', externalId: 'dan/Sonarpipe#995', url: 'https://git.example/dan/Sonarpipe/pulls/995', syncEnabled: true, lastSyncedAt: null, isPullRequest: true, state: 'open' as const };

  it('the row says the reason, links the PR and names the claim', () => {
    const ask = buildBlockerAsk({ id: 'n1', text: 'Beacon identity', blockedReason: reason, externalLinks: [pr], percentComplete: 90, claimedBySession: 'big-blower:slot1:fleet-worker' }, 'm');
    expect(ask).toMatchObject({
      id: 'blocker-n1',
      question: `Blocked: ${reason}`,
      options: ['Fleet can fix it', 'Unblocked', 'Done'],
      url: pr.url,
      sources: ['mindblown-blocker'],
      unblocks: { node_id: 'n1', node_status: 'blocked · 90 %', claimed_by: 'big-blower:slot1:fleet-worker', pr: pr.url, pr_state: 'open' },
    });
    expect(blockerAskNodeId('blocker-n1')).toBe('n1');
    expect(derivedAskNodeId('blocker-n1')).toBe('n1');
    expect(derivedAskNodeId('stalled-n2')).toBe('n2');
    expect(isDerivedAsk(ask)).toBe(true);
    expect(isPersonStepAsk(ask)).toBe(true);
    expect(isPersonStepAsk({ id: 'stalled-n1' })).toBe(false);
  });

  it('Fleet can fix it: the held PR is reworked (fleet-fix), anything else is a check run (fleet-check)', () => {
    const conflict = buildBlockerAsk({ id: 'n2', text: 'x', blockedReason: 'Fleet worker h:slot1:fleet-worker: PR #22 has merge conflicts with its base. Resolve them.', claimedBySession: 'h:slot1:fleet-worker' }, 'm');
    const vendor = buildBlockerAsk({ id: 'n3', text: 'x', blockedReason: 'Waiting for the vendor' }, 'm');
    const released = buildBlockerAsk({ id: 'n4', text: 'x', blockedReason: 'Fleet worker h:slot1:fleet-worker: CI failed on PR #9 (abc).' }, 'm');
    expect(conflict.options).toEqual(['Fleet can fix it', 'Unblocked', 'Done']);
    expect(vendor.options).toEqual(['Fleet can fix it', 'Unblocked', 'Done']);
    expect(blockerAnswerAction('Fleet can fix it')).toBe('fleet-fix');
    expect(blockerFleetAction(conflict)).toBe('fleet-fix');
    expect(blockerFleetAction(vendor)).toBe('fleet-check');
    expect(blockerFleetAction(released)).toBe('fleet-fix');
    expect(released.unblocks.pr).toBe('#9'); // no PR link: the worker's note names it // the worker follows its PR from its claim file, MindBlown's claim or not
    expect(derivedAnswerPreview(conflict, 'Fleet can fix it')?.[0]).toMatch(/tagged fleet-fix/);
    expect(derivedAnswerPreview(vendor, 'Fleet can fix it')?.[0]).toMatch(/tagged fleet-check/);
  });

  it('the automatic check takes any blocker but a fleet worker\'s own PR note', () => {
    const vendor = buildBlockerAsk({ id: 'n3', text: 'x', blockedReason: 'Waiting for the vendor' }, 'm');
    const red = buildBlockerAsk({ id: 'n4', text: 'x', blockedReason: 'Fleet worker h:slot1:fleet-worker: CI failed on PR #9 (abc).' }, 'm');
    const merge = buildBlockerAsk({ id: 'n5', text: 'x', blockedReason: 'Fleet worker h:slot1:fleet-worker: PR #9 waits for a person to merge.' }, 'm');
    const bare = buildBlockerAsk({ id: 'n6', text: 'x', blockedReason: null }, 'm');
    expect(autoCheckable(vendor)).toBe(true);
    expect(autoCheckable(bare)).toBe(true);
    expect(autoCheckable(red)).toBe(false);
    expect(autoCheckable(merge)).toBe(false);
  });

  it('Unblocked clears, Done finishes, text is a person\'s next step', () => {
    expect(blockerAnswerAction('Unblocked')).toBe('clear-blocker');
    expect(blockerAnswerAction('Done')).toBe('mark-done');
    expect(blockerAnswerAction('bump webpki on main first')).toBe('needs-human');
    expect(derivedAnswerPreview({ id: 'blocker-n1' }, 'Unblocked')?.[0]).toMatch(/blocker cleared/);
  });
});
