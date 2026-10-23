import { describe, it, expect } from 'vitest';
import { repoDescription } from '../repoDescription.js';

describe('repoDescription', () => {
  it('turns line breaks, tabs and other control characters into single spaces', () => {
    expect(repoDescription('An online shop.\nDone = first order.\r\n\tPaid\u0007online.')).toBe('An online shop. Done = first order. Paid online.');
  });

  it('caps at 350 characters and drops empty or non-string input', () => {
    expect(repoDescription('x'.repeat(400))).toHaveLength(350);
    expect(repoDescription(' \n ')).toBeUndefined();
    expect(repoDescription(42)).toBeUndefined();
    expect(repoDescription(undefined)).toBeUndefined();
  });
});
