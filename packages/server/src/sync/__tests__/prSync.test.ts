import { describe, it, expect } from 'vitest';
import { parseClosesIssues } from '../prSync.js';

describe('parseClosesIssues', () => {
  it('extracts a single Closes #NNN reference', () => {
    expect(parseClosesIssues('Closes #42')).toEqual([42]);
  });

  it('extracts multiple references', () => {
    expect(parseClosesIssues('Closes #1, fixes #2, resolves #3')).toEqual([1, 2, 3]);
  });

  it('handles case-insensitive keywords (closes, CLOSES, Closes, closed)', () => {
    expect(parseClosesIssues('CLOSES #5 and Fixed #6 and resolved #7')).toEqual([5, 6, 7]);
  });

  it('ignores unrelated #N mentions', () => {
    expect(parseClosesIssues('See #99 for context, closes #100')).toEqual([100]);
  });

  it('dedupes duplicate references', () => {
    expect(parseClosesIssues('Closes #50 and resolves #50')).toEqual([50]);
  });

  it('returns [] for null/empty/no-match body', () => {
    expect(parseClosesIssues(null)).toEqual([]);
    expect(parseClosesIssues('')).toEqual([]);
    expect(parseClosesIssues('Just a description with no close refs.')).toEqual([]);
  });

  it('does not match keywords inside other words', () => {
    expect(parseClosesIssues('foreclosed #1 / unresolvable #2')).toEqual([]);
  });
});
