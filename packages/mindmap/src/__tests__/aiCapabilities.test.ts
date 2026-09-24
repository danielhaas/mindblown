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
  invalidateAiCapabilities,
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

  it('caches per map: a none map and the workspace answer do not bleed into each other (#375)', async () => {
    const NONE = { enabled: false, chat: false, structured: false, embeddings: false, triage: false };
    aiConfigMock.mockImplementation(async (mapId?: string) => ({
      capabilities: mapId === 'private' ? NONE : ALL_ON,
    }));
    expect(await loadAiCapabilities('private')).toEqual(NONE);
    expect(await loadAiCapabilities('other')).toEqual(ALL_ON);
    expect(await loadAiCapabilities()).toEqual(ALL_ON);
    expect(aiConfigMock).toHaveBeenCalledTimes(3);
    expect(aiConfigMock).toHaveBeenCalledWith('private');
    expect(aiConfigMock).toHaveBeenCalledWith(undefined);
    expect(currentAiCapabilities('private')).toEqual(NONE);
    expect(currentAiCapabilities('other')).toEqual(ALL_ON);
  });

  it('invalidate re-fetches one map after its policy changed', async () => {
    aiConfigMock.mockResolvedValueOnce({ capabilities: ALL_ON });
    expect(await loadAiCapabilities('m')).toEqual(ALL_ON);
    aiConfigMock.mockResolvedValueOnce({ capabilities: { enabled: false } });
    expect(await invalidateAiCapabilities('m')).toEqual(NO_AI_CAPABILITIES);
    expect(currentAiCapabilities('m')).toEqual(NO_AI_CAPABILITIES);
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
