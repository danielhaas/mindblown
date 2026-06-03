/**
 * Tests for the sd_notify helper.
 *
 * The helper shells out to `systemd-notify(1)` because node's stdlib
 * doesn't expose unix SOCK_DGRAM sockets in a non-dependency-laden way.
 * We mock `node:child_process.spawn` so the test exercises the
 * env-var gate, the args we pass, and each failure-mode branch
 * (spawn throws, subprocess errors, subprocess exits non-zero) without
 * actually running anything.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock child_process.spawn ──────────────────────────────────────

interface MockSpawnCall {
  command: string;
  args: string[];
}

const spawnCalls: MockSpawnCall[] = [];
let spawnBehaviour: 'exit0' | 'exit1' | 'error' | 'throw' = 'exit0';

class MockChild extends EventEmitter {
  constructor(public command: string, public args: string[]) {
    super();
  }
}

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], _opts: unknown) => {
    spawnCalls.push({ command, args });
    if (spawnBehaviour === 'throw') {
      throw new Error('ENOENT spawn systemd-notify');
    }
    const child = new MockChild(command, args);
    // Fire the appropriate event on next tick so the listener registered
    // by the helper is attached before we emit.
    queueMicrotask(() => {
      if (spawnBehaviour === 'error') {
        child.emit('error', new Error('spawn error path'));
      } else if (spawnBehaviour === 'exit1') {
        child.emit('exit', 1);
      } else {
        child.emit('exit', 0);
      }
    });
    return child;
  },
}));

// ── SUT import (after mocks) ──────────────────────────────────────

import { sendNotify, sdNotifyReady, sdNotifyWatchdog } from '../sdNotify.js';

// ── Tests ─────────────────────────────────────────────────────────

describe('sendNotify', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    spawnBehaviour = 'exit0';
    delete process.env.NOTIFY_SOCKET;
  });

  afterEach(() => {
    delete process.env.NOTIFY_SOCKET;
  });

  it('is a no-op when $NOTIFY_SOCKET is unset', async () => {
    const ok = await sendNotify('READY=1');
    expect(ok).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });

  it('spawns systemd-notify with the payload line(s) when $NOTIFY_SOCKET is set', async () => {
    process.env.NOTIFY_SOCKET = '/run/systemd/notify';
    const ok = await sendNotify('READY=1');
    expect(ok).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('systemd-notify');
    expect(spawnCalls[0].args).toEqual(['READY=1']);
  });

  it('passes each newline-separated payload line as a separate arg', async () => {
    process.env.NOTIFY_SOCKET = '/run/systemd/notify';
    const ok = await sendNotify('STATUS=Running\nWATCHDOG=1');
    expect(ok).toBe(true);
    expect(spawnCalls[0].args).toEqual(['STATUS=Running', 'WATCHDOG=1']);
  });

  it('returns false when the subprocess emits error (does not throw)', async () => {
    process.env.NOTIFY_SOCKET = '/run/systemd/notify';
    spawnBehaviour = 'error';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(sendNotify('READY=1')).resolves.toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns false when the subprocess exits non-zero (does not throw)', async () => {
    process.env.NOTIFY_SOCKET = '/run/systemd/notify';
    spawnBehaviour = 'exit1';
    await expect(sendNotify('READY=1')).resolves.toBe(false);
  });

  it('returns false when spawn itself throws synchronously (does not throw)', async () => {
    process.env.NOTIFY_SOCKET = '/run/systemd/notify';
    spawnBehaviour = 'throw';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(sendNotify('READY=1')).resolves.toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns false when the payload is empty (no point spawning)', async () => {
    process.env.NOTIFY_SOCKET = '/run/systemd/notify';
    await expect(sendNotify('')).resolves.toBe(false);
    await expect(sendNotify('\n\n')).resolves.toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });
});

describe('sdNotifyReady / sdNotifyWatchdog', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    spawnBehaviour = 'exit0';
    delete process.env.NOTIFY_SOCKET;
  });

  afterEach(() => {
    delete process.env.NOTIFY_SOCKET;
  });

  it('sdNotifyReady sends READY=1', async () => {
    process.env.NOTIFY_SOCKET = '/run/systemd/notify';
    await sdNotifyReady();
    expect(spawnCalls[0].args).toEqual(['READY=1']);
  });

  it('sdNotifyWatchdog sends WATCHDOG=1', async () => {
    process.env.NOTIFY_SOCKET = '/run/systemd/notify';
    await sdNotifyWatchdog();
    expect(spawnCalls[0].args).toEqual(['WATCHDOG=1']);
  });

  it('both are no-ops when $NOTIFY_SOCKET is unset', async () => {
    await sdNotifyReady();
    await sdNotifyWatchdog();
    expect(spawnCalls).toHaveLength(0);
  });
});
