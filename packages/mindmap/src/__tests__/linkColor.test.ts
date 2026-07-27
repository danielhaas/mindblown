import { describe, it, expect } from 'vitest';
import { linkColor } from '../ghLinkStyle.js';

/**
 * The GitHub column encodes two things at once: whether the issue is
 * still open, and whether it's linked on the requirement itself or on
 * work beneath it.
 *
 * These used to be colour and opacity respectively. That broke once the
 * `state` field was actually populated: ~90% of links turned out to be
 * closed, so the dimmed branch became the default, and dimming stacked
 * on the pale inherited blue produced a tier that was effectively
 * invisible. Both signals now live in colour, at full opacity.
 */
describe('linkColor', () => {
  it('separates open from closed by colour family', () => {
    // Blue = live work, slate = done. Distinct families, not shades of
    // one — this is the distinction the reader scans for first.
    expect(linkColor('open', false)).toBe('#2563eb');
    expect(linkColor('closed', false)).toBe('#64748b');
    expect(linkColor('open', false)).not.toBe(linkColor('closed', false));
  });

  it('separates own from inherited within each family', () => {
    expect(linkColor('open', true)).toBe('#60a5fa');
    expect(linkColor('closed', true)).toBe('#94a3b8');
    expect(linkColor('open', true)).not.toBe(linkColor('open', false));
    expect(linkColor('closed', true)).not.toBe(linkColor('closed', false));
  });

  it('never repeats a colour across the four states', () => {
    const all = [
      linkColor('open', false),
      linkColor('open', true),
      linkColor('closed', false),
      linkColor('closed', true),
    ];
    expect(new Set(all).size).toBe(4);
  });

  it('treats unknown state as open rather than claiming closed', () => {
    // A link written before `state` existed, or one the resolver hasn't
    // reached, must not be rendered as done work — same rule the old
    // dimming followed.
    expect(linkColor(undefined, false)).toBe(linkColor('open', false));
    expect(linkColor(undefined, true)).toBe(linkColor('open', true));
  });
});
