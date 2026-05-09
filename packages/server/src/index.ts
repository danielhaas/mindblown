import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { runMigrations } from './db/migrate.js';
import { seedIfEmpty } from './db/seed.js';
import { snapshotAllMaps } from './lib/releaseSnapshots.js';
import { runAllCatchups } from './sync/githubCatchup.js';
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
import { registerWebSocket } from './ws.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);

async function main(): Promise<void> {
  const app = Fastify({
    logger: {
      level: 'info',
    },
  });

  // ── Plugins ────────────────────────────────────────────────────
  await app.register(cors, {
    origin: [
      'http://localhost:5180', // Vite dev server
      'http://localhost:3000', // Production frontend
    ],
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
}

main();
