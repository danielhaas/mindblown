import { afterEach, describe, expect, it } from 'vitest';
import { isOutsideAuthor, keepIngestHold, ownerOfExternalId, withIngestHold } from '../forgeTrust.js';

const stranger = { user: { login: 'stranger' } };

afterEach(() => {
  delete process.env.FORGE_TRUSTED_LOGINS;
});

describe('forgeTrust (#489)', () => {
  it('trusts the repo owner and allowlisted logins, ignoring case', () => {
    process.env.FORGE_TRUSTED_LOGINS = ' Bot[bot] ,fleet';
    expect(isOutsideAuthor({ user: { login: 'Dan' } }, 'dan')).toBe(false);
    expect(isOutsideAuthor({ user: { login: 'bot[BOT]' } }, 'dan')).toBe(false);
    expect(isOutsideAuthor({ user: { login: 'FLEET' } }, 'dan')).toBe(false);
    expect(isOutsideAuthor(stranger, 'dan')).toBe(true);
  });

  it('an org owner never matches an author — its members need the allowlist', () => {
    expect(isOutsideAuthor({ user: { login: 'dan' } }, 'SomeOrg')).toBe(true);
  });

  it('an issue without an author login counts as trusted', () => {
    expect(isOutsideAuthor({}, 'dan')).toBe(false);
    expect(isOutsideAuthor({ user: null }, 'dan')).toBe(false);
  });

  it('withIngestHold adds the tag once, only for outsiders', () => {
    expect(withIngestHold(['bug'], stranger, 'dan')).toEqual(['bug', 'needs-human']);
    expect(withIngestHold(['Needs-Human'], stranger, 'dan')).toEqual(['Needs-Human']);
    expect(withIngestHold(['bug'], { user: { login: 'dan' } }, 'dan')).toEqual(['bug']);
  });

  it('keepIngestHold keeps an existing hold for outsiders and never adds one', () => {
    expect(keepIngestHold(['needs-human'], ['x'], stranger, 'dan')).toEqual(['x', 'needs-human']);
    expect(keepIngestHold(['x'], ['x'], stranger, 'dan')).toEqual(['x']);
    expect(keepIngestHold(['needs-human'], ['x'], { user: { login: 'dan' } }, 'dan')).toEqual(['x']);
  });

  it('ownerOfExternalId reads the owner of owner/repo#N', () => {
    expect(ownerOfExternalId('dan/Sonarpipe#963')).toBe('dan');
  });
});
