/**
 * proseMirrorToPlainText — moved here from packages/server (mapContext)
 * so packages/integrations can render GitHub issue bodies with the same
 * walk. The server re-exports it; these tests pin the core behavior.
 */

import { describe, it, expect } from 'vitest';
import { proseMirrorToPlainText } from '../richtext.js';

describe('proseMirrorToPlainText', () => {
  it('returns empty string for null/undefined/non-objects', () => {
    expect(proseMirrorToPlainText(null)).toBe('');
    expect(proseMirrorToPlainText(undefined)).toBe('');
    expect(proseMirrorToPlainText(42)).toBe('');
  });

  it('passes legacy string descriptions through unchanged', () => {
    expect(proseMirrorToPlainText('hello')).toBe('hello');
  });

  it('joins paragraphs with newlines', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First line' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second line' }] },
      ],
    };
    expect(proseMirrorToPlainText(doc)).toBe('First line\nSecond line');
  });

  it('walks nested list structures', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'item one' }] },
              ],
            },
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'item two' }] },
              ],
            },
          ],
        },
      ],
    };
    const out = proseMirrorToPlainText(doc);
    expect(out).toContain('item one');
    expect(out).toContain('item two');
    // Never leaks JSON syntax into the rendering.
    expect(out).not.toContain('{');
  });
});
