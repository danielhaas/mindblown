import { getToken } from './api.js';

type MessageHandler = (data: unknown) => void;

const WS_BASE: string = (import.meta.env.VITE_API_URL ?? 'http://localhost:3001').replace(/^http/, 'ws');

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000];

export interface WsClient {
  close(): void;
  isConnected(): boolean;
  send(data: unknown): void;
}

/**
 * Connect to the WebSocket for a specific map.
 * Automatically reconnects on disconnect with exponential backoff.
 */
export function connectWs(mapId: string, onMessage: MessageHandler, onStatusChange?: (connected: boolean) => void): WsClient {
  let ws: WebSocket | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function connect() {
    if (closed) return;

    try {
      const token = getToken();
      const url = token
        ? `${WS_BASE}/ws/maps/${mapId}?token=${encodeURIComponent(token)}`
        : `${WS_BASE}/ws/maps/${mapId}`;
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      reconnectAttempt = 0;
      onStatusChange?.(true);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onMessage(data);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      onStatusChange?.(false);
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  function scheduleReconnect() {
    if (closed) return;
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    reconnectAttempt++;
    reconnectTimer = setTimeout(connect, delay);
  }

  connect();

  return {
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      onStatusChange?.(false);
    },
    isConnected() {
      return ws?.readyState === WebSocket.OPEN;
    },
    send(data: unknown) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    },
  };
}
