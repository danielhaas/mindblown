import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { runMigrations } from './db/migrate.js';
import { seedIfEmpty } from './db/seed.js';
import { authRoutes } from './auth.js';
import { systemRoutes } from './routes/system.js';
import { registerAuthMiddleware } from './middleware/auth.js';
import { mapRoutes } from './routes/maps.js';
import { nodeRoutes } from './routes/nodes.js';
import { cycleRoutes } from './routes/cycles.js';
import { versionRoutes } from './routes/versions.js';
import { milestoneRoutes } from './routes/milestones.js';
import { commentRoutes } from './routes/comments.js';
import { permissionRoutes } from './routes/permissions.js';
import { integrationRoutes } from './routes/integrations.js';
import { githubAuthRoutes } from './routes/auth-github.js';
import { aiRoutes } from './routes/ai.js';
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
  await app.register(milestoneRoutes);
  await app.register(commentRoutes);
  await app.register(permissionRoutes);
  await app.register(integrationRoutes);
  await app.register(githubAuthRoutes);
  await app.register(aiRoutes);
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
}

main();
