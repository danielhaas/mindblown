import * as api from './api.js';
import { showToast } from './toast.js';

/** The version the server gave a new node because it came without one (server nodeDb.versionDefaultOf). */
export interface VersionDefault {
  id: string;
  name: string;
}

/**
 * The map's gate names versions, so a ticket without one would be
 * invisible to the fleet: the server put it into the active version. The
 * toast says so and takes it back out in one click; any other version is
 * the node's Version field.
 */
export function showVersionDefaultToast(
  mapId: string,
  node: { id: string; text: string },
  version: VersionDefault,
): void {
  showToast(`«${node.text}» added to ${version.name}, the active version — the fleet's gate only takes versioned work.`, undefined, {
    action: {
      label: 'No version',
      run: () => {
        api.updateNode(mapId, node.id, { versionId: null }).then(
          // The live update (node:updated) brings the change into the map.
          () => showToast(`«${node.text}» has no version — outside the gate, the fleet will not take it.`),
          (err: unknown) => showToast(`Version not changed: ${err instanceof Error ? err.message : String(err)}`, undefined, { warn: true }),
        );
      },
    },
  });
}
