import { describe, it, expect } from 'vitest';
import {
  autoCheckable,
  namedTickets,
  staleCheckable,
  blockerAnswerAction,
  blockerAskNodeId,
  blockerFleetAction,
  briefAnswerAction,
  briefAskNodeId,
  buildBlockerAsk,
  buildBriefAsk,
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

  it('the automatic check takes only a fleet worker\'s give-up', () => {
    const w = 'Fleet worker h:slot1:fleet-worker: ';
    const ask = (blockedReason: string | null, claimedBySession: string | null = null) => buildBlockerAsk({ id: 'n', text: 'x', blockedReason, claimedBySession }, 'm');
    expect(autoCheckable(ask(`${w}the agent ran past 60 min and was stopped. Partial work: branch b in /w.`))).toBe(true);
    expect(autoCheckable(ask(`${w}the agent finished without changing anything.`))).toBe(true);
    // a person's blocker, a Stop, a hold
    expect(autoCheckable(ask('Waiting for the vendor'))).toBe(false);
    expect(autoCheckable(ask(null))).toBe(false);
    // the worker's notes on its PR, and its agent's question
    expect(autoCheckable(ask(`${w}CI failed on PR #9 (abc).`))).toBe(false);
    expect(autoCheckable(ask(`${w}PR #9 came from a ticket approved for a PR only. Review it and merge it by hand.`))).toBe(false);
    expect(autoCheckable(ask(`${w}PR #9 was closed without merging.`))).toBe(false);
    expect(autoCheckable(ask(`${w}needs a decision: which API version?`))).toBe(false);
    // an operator's fleet-worker stop on the host; a restart's interruption is a give-up
    expect(autoCheckable(ask(`${w}rethinking it. Partial work: branch b in /w. Clear the blocker to requeue it.`))).toBe(false);
    expect(autoCheckable(ask(`${w}interrupted — the worker stopped mid-ticket. Partial work: branch b. Clear the blocker to requeue it.`))).toBe(true);
    // still claimed: a worker holds it
    expect(autoCheckable(ask(`${w}the agent exited with 1.`, 'h:slot1:fleet-worker'))).toBe(false);
  });

  it('a stale check: a fleet give-up or its agent\'s question, never a person\'s blocker or a PR note; it names its tickets', () => {
    const w = 'Fleet worker h:slot2:fleet-worker: ';
    const ask = (blockedReason: string, claimedBySession: string | null = null) => buildBlockerAsk({ id: 'n', text: 'x', blockedReason, claimedBySession }, 'm');
    const question = ask(`${w}needs a decision: #492 is merged (a39fd60). #494 (approve) is still open; PR #590 is a draft. #494 first.`);
    expect(staleCheckable(question)).toBe(true);
    expect(namedTickets(question)).toEqual([492, 494]);
    expect(namedTickets({ question: 'see claude-fleet#95, PRs #590, o/r#7; waits for #12.' })).toEqual([12]);
    expect(staleCheckable(ask(`${w}the agent exited with 1.`))).toBe(true);
    expect(staleCheckable(ask('Waiting for #494'))).toBe(false);
    expect(staleCheckable(ask(`${w}CI failed on PR #9 (abc).`))).toBe(false);
    expect(staleCheckable(ask(`${w}needs a decision: wait for #494?`, 'h:slot2:fleet-worker'))).toBe(false);
  });

  it('Unblocked clears, Done finishes, text is a person\'s next step', () => {
    expect(blockerAnswerAction('Unblocked')).toBe('clear-blocker');
    expect(blockerAnswerAction('Done')).toBe('mark-done');
    expect(blockerAnswerAction('bump webpki on main first')).toBe('needs-human');
    expect(derivedAnswerPreview({ id: 'blocker-n1' }, 'Unblocked')?.[0]).toMatch(/blocker cleared/);
  });
});

describe('a ticket that needs a brief (28.10.2026)', () => {
  it('is a person\'s step: its own id, Done or free text, the text becomes the description', () => {
    const ask = buildBriefAsk({ id: 'n1', text: 'Show durations', priority: 'P2' }, 'm1');
    expect(ask).toMatchObject({ id: 'brief-n1', title: 'Show durations', options: ['Done'], priority: 'P2', unblocks: { node_id: 'n1', node_status: 'needs a brief' } });
    expect(ask.question).toMatch(/^Needs a brief: /);
    expect(briefAskNodeId('brief-n1')).toBe('n1');
    expect(derivedAskNodeId('brief-n1')).toBe('n1');
    expect(isDerivedAsk(ask)).toBe(true);
    expect(isPersonStepAsk(ask)).toBe(true);
    expect(briefAnswerAction('Done')).toBe('mark-done');
    expect(briefAnswerAction('Add a duration column')).toBe('write-brief');
    expect(derivedAnswerPreview(ask, 'Add a duration column')?.[0]).toBe('Node: "Add a duration column" becomes the description — the fleet takes it on its next pull');
  });
});
