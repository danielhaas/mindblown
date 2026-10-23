import { describe, it, expect } from 'vitest';
import { repoDescription } from '../repoDescription.js';

describe('repoDescription', () => {
  it('turns line breaks, tabs and other control characters into single spaces', () => {
    expect(repoDescription('An online shop.\nDone = first order.\r\n\tPaid\u0007online.')).toBe('An online shop. Done = first order. Paid online.');
  });

  it('also flattens C1 controls and Unicode line/paragraph separators', () => {
    expect(repoDescription('a\u0085b\u2028c\u2029d')).toBe('a b c d');
  });

  it('never cuts an emoji in half at the cap', () => {
    const cut = repoDescription(`${'x'.repeat(349)}😀😀`)!;
    expect(Array.from(cut)).toHaveLength(350);
    expect(cut.endsWith('😀')).toBe(true);
    expect(cut.isWellFormed()).toBe(true);
  });

  it('caps at 350 characters and drops empty or non-string input', () => {
    expect(repoDescription('x'.repeat(400))).toHaveLength(350);
    expect(repoDescription(' \n ')).toBeUndefined();
    expect(repoDescription(42)).toBeUndefined();
    expect(repoDescription(undefined)).toBeUndefined();
  });
});
