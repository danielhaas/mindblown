/**
 * Tests for the `^#NNNN` create_node / update_node auto-link backstop (#58).
 *
 * The full end-to-end flow (DB write + GitHub API lookup) is tested
 * implicitly by the existing route integration tests; here we lock down the
 * pure title-parsing pattern, which is the only knob that determines
 * whether autolink fires at all.
 *
 * Spec edge cases covered:
 *   - leading `#NNNN` followed by whitespace → matches
 *   - leading `#NNNN` followed by end-of-string → matches
 *   - `#NNNN #MMMM` → first only (regex anchored, captures only the first)
 *   - `#NNNN ... PR #MMMM` → leading wins, PR ref ignored
 *   - mid-title `#NNNN` (not anchored) → no match
 */

import { describe, it, expect } from 'vitest';
import { extractAutoLinkIssueNumber } from '../nodes.js';

describe('extractAutoLinkIssueNumber', () => {
  it('matches leading `#NNNN ` (with space)', () => {
    expect(extractAutoLinkIssueNumber('#937 Fix resolve_workflow_assignees crash'))
      .toBe(937);
  });

  it('matches bare `#NNNN` (no trailing content)', () => {
    expect(extractAutoLinkIssueNumber('#42')).toBe(42);
  });

  it('extracts first reference when multiple appear', () => {
    expect(extractAutoLinkIssueNumber('#856 GIIN config - PR #845')).toBe(856);
    expect(extractAutoLinkIssueNumber('#937 #1042 multi-ref'))
      .toBe(937);
  });

  it('does NOT match mid-title `#NNNN`', () => {
    expect(extractAutoLinkIssueNumber('Closes #42 in passing')).toBeNull();
    expect(extractAutoLinkIssueNumber('Bug fix for #100')).toBeNull();
  });

  it('does NOT match when no `#` at all', () => {
    expect(extractAutoLinkIssueNumber('Plain title')).toBeNull();
    expect(extractAutoLinkIssueNumber('')).toBeNull();
  });

  it('does NOT match `#NNNN` glued to other chars (no boundary)', () => {
    // The spec requires `^#NNNN(?:\s|$)`. Without a space/end after the
    // number, it's likely something else: an anchor link, a code ref, etc.
    expect(extractAutoLinkIssueNumber('#42foo')).toBeNull();
    expect(extractAutoLinkIssueNumber('#42-followup')).toBeNull();
  });

  it('does NOT match `# NNNN` (space between)', () => {
    expect(extractAutoLinkIssueNumber('# 42 plain')).toBeNull();
  });

  it('matches with a trailing tab or newline as whitespace', () => {
    expect(extractAutoLinkIssueNumber('#42\twith tab')).toBe(42);
    expect(extractAutoLinkIssueNumber('#42\nnewline')).toBe(42);
  });
});
