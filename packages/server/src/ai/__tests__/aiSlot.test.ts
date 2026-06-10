/**
 * Bug 4b82ef4f — ai_estimate 502s under parallel Ollama load.
 *
 * commit 0401941 added a chatCompletion/embed semaphore (AI_MAX_CONCURRENCY,
 * default 1) so concurrent JSON-mode calls queue instead of fanning out onto
 * Ollama's single inference slot. But the conversational chat path
 * (`ollamaProvider.runTurn`) called `client.chat.completions.create`
 * directly and bypassed the slot — so a chat turn racing an ai_estimate
 * still 502'd. These tests pin the slot to both call paths.
 */

import { describe, it, expect } from 'vitest';
import { withAiSlot } from '../client.js';

describe('withAiSlot', () => {
  it('serializes concurrent acquirers (default AI_MAX_CONCURRENCY=1)', async () => {
    // Track maximum concurrent in-flight callers — if the slot works it
    // never exceeds 1 (the default cap).
    let inFlight = 0;
    let peak = 0;

    const work = (label: string) =>
      withAiSlot(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Yield to the event loop a few times so siblings get a real
        // chance to interleave if the slot weren't enforced.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        inFlight -= 1;
        return label;
      });

    const results = await Promise.all([work('a'), work('b'), work('c'), work('d')]);

    expect(results).toEqual(['a', 'b', 'c', 'd']);
    expect(peak).toBe(1);
  });

  it('releases the slot when the wrapped fn throws', async () => {
    // If release() weren't in finally, a thrown task would leak the slot
    // and subsequent acquirers would hang forever.
    await expect(
      withAiSlot(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // This second call must complete — proves the slot was released.
    const out = await withAiSlot(async () => 'ok');
    expect(out).toBe('ok');
  });
});
