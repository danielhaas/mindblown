/**
 * ProseMirror rich-text helpers.
 *
 * Node descriptions are stored as ProseMirror JSON. Several consumers
 * need a plain-text rendering (triage prompts, GitHub issue bodies,
 * pull-queue ticket briefs), so the walk lives here in core where both
 * the server and the integrations package can import it.
 */

/**
 * Render a stored node description to plain text. Walks the ProseMirror
 * doc and concatenates every leaf `text` node, joining block-level nodes
 * with a single newline so readers see something readable without
 * HTML/JSON noise.
 *
 * Strings pass through unchanged so we tolerate legacy nodes whose
 * description was saved as a raw string before the ProseMirror migration.
 * Returns empty string for null/undefined/unknown shapes.
 */
export function proseMirrorToPlainText(description: unknown): string {
  if (description == null) return '';
  if (typeof description === 'string') return description;
  if (typeof description !== 'object') return '';

  const lines: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const obj = node as { type?: string; text?: unknown; content?: unknown };
    if (obj.type === 'text' && typeof obj.text === 'string') {
      lines.push(obj.text);
      return;
    }
    if (Array.isArray(obj.content)) {
      const before = lines.length;
      for (const child of obj.content) walk(child);
      // Treat block-level nodes as paragraph breaks. We don't try to
      // recreate exact formatting; consumers only need the gist.
      const isBlock = obj.type !== undefined && obj.type !== 'text' && obj.type !== 'doc';
      if (isBlock && lines.length > before) {
        lines.push('\n');
      }
    }
  };
  walk(description);
  return lines.join('').replace(/\n{3,}/g, '\n\n').trim();
}
