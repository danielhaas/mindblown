import type { MisfiledRepo } from '@mindblown/core';
import * as api from './api.js';
import { showToast } from './toast.js';

/**
 * Wrong-map guard: the ticket just created names the repo another map
 * plans. It was created (and the fleet holds it); the toast says where it
 * belongs and moves it there in one click.
 */
export function showMisfiledToast(mapId: string, node: { id: string; text: string }, misfiled: MisfiledRepo): void {
  showToast(`«${node.text}» names ${misfiled.repo}, which map ${misfiled.suggestedMapName} plans — the fleet holds it until it moves.`, undefined, {
    warn: true,
    action: {
      label: 'Move',
      run: () => {
        api.moveNodeToMap(mapId, node.id, misfiled.suggestedMapId).then(
          (r) => showToast(`Moved «${r.node.text}» to ${r.toMapName}${r.notes.length > 0 ? ` (${r.notes.length} note${r.notes.length === 1 ? '' : 's'} on the node)` : ''}`),
          (err: unknown) => showToast(`Not moved: ${err instanceof Error ? err.message : String(err)}`, undefined, { warn: true }),
        );
      },
    },
  });
}
