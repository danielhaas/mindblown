/**
 * The Anwenderansicht's data rules: which requirements it shows, how they
 * group into chapters, what the left rail's marker means, and how a search
 * query narrows the list.
 *
 * Kept out of GuideView.tsx for the same reason verification.ts is kept out
 * of RequirementsView.tsx — the component module builds the zustand store at
 * import time, so none of this would be reachable from a unit test.
 *
 * The view answers one question per requirement: *how do I check this
 * myself?* That is a different job from the register's, so the derivation
 * here is deliberately narrower — no acceptance verdicts, no release
 * filter, no remaining effort. Only what a reader needs to follow steps.
 */

import { BUILT_THRESHOLD, proseMirrorToPlainText } from '@mindblown/core';
import type { Node } from '@mindblown/core';
import { isHttpUrl, verificationOf, type Verification } from './verification.js';

/** Chapter key for requirements that hang straight off the root. */
export const ROOT_CHAPTER_ID = '(root)';

/**
 * One criterion, flattened to exactly what the two panes render.
 *
 * `appUrl` / `videoUrl` are pre-validated rather than raw: both come from
 * free-text columns, and a caller that forgets `isHttpUrl` would hand a
 * `javascript:` payload an href — the same trap the Abnahme card guards
 * against. Storing them already-checked means the component cannot get it
 * wrong, and `null` doubles as "don't render this part".
 */
export interface GuideEntry {
  node: Node;
  requirementId: string;
  /** Business phrasing when one is set, else the node's own text. */
  title: string;
  chapterId: string;
  chapterText: string;
  /** First non-empty line of the description, plain text. null when unset. */
  lede: string | null;
  verification: Verification | null;
  /** The Prüfanleitung markdown, or null when nobody has written one. */
  guideText: string | null;
  /** Validated http(s) deep link into the running application. */
  appUrl: string | null;
  /** Validated http(s) link to the demo clip. */
  videoUrl: string | null;
  /**
   * Whether the feature exists yet. Progress-only, exactly like the
   * register's "Built" — deliberately NOT the sign-off stage: a reader
   * asking "how do I check this?" cares whether the screen is there, not
   * whether two gatekeepers have countersigned it.
   */
  available: boolean;
}

export interface GuideChapter {
  id: string;
  text: string;
  entries: GuideEntry[];
}

/**
 * The one marker the left rail carries per row.
 *
 * The mock called it "video vorhanden", and against today's data that
 * would be a dead column — `verificationVideoUrl` is empty on every
 * requirement, so all 168 rows would show the same empty ring. Folding the
 * written Anleitung into the same slot keeps one marker that actually
 * varies now and still gains a distinct state the day clips land.
 */
export type GuideMarker = 'video' | 'guide' | 'none';

export function guideMarker(entry: GuideEntry): GuideMarker {
  if (entry.videoUrl != null) return 'video';
  if (entry.guideText != null) return 'guide';
  return 'none';
}

/**
 * Above this many criteria the rail opens with only the selected chapter
 * unfolded. 22 chapter headers fit on one screen; 168 rows do not, and a
 * reader who has to scroll past six chapters to find the seventh has lost
 * the overview the view exists to give. Below it, folding is pure friction
 * — a five-requirement map should just show its five requirements.
 */
export const EXPAND_ALL_LIMIT = 25;

/**
 * Flatten the store's node map into criteria.
 *
 * `progressOf` is injected rather than read from `computed` here so the
 * rollup rule (leaf → own percentComplete, parent → computed) stays with
 * the component that owns the store subscription, and so a test can state
 * a progress value without building a ComputedNodeValues map.
 */
