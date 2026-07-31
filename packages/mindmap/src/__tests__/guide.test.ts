import { describe, it, expect } from 'vitest';
import type { Node } from '@mindblown/core';
import {
  EXPAND_ALL_LIMIT,
  ROOT_CHAPTER_ID,
  buildGuideEntries,
  filterGuideChapters,
  groupGuideEntries,
  guideMarker,
  initialExpandedChapters,
  type GuideEntry,
} from '../guide.js';

/**
 * The Anwenderansicht's derivation. Three promises are load-bearing and are
 * what these tests pin:
 *
 * 1. **Unbuilt criteria never disappear.** They dim; they do not vanish. A
 *    view that silently drops half the register is worse than one that
 *    admits a gap.
 * 2. **Unvalidated URLs never become an href.** Both URL fields are
 *    free-text columns, and this view renders one of them into a `<video
 *    src>` — a place where a bad value is not merely a dead link.
 * 3. **The rail stays scannable at 168 criteria.** That is the size the
 *    view exists for, and the size the mock could not show.
 */

let seq = 0;

/** Minimal Node; only the fields the derivation reads are meaningful. */
function node(v: Partial<Node>): Node {
  return {
    id: `n${seq++}`,
    text: 'untitled',
    parentId: null,
    childrenIds: [],
    requirementId: null,
    requirementText: null,
    description: null,
    percentComplete: null,
    verificationText: null,
    verificationUrl: null,
    verificationVideoUrl: null,
    ...v,
  } as Node;
}

function mapOf(...list: Node[]): Record<string, Node> {
  return Object.fromEntries(list.map((n) => [n.id, n]));
}

/** Leaves report their own percentComplete; nothing here needs a rollup. */
const leafProgress = (n: Node) => n.percentComplete ?? 0;

describe('buildGuideEntries', () => {
  it('takes only nodes carrying a requirementId', () => {
    const req = node({ requirementId: 'PEN-01', text: 'Aufgaben erstellen' });
    const plain = node({ text: 'irgendeine Teilaufgabe' });
    const entries = buildGuideEntries(mapOf(req, plain), leafProgress);
    expect(entries.map((e) => e.requirementId)).toEqual(['PEN-01']);
  });

  it('uses the parent node as the chapter, and falls back for a parentless one', () => {
    const chapter = node({ id: 'c1', text: 'Pendenzen' });
    const req = node({ requirementId: 'PEN-01', parentId: 'c1' });
    const orphan = node({ requirementId: 'ZZZ-01' });
    const byId = new Map(
      buildGuideEntries(mapOf(chapter, req, orphan), leafProgress).map((e) => [
        e.requirementId,
        e,
      ]),
    );
    expect(byId.get('PEN-01')!.chapterId).toBe('c1');
    expect(byId.get('PEN-01')!.chapterText).toBe('Pendenzen');
    expect(byId.get('ZZZ-01')!.chapterId).toBe(ROOT_CHAPTER_ID);
  });

  it('prefers the business phrasing over the node text', () => {
    // requirementText is what the register shows and what the Word export
    // prints; the node text can be a GitHub-synced issue title.
    const [e] = buildGuideEntries(
      mapOf(
        node({
          requirementId: 'MAN-01',
          text: 'feat(mandates): onboarding wizard',
          requirementText: 'Ein Mandat über den geführten Onboarding-Prozess eröffnen',
        }),
      ),
      leafProgress,
    );
    expect(e.title).toBe('Ein Mandat über den geführten Onboarding-Prozess eröffnen');
  });

  describe('availability', () => {
    it('is progress-only, and an unbuilt criterion is still returned', () => {
      // The promise: not-yet-built dims the row, it never removes it.
      const entries = buildGuideEntries(
        mapOf(
          node({ requirementId: 'A-01', percentComplete: 100 }),
          node({ requirementId: 'A-02', percentComplete: 40 }),
          node({ requirementId: 'A-03', percentComplete: null }),
        ),
        leafProgress,
      );
      expect(entries.map((e) => [e.requirementId, e.available])).toEqual([
        ['A-01', true],
        ['A-02', false],
        ['A-03', false],
      ]);
    });

    it('reads the rollup for a parent rather than its own percentComplete', () => {
      // A requirement with work underneath it is judged by what merged
      // below, exactly as the register judges "Built".
      const parent = node({ requirementId: 'P-01', childrenIds: ['x'], percentComplete: 0 });
      const [e] = buildGuideEntries(mapOf(parent), (n) =>
        n.childrenIds.length === 0 ? (n.percentComplete ?? 0) : 100,
      );
      expect(e.available).toBe(true);
    });
  });

  describe('URL handling', () => {
    it('drops URLs that are not absolute http(s)', () => {
      // This is the guard that keeps a javascript: payload out of an href —
      // and, for the video field, out of a <video src>.
      const [e] = buildGuideEntries(
        mapOf(
          node({
            requirementId: 'X-01',
            verificationUrl: 'javascript:alert(1)',
            verificationVideoUrl: '/relative/clip.mp4',
          }),
        ),
        leafProgress,
      );
      expect(e.appUrl).toBeNull();
      expect(e.videoUrl).toBeNull();
      // The raw values stay reachable for anything that wants to show them
      // as text; only the render-ready fields are cleared.
      expect(e.verification?.url).toBe('javascript:alert(1)');
    });

    it('keeps absolute http(s) URLs', () => {
      const [e] = buildGuideEntries(
        mapOf(
          node({
            requirementId: 'X-02',
            verificationUrl: 'https://staging.example.com/mandates',
            verificationVideoUrl: 'https://v.example.com/clip.mp4',
          }),
        ),
        leafProgress,
      );
      expect(e.appUrl).toBe('https://staging.example.com/mandates');
      expect(e.videoUrl).toBe('https://v.example.com/clip.mp4');
    });
  });

  describe('lede', () => {
    it('renders a ProseMirror description down to its first non-empty line', () => {
      const description = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Worum es geht.' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Ein zweiter Absatz.' }] },
        ],
      };
      const [e] = buildGuideEntries(
        mapOf(node({ requirementId: 'L-01', description: description as never })),
        leafProgress,
      );
      expect(e.lede).toBe('Worum es geht.');
    });

    it('is null when there is no description', () => {
      const [e] = buildGuideEntries(mapOf(node({ requirementId: 'L-02' })), leafProgress);
      expect(e.lede).toBeNull();
    });
  });
});

