/**
 * Tests for `runCanary` — the weekly synthetic alarm-chain probe.
 *
 * We mock `pushKumaHeartbeat` directly (rather than `global.fetch` as
 * `kumaPush.test.ts` does) because we're testing the orchestration
 * around it: URL-is-unset = no fetch, both pushes fire with the right
 * (status, msg, tag), and the ack still fires even if the down push
 * throws. `pushKumaHeartbeat`'s own swallow-fetch-error behaviour has
 * its own test file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const pushKumaHeartbeatMock = vi.fn(
  async (
    _url: string | undefined,
    _status: 'up' | 'down',
    _msg: string,
    _tag: string,
  ): Promise<void> => undefined,
);

vi.mock('../kumaPush.js', () => ({
  pushKumaHeartbeat: pushKumaHeartbeatMock,
}));

// Import AFTER the mock so the SUT picks up the mocked helper.
const { runCanary } = await import('../canary.js');

describe('runCanary', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    pushKumaHeartbeatMock.mockReset();
    pushKumaHeartbeatMock.mockResolvedValue(undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('does NOT call pushKumaHeartbeat when the URL is undefined', async () => {
    await runCanary(undefined, 0);
    expect(pushKumaHeartbeatMock).not.toHaveBeenCalled();
  });

  it('does NOT call pushKumaHeartbeat when the URL is empty', async () => {
    await runCanary('', 0);
    expect(pushKumaHeartbeatMock).not.toHaveBeenCalled();
  });

  it('fires down then up with the correct status, msg, and tag', async () => {
    const url = 'https://kuma.example.com/api/push/canary-token';
    await runCanary(url, 0);

    expect(pushKumaHeartbeatMock).toHaveBeenCalledTimes(2);

    const [downCall, upCall] = pushKumaHeartbeatMock.mock.calls;

    // First push: status=down, synthetic-test msg, canary down tag.
    expect(downCall[0]).toBe(url);
    expect(downCall[1]).toBe('down');
    expect(downCall[2]).toBe('synthetic-test');
    expect(downCall[3]).toContain('canary');

    // Second push: status=up, synthetic-test-ack msg, canary ack tag.
    expect(upCall[0]).toBe(url);
    expect(upCall[1]).toBe('up');
    expect(upCall[2]).toBe('synthetic-test-ack');
    expect(upCall[3]).toContain('canary');
  });

  it('fires the ack push even when the down push throws', async () => {
    // First call (down) throws synchronously; second (up) resolves.
    pushKumaHeartbeatMock
      .mockRejectedValueOnce(new Error('down-fail'))
      .mockResolvedValueOnce(undefined);

    const url = 'https://kuma.example.com/api/push/canary-token';
    await expect(runCanary(url, 0)).resolves.toBeUndefined();

    // Both calls must have happened: ack MUST fire even on down failure.
    expect(pushKumaHeartbeatMock).toHaveBeenCalledTimes(2);
    expect(pushKumaHeartbeatMock.mock.calls[0][1]).toBe('down');
    expect(pushKumaHeartbeatMock.mock.calls[1][1]).toBe('up');

    // And we warn-logged the failure (defence-in-depth catch).
    expect(warnSpy).toHaveBeenCalled();
    const warnArgs = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warnArgs).toContain('canary');
    expect(warnArgs).toContain('down-fail');
  });

  it('still resolves cleanly when the ack push throws', async () => {
    // Down resolves; ack throws — we don't want runCanary to reject.
    pushKumaHeartbeatMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('ack-fail'));

    const url = 'https://kuma.example.com/api/push/canary-token';
    await expect(runCanary(url, 0)).resolves.toBeUndefined();

    expect(pushKumaHeartbeatMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();
    const warnArgs = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warnArgs).toContain('ack-fail');
  });

  it('reads URL from process.env.KUMA_ALARM_CANARY_PUSH_URL when no arg is passed', async () => {
    const original = process.env.KUMA_ALARM_CANARY_PUSH_URL;
    process.env.KUMA_ALARM_CANARY_PUSH_URL = 'https://kuma.example.com/api/push/from-env';
    try {
      // Call with default arg = read from env.
      await runCanary(undefined, 0);
    } finally {
      if (original === undefined) delete process.env.KUMA_ALARM_CANARY_PUSH_URL;
      else process.env.KUMA_ALARM_CANARY_PUSH_URL = original;
    }
    // Default-arg evaluation happens at call time only when arg is
    // *omitted*; passing `undefined` explicitly still uses the default,
    // so we expect a call with the env URL.
    expect(pushKumaHeartbeatMock).toHaveBeenCalledTimes(2);
    expect(pushKumaHeartbeatMock.mock.calls[0][0]).toBe(
      'https://kuma.example.com/api/push/from-env',
    );
  });
});
