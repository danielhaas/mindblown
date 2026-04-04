import type { FastifyInstance } from 'fastify';

/** Minimal WebSocket interface matching what we need. */
interface WS {
  readyState: number;
  send(data: string): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}

/**
 * Map of mapId -> Set of connected WebSocket clients.
 */
const rooms = new Map<string, Set<WS>>();

/**
 * Broadcast a message to all clients connected to a specific map.
 */
export function broadcast(mapId: string, message: unknown): void {
  const clients = rooms.get(mapId);
  if (!clients) return;

  const payload = JSON.stringify(message);

  for (const ws of clients) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(payload);
    }
  }
}

/**
 * Register the WebSocket endpoint: /ws/maps/:id
 */
export async function registerWebSocket(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/ws/maps/:id',
    { websocket: true },
    (socket, req) => {
      const mapId = req.params.id;
      const ws = socket as unknown as WS;

      // Join the room
      if (!rooms.has(mapId)) {
        rooms.set(mapId, new Set());
      }
      rooms.get(mapId)!.add(ws);

      console.log(`[ws] Client connected to map ${mapId} (${rooms.get(mapId)!.size} clients)`);

      // Handle incoming messages (for future use — client can send mutations via WS)
      ws.on('message', (data: unknown) => {
        // For now, just echo the raw message to other clients in the room
        const clients = rooms.get(mapId);
        if (!clients) return;

        for (const client of clients) {
          if (client !== ws && client.readyState === 1) {
            client.send(String(data));
          }
        }
      });

      // Clean up on disconnect
      ws.on('close', () => {
        const clients = rooms.get(mapId);
        if (clients) {
          clients.delete(ws);
          if (clients.size === 0) {
            rooms.delete(mapId);
          }
          console.log(`[ws] Client disconnected from map ${mapId} (${clients.size} remaining)`);
        }
      });
    },
  );
}
