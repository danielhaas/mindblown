import { getToken } from './api.js';

type MessageHandler = (data: unknown) => void;

/**
 * Without VITE_API_URL: same origin as the page, scheme derived from the
 * protocol (https -> wss). An empty base string would yield a relative
 * WebSocket URL, which the browser does not resolve — unlike fetch,
 * `new WebSocket()` needs an absolute address.
 *
 * Deliberately a function, not a module constant: reading `window` at import
 * time makes the module unimportable in Node, and `store.ts` pulls it in. The
 * tests run in the node environment without a DOM, so the whole suite failed
 * there with `ReferenceError: window is not defined` — although none of the
 * tests ever opens a connection. Evaluating at connect time costs nothing and
 * keeps the import free of side effects.
 */
function wsBase(): string {
  const configured = import.meta.env.VITE_API_URL;
  if (configured) return (configured as string).replace(/^http/, 'ws');
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}`;
}

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
      const base = wsBase();
      const url = token
        ? `${base}/ws/maps/${mapId}?token=${encodeURIComponent(token)}`
        : `${base}/ws/maps/${mapId}`;
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
