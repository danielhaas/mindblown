/**
 * Presentation rules for GitHub link chips in the requirements table.
 *
 * Kept out of RequirementsView.tsx so it can be unit-tested without
 * dragging in the zustand store, which the component module creates at
 * import time.
 */

/**
 * Colour for one GitHub link chip.
 *
 * Four states over two axes, all at full opacity so every one stays
 * readable:
 *
 *              own          inherited
 *   open       #2563eb      #60a5fa     ← blue family, the live work
 *   closed     #64748b      #94a3b8     ← slate family, done
 *   unknown    treated as open (we don't know it's closed, so don't
 *              claim it is)
 *
 * Blue vs slate reads as open vs closed at a glance; the lighter shade
 * within each family reads as "this issue hangs off work below the
 * requirement, not on the requirement itself".
 *
 * Opacity used to carry the closed signal, back when the `state` field
 * was almost never written and so nothing actually dimmed. Once it was
 * populated, ~90% of links turned out to be closed — dimming became the
 * default, and stacked with the pale inherited blue it produced a tier
 * that was effectively invisible. Marking the majority is backwards, so
 * open now gets the colour and the weight.
 */
export function linkColor(state: 'open' | 'closed' | undefined, inherited: boolean): string {
  if (state === 'closed') return inherited ? '#94a3b8' : '#64748b';
  return inherited ? '#60a5fa' : '#2563eb';
}

/** Open issues carry the emphasis; closed ones sit back at normal weight. */
export function linkWeight(state: 'open' | 'closed' | undefined): number {
  return state === 'closed' ? 400 : 600;
}
