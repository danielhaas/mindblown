/**
 * Description mirror-vs-curation semantics, in ONE place.
 *
 * `node.description` has two legitimate writers: the GitHub issue body
 * (machine mirror — written at ingest-create and on inbound body
 * edits) and manual curation in MindBlown (business/audit notes). The
 * decision "may an inbound body edit overwrite this description?" is
 * made here; every path that writes a mirrored body must stamp
 * `link.descriptionMirrorHash` via `stampMirrorHash` so the decision
 * stays sound.
 *
 * Why a stored hash instead of comparing against GitHub's prior body:
 * outbound sync pushes curated text INTO the GH body, after which
 * "node.description === GH body" is true for curated nodes too — a
 * GH-side comparison would misread the curation as a mirror and let
 * the next body edit wipe it. The hash tracks what the MIRROR wrote,
 * which is the only thing an inbound edit may overwrite. It also makes
 * mirror drift self-healing: a missed webhook leaves the node on an
 * older mirror body whose hash still matches, so the next edit
 * re-syncs instead of freezing.
 *
 * Ownership lifecycle:
 *   - Curation is one-way by WRITING: any non-mirror description write
 *     (agent note, UI edit) stops inbound mirroring for that node.
 *   - Resuming is one-way by BLANKING: clearing the description makes
 *     the next inbound body edit refill it (the empty rule below) —
 *     that IS the deliberate "hand it back to GitHub" gesture; no
 *     separate flag exists.
 *   - Legacy links (pre-hash) migrate lazily via the prior-body
 *     fallback. One bounded one-time window remains for them: a
 *     curated STRING description that outbound sync pushed to the GH
 *     body BEFORE the hash deploy reads as a mirror on its first
 *     inbound edit (from === curated text) and loses the curation
 *     once — afterwards the stamp exists and the loss cannot recur.
 *     Unresolvable without history; accepted and documented here.
 */

import { createHash } from 'node:crypto';
import type { ExternalLink } from '@mindblown/core';

/** Canonical hash of an issue body as written by the mirror path. */
export function computeBodyHash(body: string | null | undefined): string {
  return createHash('sha256').update(body ?? '', 'utf8').digest('hex');
}

/**
 * May an inbound body edit overwrite this description?
 *
 *   - empty/null description → yes (nothing to protect).
 *   - link carries a mirror hash → yes iff the description is the
 *     string the mirror last wrote (hash match). Curated text — even
 *     text that outbound sync has since pushed to the GH body — never
 *     matches, so curation is sticky.
 *   - legacy link (no hash) → fall back to equality with the pre-edit
 *     GH body (`priorBody`, from the webhook's `changes.body.from`):
 *     an untouched mirror still equals it. The caller stamps the hash
 *     on the first applied edit, migrating the link lazily.
 */
export function isMirrorDescription(
  description: unknown,
  link: Pick<ExternalLink, 'descriptionMirrorHash'>,
  priorBody: string | null,
): boolean {
  if (description == null || description === '') return true;
  if (typeof description !== 'string') return false;
  if (link.descriptionMirrorHash) {
    return computeBodyHash(description) === link.descriptionMirrorHash;
  }
  return priorBody != null && description === priorBody;
}

/** Return a copy of `link` stamped for the body the mirror just wrote. */
export function stampMirrorHash(link: ExternalLink, body: string | null | undefined): ExternalLink {
  return { ...link, descriptionMirrorHash: computeBodyHash(body) };
}
