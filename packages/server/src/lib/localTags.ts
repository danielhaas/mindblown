import { MINDBLOWN_LOCAL_TAGS } from '@mindblown/core';

const isLocal = (t: string) => MINDBLOWN_LOCAL_TAGS.includes(t.toLowerCase());

/**
 * The inbound label mirror replaces a node's tags with the issue's labels.
 * MindBlown-local tags (fleet-fix, fleet-check) are not part of that
 * mirror: the node keeps the ones it has, and a label of that name on the
 * issue adds none. Only MindBlown — the fleet worker — removes them.
 */
export function keepLocalTags(currentTags: string[], labelTags: string[]): string[] {
  return [...labelTags.filter((t) => !isLocal(t)), ...currentTags.filter(isLocal)];
}
