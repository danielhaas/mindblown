import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { runMigrations } from './db/migrate.js';
import { seedIfEmpty } from './db/seed.js';
import { mapRoutes } from './routes/maps.js';
import { nodeRoutes } from './routes/nodes.js';
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
      'http://localhost:5173', // Vite dev server
      'http://localhost:3000', // Production frontend
    ],
    credentials: true,
  });

  await app.register(websocket);

  // ── Routes ─────────────────────────────────────────────────────
  await app.register(mapRoutes);
  await app.register(nodeRoutes);
  await registerWebSocket(app);

  // ── Health check ───────────────────────────────────────────────
  app.get('/api/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

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