describe('guideMarker', () => {
  const entry = (v: Partial<GuideEntry>): GuideEntry =>
    ({ guideText: null, videoUrl: null, ...v }) as GuideEntry;

  it('reports a video only when the URL survived validation', () => {
    expect(guideMarker(entry({ videoUrl: 'https://v.example.com/a.mp4' }))).toBe('video');
    expect(guideMarker(entry({ guideText: '1. Einloggen' }))).toBe('guide');
    expect(guideMarker(entry({}))).toBe('none');
  });

  it('reports the video state even when both are present', () => {
    expect(
      guideMarker(entry({ guideText: '1. Einloggen', videoUrl: 'https://v.example.com/a.mp4' })),
    ).toBe('video');
  });
});

describe('groupGuideEntries', () => {
  it('orders chapters by the map, criteria by REQ-ID, numerically', () => {
    // "MAN-10" must not sort between MAN-1 and MAN-2 — the register sorts
    // numerically and the two views have to agree.
    const c1 = node({ id: 'c1', text: 'Pendenzen' });
    const c2 = node({ id: 'c2', text: 'Mandate' });
    const entries = buildGuideEntries(
      mapOf(
        c1,
        c2,
        node({ requirementId: 'MAN-10', parentId: 'c2' }),
        node({ requirementId: 'MAN-2', parentId: 'c2' }),
        node({ requirementId: 'PEN-01', parentId: 'c1' }),
      ),
      leafProgress,
    );
    // Chapter rank says Mandate comes first, even though Pendenzen holds
    // the alphabetically earlier chapter name.
    const rank = (id: string) => ({ c2: 0, c1: 1 })[id] ?? Infinity;
    const grouped = groupGuideEntries(entries, rank);
    expect(grouped.map((c) => c.text)).toEqual(['Mandate', 'Pendenzen']);
    expect(grouped[0].entries.map((e) => e.requirementId)).toEqual(['MAN-2', 'MAN-10']);
  });

  it('sinks a chapter the rank function does not know instead of throwing', () => {
    const entries = buildGuideEntries(
      mapOf(node({ id: 'c1', text: 'Known' }), node({ requirementId: 'A-01', parentId: 'c1' })),
      leafProgress,
    );
    expect(() => groupGuideEntries(entries, () => Infinity)).not.toThrow();
  });
});

