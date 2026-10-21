import { describe, it, expect } from 'vitest';
import { questionParts } from '../asks.js';

describe('questionParts', () => {
  it('splits inline "(1) … (2) …" into a lead and items (the Navy mobile-login question)', () => {
    const q =
      "Switching the redirect needs your call on four things. (1) The path: /auth/* goes to Keycloak, so e.g. /app/auth/callback. (2) Android: is the release fingerprint set? (3) iOS: keep navy:// or add Universal Links? (4) Keycloak: someone adds the redirect URI. Please confirm.";
    expect(questionParts(q)).toEqual({
      lead: 'Switching the redirect needs your call on four things.',
      items: [
        'The path: /auth/* goes to Keycloak, so e.g. /app/auth/callback.',
        'Android: is the release fingerprint set?',
        'iOS: keep navy:// or add Universal Links?',
        'Keycloak: someone adds the redirect URI. Please confirm.',
      ],
      tail: '',
    });
  });

  it('splits numbered or bulleted lines, keeps wrapped lines with their item and the text after the list', () => {
    const q = 'PKCE is enforced. Two things need you:\n1. Narrow the matcher\n   to the console pages?\n2) Which username for the admin?\nI would start with a temporary password.';
    expect(questionParts(q)).toEqual({
      lead: 'PKCE is enforced. Two things need you:',
      items: ['Narrow the matcher to the console pages?', 'Which username for the admin?'],
      tail: 'I would start with a temporary password.',
    });
    expect(questionParts('Pick one:\n- Exoscale\n- Hetzner').items).toEqual(['Exoscale', 'Hetzner']);
  });

  it('leaves a plain paragraph, one stray "(2)" or "(3 tickets)" alone', () => {
    expect(questionParts('Should I hold #494 until #492 lands?')).toEqual({ lead: 'Should I hold #494 until #492 lands?', items: [], tail: '' });
    expect(questionParts('See step (2) of the runbook and (3 tickets) below.').items).toEqual([]);
    expect(questionParts('Only (1) one thing.').items).toEqual([]);
  });
});
