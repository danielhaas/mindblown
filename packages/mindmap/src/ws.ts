import { getToken } from './api.js';

type MessageHandler = (data: unknown) => void;

/**
 * Ohne VITE_API_URL: gleiche Herkunft wie die Seite, Schema aus dem Protokoll
 * abgeleitet (https -> wss). Ein leerer Basis-String würde eine relative
 * WebSocket-URL ergeben, die der Browser nicht auflöst — anders als bei fetch
 * braucht `new WebSocket()` eine absolute Adresse.
 *
 * Bewusst eine Funktion und keine Modul-Konstante: `window` beim Import zu
 * lesen macht das Modul in Node unimportierbar, und `store.ts` zieht es mit
 * herein. Die Tests laufen in der node-Umgebung ohne DOM, also fiel dort die
 * ganze Suite mit `ReferenceError: window is not defined` aus — obwohl keiner
 * der Tests je eine Verbindung aufbaut. Erst beim Verbinden auszuwerten kostet
 * nichts und hält den Import seiteneffektfrei.
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
