// @vitest-environment jsdom
/**
 * The mindmap's Depth limit stays on the mindmap.
 *
 * History: the default Depth went 1 → 3 (#53) → 1 again in an unrelated,
 * unreviewed commit (f64bd90), and every view built on getVisibleNodes()
 * inherited it silently — List showed one level on every map load (#641),
 * Calendar dropped dated tasks below level 1. These tests make both kinds
 * of drift fail CI instead of reaching a user.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_DEPTH, useMindmapStore } from '../store.js';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === '__harness__' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('mindmap Depth limit', () => {
  it('the default Depth is a deliberate value — change it here on purpose, with the reason', () => {
    // 1 works only because the "+N" pill drills in on click (#640) and no
    // other view reads maxDepth. Raising or lowering it is a product call:
    // update this test, the DEFAULT_MAX_DEPTH comment, and say why in the PR.
    expect(DEFAULT_MAX_DEPTH).toBe(1);
    expect(useMindmapStore.getState().maxDepth).toBe(DEFAULT_MAX_DEPTH);
  });

  it('only the mindmap editor opts into the Depth limit', () => {
    const optIns = sourceFiles(SRC)
      .filter((f) => /respectDepth:\s*true/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1));
    expect(optIns).toEqual(['MindmapEditor.tsx']);
  });

  it('no view other than the mindmap editor reads maxDepth', () => {
    const readers = sourceFiles(SRC)
      .filter((f) => !f.endsWith('store.ts'))
      // `s.maxDepth`, `getState().maxDepth`, `{ maxDepth } = useMindmapStore…`
      .filter((f) => /\.maxDepth\b|\{[^}]*\bmaxDepth\b[^}]*\}\s*=\s*(useMindmapStore|get)/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1))
      .sort();
    // useUrlState mirrors it into the URL (?depth=) — that IS the mindmap's state.
    expect(readers).toEqual(['MindmapEditor.tsx', 'useUrlState.ts']);
  });
});
