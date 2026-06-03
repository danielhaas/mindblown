import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { runMigrations } from './db/migrate.js';
import { seedIfEmpty } from './db/seed.js';
import { snapshotAllMaps } from './lib/releaseSnapshots.js';
import { runAllCatchups } from './sync/githubCatchup.js';
import { runDriftAudit } from './sync/driftAudit.js';
import { resolveDriftAuditIntervalMs } from './sync/driftAuditInterval.js';
import { runCanary } from './sync/canary.js';
import { sdNotifyReady } from './sync/sdNotify.js';
import { authRoutes } from './auth.js';
import { systemRoutes } from './routes/system.js';
import { registerAuthMiddleware } from './middleware/auth.js';
import { mapRoutes } from './routes/maps.js';
import { nodeRoutes } from './routes/nodes.js';
import { cycleRoutes } from './routes/cycles.js';
import { versionRoutes } from './routes/versions.js';
import { commentRoutes } from './routes/comments.js';
import { permissionRoutes } from './routes/permissions.js';
import { integrationRoutes } from './routes/integrations.js';
import { githubAuthRoutes } from './routes/auth-github.js';
import { aiRoutes } from './routes/ai.js';
import { feedbackRoutes } from './routes/feedback.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { mcpRoutes } from './routes/mcp.js';
import { registerWebSocket } from './ws.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);

