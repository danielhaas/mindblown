/**
 * Minimal sd_notify(3) client for the systemd notification socket.
 *
 * Used in two places:
 *
 *   - `sdNotifyReady()` once per process, when Fastify has bound to
 *     its port. Without this, a `Type=notify` unit waits forever in
 *     "starting up" → operator-visible journal noise and (worse)
 *     systemd never starts dependent services.
 *
 *   - `sdNotifyWatchdog()` after every successful catchup tick. With
 *     `WatchdogSec=300` in the unit, systemd kills + restarts the
 *     process if it stops pinging — so a frozen catchup loop (network
 *     stall, pg query hang) doesn't quietly silence GitHub sync.
 *
 * Implementation notes:
 *
 *   - The socket path comes from `$NOTIFY_SOCKET`. When unset (dev / test
 *     environments not started by systemd), both helpers no-op silently.
 *   - The wire format is plain ASCII key=value lines on a unix-domain
 *     SOCK_DGRAM socket. systemd's notify socket is SOCK_DGRAM — node's
 *     `node:dgram` only exposes UDP, and `node:net` exposes unix sockets
 *     in stream mode only. Rather than pull in the `sd-notify` or
 *     `unix-dgram` npm packages (native build, postinstall hook), we
 *     shell out to the `systemd-notify(1)` CLI which is already present
 *     on every host running our service (it's part of systemd itself).
 *     Subprocess spawn is ~2 ms — negligible compared to the
 *     once-per-startup + once-per-5-min cadence.
 *   - All errors are caught + logged at `warn` — a broken notify socket
 *     must NEVER take down the API.
 */

import { spawn } from 'node:child_process';

/**
 * Send a single sd_notify-format payload to systemd via `systemd-notify`.
 * Silent no-op when `$NOTIFY_SOCKET` is unset (dev / test). Resolves
 * true when the subprocess exited 0.
 *
 * Exported for tests so each kind of payload (READY=1 vs WATCHDOG=1)
 * can be verified to flow through the same path.
 */
export async function sendNotify(payload: string): Promise<boolean> {
  const socketPath = process.env.NOTIFY_SOCKET;
  if (!socketPath) return false;

  // Strip any trailing newline so we don't pass an empty extra arg.
  const lines = payload.split('\n').filter((s) => s.length > 0);
  if (lines.length === 0) return false;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean, err?: unknown): void => {
      if (settled) return;
      settled = true;
      if (err) {
        console.warn(
          '[sd-notify] failed:',
          err instanceof Error ? err.message : err,
        );
      }
      resolve(ok);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('systemd-notify', lines, {
        stdio: ['ignore', 'ignore', 'ignore'],
        // Inherit NOTIFY_SOCKET so systemd-notify finds the right
        // socket — without it the binary returns 0 silently and the
        // notify is lost.
        env: process.env,
      });
    } catch (err) {
      finish(false, err);
      return;
    }

    child.once('error', (err) => finish(false, err));
    child.once('exit', (code) => finish(code === 0));
  });
}

/**
 * Send `READY=1` once Fastify has bound to its port. Required for
 * `Type=notify` units — without it systemd thinks the service is
 * still starting up forever.
 */
export async function sdNotifyReady(): Promise<boolean> {
  return sendNotify('READY=1');
}

/**
 * Ping the systemd watchdog. Combined with `WatchdogSec=300` in the
 * unit file, this prevents a frozen catchup loop (network stall,
 * blocked pg query) from silently silencing GitHub sync — systemd
 * kills + restarts the process after 5 min of no pings.
 *
 * The caller MUST only invoke this on a SUCCESSFUL tick — pinging
 * regardless of catchup health would defeat the watchdog's purpose.
 */
export async function sdNotifyWatchdog(): Promise<boolean> {
  return sendNotify('WATCHDOG=1');
}
