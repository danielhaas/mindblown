import { useEffect } from 'react';
import { useMindmapStore } from './store.js';

export const DEFAULT_TITLE = 'MindBlown';

/** The browser tab title: `MB: <map name>` while a map is open, else `MindBlown`. */
export function documentTitle(mapName: string | null | undefined): string {
  return mapName ? `MB: ${mapName}` : DEFAULT_TITLE;
}

/**
 * Keep the browser tab title on the open map so several MindBlown tabs can be
 * told apart. Restores the default title on unmount.
 */
export function useDocumentTitle(mapName: string | null | undefined): void {
  useEffect(() => {
    document.title = documentTitle(mapName);
  }, [mapName]);
  useEffect(() => () => {
    document.title = DEFAULT_TITLE;
  }, []);
}

/** Desktop shell: title follows the store's open map (switch, rename, leave). */
export function useMapDocumentTitle(): void {
  const name = useMindmapStore((s) => (s.currentMapId ? s.currentMap?.name : null));
  useDocumentTitle(name);
}