describe('filterGuideChapters', () => {
  const chapters = () => {
    const c1 = node({ id: 'c1', text: 'Pendenzen' });
    const c2 = node({ id: 'c2', text: 'Mandate' });
    const entries = buildGuideEntries(
      mapOf(
        c1,
        c2,
        node({ requirementId: 'PEN-01', parentId: 'c1', text: 'Aufgaben erstellen' }),
        node({ requirementId: 'PEN-02', parentId: 'c1', text: 'Erinnerungen versenden' }),
        node({ requirementId: 'MAN-01', parentId: 'c2', text: 'Mandat eröffnen' }),
      ),
      leafProgress,
    );
    return groupGuideEntries(entries, (id) => ({ c1: 0, c2: 1 })[id] ?? Infinity);
  };

  it('returns everything for an empty or whitespace query', () => {
    expect(filterGuideChapters(chapters(), '')).toHaveLength(2);
    expect(filterGuideChapters(chapters(), '   ')).toHaveLength(2);
  });

  it('matches the Kürzel and the title, case-insensitively', () => {
    const byId = filterGuideChapters(chapters(), 'pen-02');
    expect(byId.flatMap((c) => c.entries.map((e) => e.requirementId))).toEqual(['PEN-02']);
    const byTitle = filterGuideChapters(chapters(), 'ERINNERUNG');
    expect(byTitle.flatMap((c) => c.entries.map((e) => e.requirementId))).toEqual(['PEN-02']);
  });

  it('keeps a whole chapter when the chapter name is what matched', () => {
    // Typing a chapter name is the fastest route to it with 22 of them, and
    // a chapter answering that with 1 of its 2 rows reads as a broken
    // filter rather than a narrowed one.
    const result = filterGuideChapters(chapters(), 'Pendenzen');
    expect(result).toHaveLength(1);
    expect(result[0].entries.map((e) => e.requirementId)).toEqual(['PEN-01', 'PEN-02']);
  });

  it('drops chapters that keep nothing', () => {
    expect(filterGuideChapters(chapters(), 'zzz')).toEqual([]);
  });
});

describe('initialExpandedChapters', () => {
  /** `count` criteria spread over `chapterCount` chapters. */
  const build = (chapterCount: number, perChapter: number) => {
    const nodes: Node[] = [];
    for (let c = 0; c < chapterCount; c++) {
      nodes.push(node({ id: `c${c}`, text: `Kapitel ${c}` }));
      for (let i = 0; i < perChapter; i++) {
        nodes.push(node({ requirementId: `K${c}-${i}`, parentId: `c${c}` }));
      }
    }
    const entries = buildGuideEntries(mapOf(...nodes), leafProgress);
    return groupGuideEntries(entries, (id) => Number(id.slice(1)));
  };

  it('unfolds everything on a small map', () => {
    const chapters = build(2, 3); // 6 criteria
    expect(initialExpandedChapters(chapters, null).size).toBe(2);
  });

  it('unfolds only the selected chapter once the map is large', () => {
    // The case the view exists for: 22 chapters × ~8 = 176 criteria. All
    // unfolded, the rail is a wall; folded, it is a table of contents.
    const chapters = build(22, 8);
    expect(chapters.reduce((n, c) => n + c.entries.length, 0)).toBeGreaterThan(EXPAND_ALL_LIMIT);
    expect([...initialExpandedChapters(chapters, 'c7')]).toEqual(['c7']);
  });

  it('falls back to the first chapter when nothing is selected', () => {
    expect([...initialExpandedChapters(build(22, 8), null)]).toEqual(['c0']);
  });

  it('falls back to the first chapter when the selection is stale', () => {
    // A shared link naming a deleted node must not open a rail with every
    // chapter folded and no way in.
    expect([...initialExpandedChapters(build(22, 8), 'gone')]).toEqual(['c0']);
  });

  it('returns an empty set for a map with no chapters', () => {
    expect(initialExpandedChapters([], null).size).toBe(0);
  });
});
