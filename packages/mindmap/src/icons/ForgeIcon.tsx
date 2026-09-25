import { OctocatIcon } from './Octocat.js';
import { GiteaIcon } from './Gitea.js';

interface ForgeIconProps {
  /** A link's `provider` or a map's `forgeKind`: 'gitea' draws the teacup, anything else the Octocat. */
  kind?: string | null;
  size?: number;
  color?: string;
  x?: number;
  y?: number;
}

/** The forge's logo, picked the same way `forgeLabel` picks the name. */
export function ForgeIcon({ kind, ...props }: ForgeIconProps) {
  return kind === 'gitea' ? <GiteaIcon {...props} /> : <OctocatIcon {...props} />;
}
