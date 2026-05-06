import type { FastifyInstance } from 'fastify';
import { verifyToken } from './auth.js';
import { db } from './db/connection.js';
import { users } from './db/schema.js';
import { eq } from 'drizzle-orm';

/** Minimal WebSocket interface matching what we need. */
interface WS {
  readyState: number;
  send(data: string): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}

interface ConnectedClient {
  ws: WS;
  userId: string | null;
  userName: string | null;
}

/**
 * Map of mapId -> Set of connected clients.
 */
const rooms = new Map<string, Set<ConnectedClient>>();

/**
 * Broadcast a message to all clients connected to a specific map.
 */
export function broadcast(mapId: string, message: unknown, excludeWs?: WS): void {
  const clients = rooms.get(mapId);
  if (!clients) return;

  const payload = JSON.stringify(message);

  for (const client of clients) {
    if (client.ws.readyState === 1 && client.ws !== excludeWs) { // WebSocket.OPEN
      client.ws.send(payload);
    }
  }
}

/**
 * Register the WebSocket endpoint: /ws/maps/:id
 * Supports optional authentication via ?token=xxx query param.
 */
export async function registerWebSocket(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/ws/maps/:id',
    { websocket: true },
    async (socket, req) => {
      const mapId = req.params.id;
      const ws = socket as unknown as WS;
      const token = req.query.token;

      // Authenticate if token provided
      let userId: string | null = null;
      let userName: string | null = null;

      if (token) {
        try {
          const payload = verifyToken(token);
          userId = payload.userId;

          // Fetch user name
          const [user] = await db
            .select({ name: users.name })
            .from(users)
            .where(eq(users.id, payload.userId))
            .limit(1);

          userName = user?.name ?? null;
        } catch {
          // Invalid token - allow connection but as anonymous
          console.log(`[ws] Invalid token for map ${mapId}, connecting as anonymous`);
        }
      }

      const client: ConnectedClient = { ws, userId, userName };

      // Join the room
      if (!rooms.has(mapId)) {
        rooms.set(mapId, new Set());
      }
      rooms.get(mapId)!.add(client);

      console.log(`[ws] Client connected to map ${mapId} (${rooms.get(mapId)!.size} clients)${userId ? ` user=${userId}` : ' anonymous'}`);

      // Broadcast user:join if authenticated
      if (userId) {
        broadcast(mapId, {
          type: 'user:join',
          userId,
          name: userName,
        }, ws);
      }

      // Handle incoming messages
      ws.on('message', (data: unknown) => {
        const clients = rooms.get(mapId);
        if (!clients) return;

        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(String(data));
        } catch {
          // Not JSON, ignore
          return;
        }

        if (!parsed) return;

        // Handle cursor presence
        if (parsed.type === 'cursor' && userId) {
          const cursorMsg = JSON.stringify({
            type: 'cursor',
            userId,
            name: userName,
            x: parsed.x,
            y: parsed.y,
          });

          for (const c of clients) {
            if (c.ws !== ws && c.ws.readyState === 1) {
              c.ws.send(cursorMsg);
            }
          }
          return;
        }

        // Viewport / focus presence (for follow mode). Stamp userId/name
        // server-side so clients can't impersonate.
        if (parsed.type === 'presence:viewport' && userId) {
          const msg = JSON.stringify({
            type: 'presence:viewport',
            userId,
            name: userName,
            cx: parsed.cx,
            cy: parsed.cy,
            zoom: parsed.zoom,
            focusNodeId: parsed.focusNodeId ?? null,
          });

          for (const c of clients) {
            if (c.ws !== ws && c.ws.readyState === 1) {
              c.ws.send(msg);
            }
          }
          return;
        }

        // Forward other messages to other clients in the room
        for (const c of clients) {
          if (c.ws !== ws && c.ws.readyState === 1) {
            c.ws.send(String(data));
          }
        }
      });

      // Clean up on disconnect
      ws.on('close', () => {
        const clients = rooms.get(mapId);
        if (clients) {
          clients.delete(client);

          // Broadcast user:leave if authenticated
          if (userId) {
            broadcast(mapId, {
              type: 'user:leave',
              userId,
            });
          }

          if (clients.size === 0) {
            rooms.delete(mapId);
          }
          console.log(`[ws] Client disconnected from map ${mapId} (${clients.size} remaining)`);
        }
      });
    },
  );
}
