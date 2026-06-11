/**
 * Unit coverage for the pure tag-merge helper backing
 * updateNode's `tagsAppend` / `tagsRemove` modes. Jenna's
 * 2026-06-11 housekeeping digest flagged that the previous
 * single-mode (`tags`) overwrite path was silently losing
 * unrelated tags during multi-sweep tagging passes — this
 * helper is the math that lets callers add or strip specific
 * tags without round-tripping a read first.
 */
import { describe, it, expect } from 'vitest';
import { mergeTags } from '../nodes.js';

describe('mergeTags', () => {
  it('returns the current set unchanged when neither append nor remove is given', () => {
    expect(mergeTags(['STATUS-UNSET', 'NEEDS-PRIORITY'], undefined, undefined))
      .toEqual(['STATUS-UNSET', 'NEEDS-PRIORITY']);
  });

  it('appends new tags after the existing ones, preserving order', () => {
    expect(mergeTags(['STATUS-UNSET'], ['SCOPE-REVIEW'], undefined))
      .toEqual(['STATUS-UNSET', 'SCOPE-REVIEW']);
  });

  it('dedups against the current set when appending', () => {
    expect(mergeTags(['STATUS-UNSET', 'NEEDS-PRIORITY'], ['STATUS-UNSET', 'NEEDS-VERSION'], undefined))
      .toEqual(['STATUS-UNSET', 'NEEDS-PRIORITY', 'NEEDS-VERSION']);
  });

  it('removes named tags and leaves the rest in order', () => {
    expect(mergeTags(['STATUS-UNSET', 'NEEDS-PRIORITY', 'SCOPE-REVIEW'], undefined, ['NEEDS-PRIORITY']))
      .toEqual(['STATUS-UNSET', 'SCOPE-REVIEW']);
  });

  it('treats remove of a non-present tag as a no-op', () => {
    expect(mergeTags(['STATUS-UNSET'], undefined, ['NEEDS-PRIORITY']))
      .toEqual(['STATUS-UNSET']);
  });

  it('applies remove before append so swap-style updates work', () => {
    expect(mergeTags(['STATUS-UNSET', 'NEEDS-PRIORITY'], ['NEEDS-VERSION'], ['NEEDS-PRIORITY']))
      .toEqual(['STATUS-UNSET', 'NEEDS-VERSION']);
  });

  it('lets append win when the same tag is in both lists (re-add semantics)', () => {
    expect(mergeTags(['STATUS-UNSET'], ['STATUS-UNSET'], ['STATUS-UNSET']))
      .toEqual(['STATUS-UNSET']);
  });

  it('handles an empty current set', () => {
    expect(mergeTags([], ['NEW'], undefined)).toEqual(['NEW']);
    expect(mergeTags([], undefined, ['X'])).toEqual([]);
  });
});
