import { useEffect, useRef, useState } from 'react';
import * as api from './api.js';
import type { Comment } from './api.js';

/**
 * Tracks unread map-chat (root-node-comment) count per map, persisted to
 * localStorage so the badge survives reloads.
 *
 * Mechanics:
 *   - On (mapId, rootNodeId) change: fetch root comments, count those
 *     newer than the stored lastSeen timestamp.
 *   - Listen for ws:comment 'created' events on the root: if the panel
 *     is open, bump lastSeen to keep the badge clean next reload; if
 *     closed, increment the in-memory count.
 *   - On panel open transition false→true: bump lastSeen, clear count.
 */

const lastSeenKey = (mapId: string) => `mapchat:lastSeen:${mapId}`;

function getLastSeen(mapId: string): number {
  try {
    const v = localStorage.getItem(lastSeenKey(mapId));
    return v ? Number(v) : 0;
  } catch {
    return 0;
  }
}

function setLastSeen(mapId: string, ts: number): void {
  try {
    localStorage.setItem(lastSeenKey(mapId), String(ts));
  } catch {
    // localStorage unavailable (private mode, quota) — fall through
  }
}

export function useMapChatUnread(
  mapId: string | null,
  rootNodeId: string | null,
  isOpen: boolean,
): number {
  const [count, setCount] = useState(0);

  const isOpenRef = useRef(isOpen);
  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  // Seed the badge from the server when the map (or root) changes.
  useEffect(() => {
    if (!mapId || !rootNodeId) {
      setCount(0);
      return;
    }
    let cancelled = false;
    const lastSeen = getLastSeen(mapId);
    api
      .fetchComments(mapId, rootNodeId)
      .then((comments: Comment[]) => {
        if (cancelled) return;
        const unread = comments.filter(
          (c) => new Date(c.createdAt).getTime() > lastSeen,
        ).length;
        setCount(unread);
      })
      .catch(() => {
        // Silent — leave count at 0 if the fetch fails.
      });
    return () => {
      cancelled = true;
    };
  }, [mapId, rootNodeId]);

  // Live updates via the global ws:comment event the store dispatches.
  useEffect(() => {
    if (!mapId || !rootNodeId) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { type?: string; comment?: { nodeId?: string; createdAt?: string } }
        | undefined;
      if (!detail) return;
      if (detail.type !== 'comment:created') return;
      if (detail.comment?.nodeId !== rootNodeId) return;

      if (isOpenRef.current) {
        // Panel is open — the user is reading. Advance lastSeen so the
        // badge stays clean on next load.
        setLastSeen(mapId, Date.now());
        return;
      }
      setCount((c) => c + 1);
    };
    window.addEventListener('ws:comment', handler);
    return () => window.removeEventListener('ws:comment', handler);
  }, [mapId, rootNodeId]);

  // Open transition: mark everything seen and clear the badge.
  useEffect(() => {
    if (isOpen && mapId) {
      setLastSeen(mapId, Date.now());
      setCount(0);
    }
  }, [isOpen, mapId]);

  return count;
}
