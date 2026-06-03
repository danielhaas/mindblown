/**
 * Tests for the webhook auth-mismatch detector (#74).
 *
 * The module keeps a 24h rolling counter of webhook calls and pushes a
 * Kuma heartbeat once a day:
 *   - down if all calls in the window failed signature verification
 *     (the silent-rotation case we're trying to catch)
 *   - up if at least one passed (healthy, or mid-rotation — don't alarm)
 *   - no push if fewer than MIN_THRESHOLD calls landed in the window
 *     (too few samples to distinguish "bad secret" from "low traffic
 *     day with one transient blip")
 *
 * We mock `pushKumaHeartbeat` directly (same pattern as canary.test.ts)
 * because we're testing the orchestration around it: which (status,
 * msg) lands for which counter state.
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
const {
  recordWebhookCall,
  runWebhookAuthCheck,
  _resetForTests,
  _getCallsForTests,
  _MIN_THRESHOLD_FOR_TESTS,
  _WINDOW_MS_FOR_TESTS,
} = await import('../webhookAuthCheck.js');

const URL = 'https://kuma.example.com/api/push/webhook-auth';

describe('webhookAuthCheck', () => {
  let originalUrl: string | undefined;

  beforeEach(() => {
    pushKumaHeartbeatMock.mockReset();
    pushKumaHeartbeatMock.mockResolvedValue(undefined);
    _resetForTests();
    originalUrl = process.env.KUMA_WEBHOOK_AUTH_FAILURE_PUSH_URL;
    process.env.KUMA_WEBHOOK_AUTH_FAILURE_PUSH_URL = URL;
  });

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.KUMA_WEBHOOK_AUTH_FAILURE_PUSH_URL;
    } else {
      process.env.KUMA_WEBHOOK_AUTH_FAILURE_PUSH_URL = originalUrl;
    }
  });

  describe('recordWebhookCall', () => {
    it('appends a record per call with the correct ok flag', () => {
      recordWebhookCall(true);
      recordWebhookCall(false);
      recordWebhookCall(true);

      const snapshot = _getCallsForTests();
      expect(snapshot).toHaveLength(3);
      expect(snapshot.map((c) => c.ok)).toEqual([true, false, true]);
    });

    it('prunes entries older than the 24h window on each write', () => {
      // Insert a stale entry by mocking Date.now ONLY for the push
      // (the prune-after-push runs at the same fake time, so the
      // stale entry survives). Then push a fresh entry at the real
      // time — its prune pass should evict the now-stale entry.
      const fakeOldNow = Date.now() - _WINDOW_MS_FOR_TESTS - 60_000;
      const spy = vi.spyOn(Date, 'now').mockReturnValue(fakeOldNow);
      recordWebhookCall(true); // push + prune both run at fakeOldNow
      spy.mockRestore();

      // Sanity: the stale entry survived its own prune (prune ran at
      // fakeOldNow, so "older than fakeOldNow - WINDOW_MS" was empty).
      expect(_getCallsForTests()).toHaveLength(1);

      // Fresh write triggers prune at the real wall-clock; the entry
      // we pushed at fakeOldNow is now outside the window and evicts.
      recordWebhookCall(false);
      const snapshot = _getCallsForTests();
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].ok).toBe(false);
    });
  });

  describe('runWebhookAuthCheck', () => {
    it('24h window all-authenticated → status=up with received_N_authenticated_N', async () => {
      for (let i = 0; i < 5; i++) recordWebhookCall(true);

      await runWebhookAuthCheck();

      expect(pushKumaHeartbeatMock).toHaveBeenCalledTimes(1);
      const [url, status, msg, tag] = pushKumaHeartbeatMock.mock.calls[0];
      expect(url).toBe(URL);
      expect(status).toBe('up');
      expect(msg).toBe('webhook_auth_ok:received_5_authenticated_5');
      expect(tag).toContain('webhook-auth-check');
    });

    it('24h window all-failed (count above MIN_THRESHOLD) → status=down', async () => {
      for (let i = 0; i < _MIN_THRESHOLD_FOR_TESTS + 2; i++) {
        recordWebhookCall(false);
      }

      await runWebhookAuthCheck();

      expect(pushKumaHeartbeatMock).toHaveBeenCalledTimes(1);
      const [url, status, msg, tag] = pushKumaHeartbeatMock.mock.calls[0];
      expect(url).toBe(URL);
      expect(status).toBe('down');
      expect(msg).toBe(
        `webhook_auth_failed:received_${_MIN_THRESHOLD_FOR_TESTS + 2}_authenticated_0`,
      );
      expect(tag).toContain('webhook-auth-check');
    });

    it('exactly MIN_THRESHOLD all-failed → status=down (boundary inclusive)', async () => {
      // The threshold is "received >= MIN". Verify the boundary
      // explicitly so a future "received > MIN" off-by-one bug surfaces
      // in tests instead of in production.
      for (let i = 0; i < _MIN_THRESHOLD_FOR_TESTS; i++) recordWebhookCall(false);

      await runWebhookAuthCheck();

      expect(pushKumaHeartbeatMock).toHaveBeenCalledTimes(1);
      expect(pushKumaHeartbeatMock.mock.calls[0][1]).toBe('down');
    });

    it('1 failed call (below MIN_THRESHOLD) → no push (false-alarm guard)', async () => {
      // The MIN_THRESHOLD floor is the whole point: a single bad call
      // on a quiet day must not page the operator.
      recordWebhookCall(false);

      await runWebhookAuthCheck();

      expect(pushKumaHeartbeatMock).not.toHaveBeenCalled();
    });

    it('0 calls in 24h window → no push (different failure mode, out of scope)', async () => {
      // received==0 means "GH webhook never landed at all". That's a
      // different failure (webhook URL not configured on the GH side)
      // and the brief explicitly scopes it out for v1.
      await runWebhookAuthCheck();

      expect(pushKumaHeartbeatMock).not.toHaveBeenCalled();
    });

    it('mixed authenticated + unauthenticated → status=up (at least some succeed)', async () => {
      // The down state is "received >= MIN AND authenticated == 0" —
      // any successful auth in the window means the secret is still
      // correct for SOME GH delivery (e.g. mid-rotation, or a
      // multi-repo deployment where only one repo's secret drifted).
      // Don't alarm here.
      recordWebhookCall(true);
      recordWebhookCall(false);
      recordWebhookCall(false);
      recordWebhookCall(false);

      await runWebhookAuthCheck();

      expect(pushKumaHeartbeatMock).toHaveBeenCalledTimes(1);
      const [url, status, msg] = pushKumaHeartbeatMock.mock.calls[0];
      expect(url).toBe(URL);
      expect(status).toBe('up');
      expect(msg).toBe('webhook_auth_ok:received_4_authenticated_1');
    });

    it('URL unset → no push attempted (safe deploy default)', async () => {
      delete process.env.KUMA_WEBHOOK_AUTH_FAILURE_PUSH_URL;
      for (let i = 0; i < 10; i++) recordWebhookCall(false);

      await runWebhookAuthCheck();

      expect(pushKumaHeartbeatMock).not.toHaveBeenCalled();
    });

    it('URL set to empty string → no push attempted', async () => {
      // Defence-in-depth: an operator who comments out the env value
      // and leaves the assignment shouldn't trigger a malformed push.
      process.env.KUMA_WEBHOOK_AUTH_FAILURE_PUSH_URL = '';
      for (let i = 0; i < 10; i++) recordWebhookCall(false);

      await runWebhookAuthCheck();

      expect(pushKumaHeartbeatMock).not.toHaveBeenCalled();
    });

    it('prunes the rolling window before deciding (stale entries do NOT count)', async () => {
      // Two stale failed calls + two fresh authenticated calls. The
      // stale ones must NOT contribute to the counter, so the check
      // should see 2 received / 2 ok → below MIN_THRESHOLD → no push.
      const stale = Date.now() - _WINDOW_MS_FOR_TESTS - 60_000;
      const realNow = Date.now;
      let nowReturn = stale;
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => nowReturn);
      recordWebhookCall(false);
      recordWebhookCall(false);
      // Fresh entries.
      nowReturn = realNow();
      recordWebhookCall(true);
      recordWebhookCall(true);
      spy.mockRestore();

      await runWebhookAuthCheck();

      // 2 fresh + 0 stale (post-prune) < MIN_THRESHOLD → no push.
      expect(pushKumaHeartbeatMock).not.toHaveBeenCalled();
      // And the buffer itself is now drained of stale entries.
      expect(_getCallsForTests()).toHaveLength(2);
    });
  });
});
