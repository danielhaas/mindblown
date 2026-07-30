/**
 * The Abnahme card's data rules: which of the three review-surface fields
 * are set, and which URLs are safe to render as a link.
 *
 * Kept out of RequirementsView.tsx so it can be unit-tested without
 * dragging in the zustand store, which the component module creates at
 * import time — same reason ghLinkStyle.ts lives on its own.
 */

import type { Node } from '@mindblown/core';

/**
 * The three review-surface fields a non-technical reviewer needs before
 * pressing ✓ or ✗: how to check it, where to check it, and the demo video.
 * Whitespace-only counts as unset — the property panel writes `null` on
 * clear, but older rows can still carry a stray space.
 */
export interface Verification {
  text: string | null;
  url: string | null;
  videoUrl: string | null;
}

/** null when the requirement carries none of the three — the row then looks exactly as before. */
export function verificationOf(node: Node): Verification | null {
  const text = node.verificationText?.trim() || null;
  const url = node.verificationUrl?.trim() || null;
  const videoUrl = node.verificationVideoUrl?.trim() || null;
  if (text == null && url == null && videoUrl == null) return null;
  return { text, url, videoUrl };
}

/**
 * True only for absolute `http:`/`https:` URLs.
 *
 * `verificationUrl` / `verificationVideoUrl` are free-text columns with no
 * server-side validation, and the Abnahme card is the first place in the
 * product that renders them as an `href`. Anything else — `javascript:`,
 * `data:`, `vbscript:`, a bare relative path — is refused, and the caller
 * drops the button rather than emitting a dead or dangerous link.
 *
 * Parsed with the URL constructor rather than a prefix check on purpose:
 * the parser strips the tabs and newlines that make `java\nscript:alert(1)`
 * work in a browser but slip past a naive `startsWith('javascript:')`.
 */
export function isHttpUrl(url: string | null | undefined): boolean {
  if (url == null) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    // Not an absolute URL at all (relative path, empty, malformed).
    return false;
  }
}