async function main(): Promise<void> {
  const app = Fastify({
    logger: {
      level: 'info',
    },
  });

  // ── Plugins ────────────────────────────────────────────────────
  // CORS is locked down to the frontends that talk to this API. The MCP
  // HTTP endpoint at /mcp is exempt from credential-CORS — MCP clients
  // (Claude Code, etc.) talk to it from non-browser contexts that don't
  // honour CORS — and authenticated callers provide a Bearer header
  // rather than a cookie.
  const allowedOrigins = [
    'http://localhost:5180', // Vite dev server
    'http://localhost:3000', // Production frontend (legacy)
    'https://mind.project.li',
  ];
  if (process.env.EXTRA_CORS_ORIGINS) {
    for (const origin of process.env.EXTRA_CORS_ORIGINS.split(',')) {
      const trimmed = origin.trim();
      if (trimmed) allowedOrigins.push(trimmed);
    }
  }
  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
  });

  await app.register(websocket);

  // ── Health check (before auth middleware) ───────────────────────
  app.get('/api/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // ── Auth routes (register/login are public) ────────────────────
  await app.register(authRoutes);

  // ── Auth middleware (protects all subsequent /api/ routes) ──────
  await registerAuthMiddleware(app);

  // ── Protected Routes ───────────────────────────────────────────
  await app.register(mapRoutes);
  await app.register(nodeRoutes);
  await app.register(cycleRoutes);
  await app.register(versionRoutes);
  await app.register(commentRoutes);
  await app.register(permissionRoutes);
  await app.register(integrationRoutes);
  await app.register(githubAuthRoutes);
  await app.register(aiRoutes);
  await app.register(feedbackRoutes);
  await app.register(apiKeyRoutes);
  await app.register(mcpRoutes);
  await app.register(systemRoutes);
  await registerWebSocket(app);

  // ── Database setup ─────────────────────────────────────────────
  try {
    await runMigrations();
    await seedIfEmpty();
  } catch (err) {
    console.error('[db] Failed to initialize database:', err);
    process.exit(1);
  }

  // ── Start ──────────────────────────────────────────────────────
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`[server] MindBlown API listening on http://localhost:${PORT}`);
    console.log(`[server] WebSocket available at ws://localhost:${PORT}/ws/maps/:id`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // ── Tell systemd we're up (Type=notify) ────────────────────────
  // The mindblown-api.service unit uses `Type=notify` so dependent
  // services (Caddy reload, etc.) only fire once we've actually bound
  // a port. Without this `READY=1` ping, systemd waits forever in
  // "starting up" mode → unit appears stuck and `systemctl start`
  // never returns. Silent no-op when run outside systemd (no
  // $NOTIFY_SOCKET).
  try {
    await sdNotifyReady();
  } catch (err) {
    console.warn(
      '[sd-notify] READY ping unexpectedly threw:',
      err instanceof Error ? err.message : err,
    );
  }

  // ── Release snapshot cron (daily trend history) ──────────────
  // Catch-up on startup (cheap, idempotent), then re-snapshot every
  // hour. Each hourly call upserts today's row per (map, version),
  // so the latest numbers always reflect current state while the
  // calendar-day UNIQUE key keeps history bounded to one row/day.
  // Runs in-process — matches the single-instance deployment shape;
  // no systemd timer needed.
  const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const runSnapshot = async () => {
    try {
      const { maps, rows } = await snapshotAllMaps();
      if (maps > 0) {
        console.log(`[release-snapshot] wrote ${rows} rows across ${maps} map(s)`);
      }
    } catch (err) {
      console.error('[release-snapshot] job failed:', err);
    }
  };
  // Startup run is fire-and-forget so a slow DB doesn't delay the listen.
  runSnapshot();
  setInterval(runSnapshot, SNAPSHOT_INTERVAL_MS);

  // ── GitHub catch-up reconcile (webhook backstop) ─────────────
  // Webhooks are realtime but best-effort — server downtime or signature
  // mismatches drop events. This periodic sweep asks GitHub "what's
  // changed since last sync?" and applies any drift to linked nodes,
  // so missed webhooks self-heal within one cycle. Startup pass heals
  // whatever the most recent reboot/migration dropped.
  const CATCHUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  const runCatchup = async () => {
    try {
      const results = await runAllCatchups();
      const touched = results.reduce((n, r) => n + r.applied, 0);
      const fetched = results.reduce((n, r) => n + r.fetched, 0);
      const failed = results.filter((r) => r.error);
      // Log every tick so the cadence is visible — even quiet ticks
      // (fetched=0) confirm the schedule is alive and the since=
      // filter is doing its job.
      console.log(
        `[github-catchup] repos=${results.length} fetched=${fetched} applied=${touched} failed=${failed.length}`,
      );
      for (const r of failed) {
        console.warn(`[github-catchup] ${r.repo}: ${r.error}`);
      }
    } catch (err) {
      console.error('[github-catchup] sweep failed:', err);
    }
  };
  runCatchup();
  setInterval(runCatchup, CATCHUP_INTERVAL_MS);

  // ── Drift audit (GitHub→MindBlown reconciliation gate) ──────────
  // The webhook + catchup pair is good at "an event happened, did we
  // apply it?", but neither alarms when the event NEVER reached us —
  // bad webhook URL on the GH side, expired install token during the
  // catchup window, an ingest exception that dropped an issue. This
  // sweep diffs open GitHub issues against linked nodes every 6 hours
  // (configurable via DRIFT_AUDIT_INTERVAL_MS), tries to auto-backfill
  // any drift under the per-day cap, and pushes the result to a Kuma
  // monitor. Drift left after auto-backfill → Kuma alarms via its
  // normal channels (Pushover, etc.).
  //
  // Cadence is 6h (down from a previous 24h hardcode, closes #72) so
  // alarm-to-detect latency shrinks from a 24h max to a 6h max. Tighter
  // intervals (sub-1h) are rejected: at 100+ opted-in maps the GitHub
  // API rate-limit pressure starts to matter, and the floor protects
  // against an env-var typo like `DRIFT_AUDIT_INTERVAL_MS=0` turning
  // setInterval into a DDoS amplifier.
  const DRIFT_AUDIT_INTERVAL_MS = resolveDriftAuditIntervalMs(
    process.env.DRIFT_AUDIT_INTERVAL_MS,
  );
  const driftAuditTick = async (): Promise<void> => {
    try {
      await runDriftAudit();
    } catch (err) {
      // runDriftAudit handles its own error paths + Kuma push; this
      // catch is defence-in-depth for an unexpected synchronous throw.
      console.error('[drift-audit] scheduler caught unexpected error:', err);
    }
  };
  // Deliberately no startup invocation. Drift audit fans out one
  // `importGitHubIssues` call per opted-in map across the entire
  // deployment, so a crashloop or rolling restart would hammer GitHub
  // on every boot. The catchup loop (above) is fine to run on startup
  // because it uses a `since=` cursor, but drift audit fetches every
  // open issue unconditionally. Wait for the first interval tick;
  // operators can hit POST /api/maps/sync/audit-drift to force a run
  // post-deploy.
  setInterval(driftAuditTick, DRIFT_AUDIT_INTERVAL_MS);

  // ── Weekly Pushover canary (alarm-chain liveness probe) ──────
  // Fires a `status=down` then `status=up` to a dedicated Kuma push
  // monitor once a week. Confirms the catchup-heartbeat → Kuma →
  // Pushover chain is alive without waiting for a real outage to
  // exercise it. No-op when `KUMA_ALARM_CANARY_PUSH_URL` is unset.
  // Allow `CANARY_INTERVAL_MS` env-var override so operators can dial
  // the cadence down for a one-off post-deploy smoke test, then put
  // it back to weekly afterwards. Deliberately no startup invocation
  // — we don't want a Pushover on every restart/upgrade.
  const CANARY_INTERVAL_MS = parseInt(
    process.env.CANARY_INTERVAL_MS ?? `${7 * 24 * 60 * 60 * 1000}`,
    10,
  );
  const canaryTick = async (): Promise<void> => {
    try {
      await runCanary();
    } catch (err) {
      // runCanary handles its own per-push error paths; this is
      // defence-in-depth for an unexpected synchronous throw.
      console.error('[canary] scheduler caught unexpected error:', err);
    }
  };
  setInterval(canaryTick, CANARY_INTERVAL_MS);
}

main();
