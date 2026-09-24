/**
 * Client-side AI capability loader (#364).
 *
 * The loader is what every AI affordance keys on, so the contract is
 * narrow but load-bearing: all-false until known, one shared request,
 * failures (e.g. 401 before login) not cached, malformed payloads
 * normalised to booleans.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const aiConfigMock = vi.fn();
vi.mock('../api.js', () => ({
  aiConfig: (...args: unknown[]) => aiConfigMock(...args),
}));

import {
  loadAiCapabilities,
  currentAiCapabilities,
  resetAiCapabilities,
  NO_AI_CAPABILITIES,
} from '../aiCapabilities.js';

const ALL_ON = { enabled: true, chat: true, structured: true, embeddings: true, triage: true };

beforeEach(() => {
  resetAiCapabilities();
  aiConfigMock.mockReset();
});

describe('loadAiCapabilities', () => {
  it('reads all-false before anything is loaded', () => {
    expect(currentAiCapabilities()).toEqual(NO_AI_CAPABILITIES);
  });

  it('shares one request between concurrent callers and caches the answer', async () => {
    aiConfigMock.mockResolvedValue({ capabilities: ALL_ON });
    const [a, b] = await Promise.all([loadAiCapabilities(), loadAiCapabilities()]);
    expect(a).toEqual(ALL_ON);
    expect(b).toEqual(ALL_ON);
    await loadAiCapabilities();
    expect(aiConfigMock).toHaveBeenCalledTimes(1);
    expect(currentAiCapabilities()).toEqual(ALL_ON);
  });

  it('does not cache a failed fetch — the next call retries', async () => {
    aiConfigMock.mockRejectedValueOnce(new Error('401'));
    expect(await loadAiCapabilities()).toEqual(NO_AI_CAPABILITIES);
    expect(currentAiCapabilities()).toEqual(NO_AI_CAPABILITIES);

    aiConfigMock.mockResolvedValueOnce({ capabilities: ALL_ON });
    expect(await loadAiCapabilities()).toEqual(ALL_ON);
    expect(aiConfigMock).toHaveBeenCalledTimes(2);
  });

  it('normalises a partial or missing capabilities block to booleans', async () => {
    aiConfigMock.mockResolvedValueOnce({ capabilities: { chat: true, structured: 'yes' } });
    expect(await loadAiCapabilities()).toEqual({
      enabled: false,
      chat: true,
      structured: false,
      embeddings: false,
      triage: false,
    });

    resetAiCapabilities();
    aiConfigMock.mockResolvedValueOnce({ enabled: true });
    expect(await loadAiCapabilities()).toEqual(NO_AI_CAPABILITIES);
  });
});
