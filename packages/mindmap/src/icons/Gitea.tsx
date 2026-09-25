interface GiteaIconProps {
  size?: number;
  color?: string;
  x?: number;
  y?: number;
}

/**
 * Gitea's teacup, simplified for 11–18 px: cup body, handle, two wisps of
 * steam. Single-colour so it takes the same `color` as the Octocat and
 * reads as "Gitea" next to it. Default colour is Gitea's green.
 */
export function GiteaIcon({
  size = 12,
  color = '#609926',
  x,
  y,
}: GiteaIconProps) {
  return (
    <svg
      x={x}
      y={y}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={color}
    >
      {/* cup */}
      <path d="M1.5 5.75h9.5v5.25A4 4 0 0 1 7 15H5.5a4 4 0 0 1-4-4z" />
      {/* handle — a ring, so it stays open at small sizes */}
      <path
        fillRule="evenodd"
        d="M11 6.5h1.7a2.6 2.6 0 0 1 0 5.2H11v-1.6h1.7a1 1 0 0 0 0-2H11z"
      />
      {/* steam */}
      <path d="M4.7 4.3c-.7-.7-.7-1.4 0-2.1.5-.5.5-.9 0-1.5l.8-.6c.8.8.8 1.6 0 2.4-.5.5-.5.9 0 1.4z" />
      <path d="M7.9 4.3c-.7-.7-.7-1.4 0-2.1.5-.5.5-.9 0-1.5l.8-.6c.8.8.8 1.6 0 2.4-.5.5-.5.9 0 1.4z" />
    </svg>
  );
}
