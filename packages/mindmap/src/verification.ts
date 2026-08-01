/**
 * The Prüf-felder's data rules: which of the three review-surface fields
 * are set, and which URLs are safe to render as a link.
 *
 * Two callers, two questions. `guide.ts` builds the Prüfanleitungen view
 * out of these; the register uses `verificationOf` only to decide whether a
 * row carries documentation at all, and so earns the marker that jumps
 * over there.
 *
 * Kept out of the component modules so it can be unit-tested without
 * dragging in the zustand store, which they create at import time — same
 * reason ghLinkStyle.ts lives on its own.
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

/** null when the requirement carries none of the three — the register row then shows no marker. */
export function verificationOf(node: Node): Verification | null {
  const text = node.verificationText?.trim() || null;
  const url = node.verificationUrl?.trim() || null;
  const videoUrl = node.verificationVideoUrl?.trim() || null;
  if (text == null && url == null && videoUrl == null) return null;
  return { text, url, videoUrl };
}

/**
 * Whether the criterion carries something that answers *how do I check
 * this* — the written steps or the clip. Drives the register's marker.
 *
 * A bare `verificationUrl` deliberately does not count. It answers "where",
 * not "how", and it is the one part of the Prüf-felder the register should
 * not advertise: a link out of the application is an invitation to leave
 * the view its reader is standing in. It belongs on the Prüfanleitung,
 * where the reader has already decided to go and check.
 */
export function isDocumented(node: Node): boolean {
  const v = verificationOf(node);
  return v != null && (v.text != null || v.videoUrl != null);
}

/**
 * True only for absolute `http:`/`https:` URLs.
 *
 * `verificationUrl` / `verificationVideoUrl` are free-text columns with no
 * server-side validation, and the Prüfanleitung is the only place in the
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
