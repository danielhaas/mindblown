import { create } from 'zustand';

// Read-only offline mode (#572). Every successful JSON GET through api.ts is
// kept in Cache Storage; when the server can't be reached the last copy is
// served instead and `offline` flips on. Writes are not queued — they fail
// and the app shows it is read-only until a request goes through again.

const API_CACHE = 'mindblown-api-v1';
const CACHED_AT = 'x-mindblown-cached-at';

interface OfflineState {
  /** No response reached us on the last request. */
  offline: boolean;
  /** When the oldest copy served while offline was fetched (ISO), if any. */
  servedFrom: string | null;
}

export const useOffline = create<OfflineState>(() => ({ offline: false, servedFrom: null }));

export function markOnline(): void {
  if (useOffline.getState().offline) useOffline.setState({ offline: false, servedFrom: null });
}

export function markOffline(servedFrom?: string): void {
  const prev = useOffline.getState();
  const oldest =
    servedFrom && (!prev.servedFrom || servedFrom < prev.servedFrom) ? servedFrom : prev.servedFrom;
  if (!prev.offline || oldest !== prev.servedFrom) useOffline.setState({ offline: true, servedFrom: oldest });
}

// Cache Storage only exists in secure contexts (https, localhost). Elsewhere
// offline mode is simply off.
function store(): CacheStorage | null {
  return typeof caches === 'undefined' ? null : caches;
}

function key(url: string): string {
  return new URL(url, globalThis.location?.href ?? 'http://localhost').href;
}

export async function saveResponse(url: string, data: unknown): Promise<void> {
  const cs = store();
  if (!cs) return;
  try {
    const cache = await cs.open(API_CACHE);
    await cache.put(
      key(url),
      new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', [CACHED_AT]: new Date().toISOString() },
      }),
    );
  } catch {
    // Quota or private mode — offline mode just has less to show.
  }
}

export async function cachedResponse(url: string): Promise<{ data: unknown; cachedAt: string } | null> {
  const cs = store();
  if (!cs) return null;
  try {
    const cache = await cs.open(API_CACHE);
    const res = await cache.match(key(url));
    if (!res) return null;
    return { data: await res.json(), cachedAt: res.headers.get(CACHED_AT) ?? '' };
  } catch {
    return null;
  }
}

/** Drop everything cached — on sign-in and sign-out, so one account never
 *  sees another's maps offline. */
export function clearApiCache(): void {
  void store()?.delete(API_CACHE).catch(() => {});
}
