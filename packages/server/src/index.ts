import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { runMigrations } from './db/migrate.js';
import { seedIfEmpty } from './db/seed.js';
import { snapshotAllMaps } from './lib/releaseSnapshots.js';
import { runAllCatchups } from './sync/githubCatchup.js';
import { auditDrift, type DriftReport } from './sync/driftAudit.js';
import { pushKumaHeartbeat } from './sync/kumaPush.js';
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

  // ── Daily drift audit (GitHub→MindBlown reconciliation gate) ─
  // The webhook + catchup pair is good at "an event happened, did we
  // apply it?", but neither alarms when the event NEVER reached us —
  // bad webhook URL on the GH side, expired install token during the
  // catchup window, an ingest exception that dropped an issue. This
  // sweep diffs open GitHub issues against linked nodes once a day and
  // pushes the result to a Kuma monitor. Drift > 0 → Kuma alarms via
  // its normal channels (Pushover, etc.).
  const DRIFT_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const runDriftAudit = async () => {
    const url = process.env.KUMA_GITHUB_DRIFT_PUSH_URL;
    let reports: DriftReport[];
    try {
      reports = await auditDrift();
    } catch (err) {
      console.error('[drift-audit] sweep failed:', err);
      // Tell Kuma the audit itself broke. Without this, an exception
      // mid-sweep looks identical to "clean" from Kuma's vantage.
      if (url) {
        const msg = `audit_failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
        await pushKumaHeartbeat(url, 'down', msg, '[kuma-push] drift audit');
      }
      return;
    }
    if (reports.length === 0) {
      console.log('[drift-audit] clean — no drift');
      if (url) {
        await pushKumaHeartbeat(url, 'up', 'no-drift', '[kuma-push] drift audit');
      }
      return;
    }
    const summary = reports.map((r) => `${r.mapName}=${r.onlyInGitHub} issues`).join(', ');
    console.warn(`[drift-audit] drift detected: ${summary}`);
    if (url) {
      // Truncate at 200 chars so the Kuma push URL doesn't blow past
      // common HTTP query-length limits when there are many drifted maps.
      const msg = `drift_detected: ${summary}`.slice(0, 200);
      await pushKumaHeartbeat(url, 'down', msg, '[kuma-push] drift audit');
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
  setInterval(runDriftAudit, DRIFT_AUDIT_INTERVAL_MS);
}

main();
