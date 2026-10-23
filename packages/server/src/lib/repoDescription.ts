/**
 * A repository description GitHub and Gitea accept: one line, no control
 * characters (GitHub answers 422 "description control characters are not
 * allowed" for a newline), at most 350 characters. Anything else → undefined.
 */
export function repoDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const line = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Cut by code points: a UTF-16 slice can leave half an emoji behind.
  return line ? Array.from(line).slice(0, 350).join('').trimEnd() : undefined;
}