export function buildGuideEntries(
  nodes: Record<string, Node>,
  progressOf: (node: Node) => number,
): GuideEntry[] {
  const entries: GuideEntry[] = [];
  for (const node of Object.values(nodes)) {
    if (node.requirementId == null) continue;
    const chapter = node.parentId ? nodes[node.parentId] : undefined;
    const verification = verificationOf(node);
    // The description is ProseMirror JSON (older rows: a raw string). Only
    // its first non-empty line is used — the field is a free-form note, and
    // an essay pasted into it must not push the steps below the fold.
    const lede =
      proseMirrorToPlainText(node.description)
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line !== '') ?? null;
    entries.push({
      node,
      requirementId: node.requirementId,
      title: node.requirementText ?? node.text,
      chapterId: chapter?.id ?? ROOT_CHAPTER_ID,
      chapterText: chapter?.text ?? ROOT_CHAPTER_ID,
      lede: lede === '' ? null : lede,
      verification,
      guideText: verification?.text ?? null,
      appUrl: isHttpUrl(verification?.url) ? (verification?.url ?? null) : null,
      videoUrl: isHttpUrl(verification?.videoUrl) ? (verification?.videoUrl ?? null) : null,
      available: progressOf(node) >= BUILT_THRESHOLD,
    });
  }
  return entries;
}

/** REQ-ID order, numeric-aware so MAN-9 sorts before MAN-10. */
export function compareGuideEntries(a: GuideEntry, b: GuideEntry): number {
  return a.requirementId.localeCompare(b.requirementId, undefined, { numeric: true });
}

/**
 * Group into chapters, chapters in map order and criteria in REQ-ID order
 * — the same two rules the register uses, so a reader who knows one view's
 * ordering already knows the other's.
 *
 * `chapterRank` is the caller's depth-first index of the node tree; a
 * chapter it doesn't know sinks to the end rather than throwing.
 */
export function groupGuideEntries(
  entries: GuideEntry[],
  chapterRank: (chapterId: string) => number,
): GuideChapter[] {
  const byChapter = new Map<string, GuideChapter>();
  for (const entry of [...entries].sort(compareGuideEntries)) {
    let chapter = byChapter.get(entry.chapterId);
    if (!chapter) {
      chapter = { id: entry.chapterId, text: entry.chapterText, entries: [] };
      byChapter.set(entry.chapterId, chapter);
    }
    chapter.entries.push(entry);
  }
  return [...byChapter.values()].sort((a, b) => chapterRank(a.id) - chapterRank(b.id));
}

/** Case-insensitive substring match on REQ-ID, title and chapter name. */
export function matchesGuideQuery(entry: GuideEntry, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (q === '') return true;
  return (
    entry.requirementId.toLowerCase().includes(q) ||
    entry.title.toLowerCase().includes(q) ||
    entry.chapterText.toLowerCase().includes(q)
  );
}

/**
 * Narrow the grouped list to a search query, dropping chapters that keep
 * nothing.
 *
 * Note that a query matching a *chapter name* keeps every criterion under
 * it — not as a special case here, but because `matchesGuideQuery` scores
 * each entry against its own chapter name. With 22 chapters, typing a
 * chapter name is the fastest way to reach one, and a chapter that
 * answered that with three of its twelve rows would read as a broken
 * filter rather than a narrowed one.
 */
export function filterGuideChapters(chapters: GuideChapter[], query: string): GuideChapter[] {
  const q = query.trim().toLowerCase();
  if (q === '') return chapters;
  const out: GuideChapter[] = [];
  for (const chapter of chapters) {
    const entries = chapter.entries.filter((e) => matchesGuideQuery(e, q));
    if (entries.length > 0) out.push({ ...chapter, entries });
  }
  return out;
}

/**
 * Which chapters the rail starts with unfolded.
 *
 * Small map: everything, because folding would only hide what already fit.
 * Large map: the selected chapter alone, falling back to the first one, so
 * the rail opens as a table of contents you can scan in a single glance.
 */
export function initialExpandedChapters(
  chapters: GuideChapter[],
  selectedChapterId: string | null,
): Set<string> {
  const total = chapters.reduce((n, c) => n + c.entries.length, 0);
  if (total <= EXPAND_ALL_LIMIT) return new Set(chapters.map((c) => c.id));
  const selected =
    selectedChapterId != null && chapters.some((c) => c.id === selectedChapterId)
      ? selectedChapterId
      : chapters[0]?.id;
  return selected == null ? new Set() : new Set([selected]);
}
