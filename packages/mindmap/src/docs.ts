/**
 * Pure helpers for the Docs tab (#550): where a link inside a doc points,
 * how the file list groups, and the heading ids `#anchor` links land on.
 */

export interface DocEntry {
  path: string;
  sha: string;
  size: number;
}

export interface DocGroup {
  /** Directory, '' for the repo root. */
  dir: string;
  docs: DocEntry[];
}

/** `docs/a.md` → `a.md`. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dirName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

const isReadme = (path: string) => /^readme\.(md|markdown)$/i.test(baseName(path));

/**
 * Group by directory — root first, then directories alphabetically; a
 * README leads its directory, the rest follow by name.
 */
export function groupDocs(docs: DocEntry[]): DocGroup[] {
  const byDir = new Map<string, DocEntry[]>();
  for (const d of docs) {
    const dir = dirName(d.path);
    const list = byDir.get(dir) ?? [];
    list.push(d);
    byDir.set(dir, list);
  }
  return [...byDir.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([dir, list]) => ({
      dir,
      docs: list.sort((a, b) => Number(isReadme(b.path)) - Number(isReadme(a.path)) || a.path.localeCompare(b.path)),
    }));
}

/** Case-insensitive substring over the path. */
export function filterDocs(docs: DocEntry[], query: string): DocEntry[] {
  const q = query.trim().toLowerCase();
  return q ? docs.filter((d) => d.path.toLowerCase().includes(q)) : docs;
}

/** The doc to open first: the root README, else the first doc listed. */
export function defaultDoc(docs: DocEntry[]): string | null {
  return docs.find((d) => !d.path.includes('/') && isReadme(d.path))?.path ?? groupDocs(docs)[0]?.docs[0]?.path ?? null;
}

export interface ResolvedLink {
  /** Repo-relative path, normalised. */
  path: string;
  /** Fragment without '#', or null. */
  hash: string | null;
}

/**
 * Where a relative `href` in the doc at `fromPath` points inside the repo,
 * or null for anything that leaves it (a scheme, `//host`, a bare `#hash`,
 * or `..` above the root). A leading `/` is the repo root, as on GitHub.
 */
export function resolveRepoLink(fromPath: string, href: string): ResolvedLink | null {
  if (!href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const hashAt = href.indexOf('#');
  const hash = hashAt >= 0 ? href.slice(hashAt + 1) || null : null;
  let target = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const queryAt = target.indexOf('?');
  if (queryAt >= 0) target = target.slice(0, queryAt);
  if (!target) return null;
  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep it as written.
  }
  const parts = target.startsWith('/') ? [] : dirName(fromPath).split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.length ? { path: parts.join('/'), hash } : null;
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/**
 * The forge web URL of another file on the same branch, derived from the
 * open doc's own web URL (which ends in its encoded path) — so the view
 * needs no knowledge of GitHub's `blob/` vs Gitea's `src/branch/`.
 */
export function siblingWebUrl(docWebUrl: string, docPath: string, target: ResolvedLink): string | null {
  const own = encodePath(docPath);
  if (!docWebUrl.endsWith(own)) return null;
  return `${docWebUrl.slice(0, -own.length)}${encodePath(target.path)}${target.hash ? `#${target.hash}` : ''}`;
}

/** GitHub-style heading anchor: lowercase, punctuation dropped, spaces → '-'. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * GitHub's rule for repeated headings (github-slugger): the first `a`, then
 * `a-1`, `a-2`… One slugger per rendered doc.
 */
export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = headingSlug(text);
    let slug = base;
    while (seen.has(slug)) {
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      slug = `${base}-${n}`;
    }
    seen.set(slug, 0);
    return slug;
  };
}

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

/** The heading's rendered text, as GitHub slugs it: raw HTML (not rendered here) and image alt text don't count. */
function mdText(node: MdNode): string {
  if (node.type === 'html' || node.type === 'image') return '';
  if (typeof node.value === 'string') return node.value;
  return node.children?.map(mdText).join('') ?? '';
}

/** Remark plugin: every heading gets its GitHub anchor as `id`, duplicates numbered in document order. */
export function remarkHeadingIds() {
  return (tree: MdNode) => {
    const slug = createSlugger();
    const walk = (node: MdNode) => {
      if (node.type === 'heading') {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: slug(mdText(node)) } };
        return;
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

/**
 * The draft — LF only, a textarea yields nothing else — with the original
 * doc's line endings put back, so a PR changes only the lines edited.
 * Unchanged lines before and after the edited stretch keep their ending
 * exactly; inside it a line identical to an original one there takes that
 * one's ending, a new line the doc's majority ending.
 */
export function restoreLineEndings(original: string, draft: string): string {
  if (!original.includes('\r\n')) return draft;
  const orig = original.split('\n').map((seg, i, all) =>
    i === all.length - 1 ? { text: seg, eol: '' } : seg.endsWith('\r') ? { text: seg.slice(0, -1), eol: '\r\n' } : { text: seg, eol: '\n' },
  );
  const crlf = orig.filter((l) => l.eol === '\r\n').length;
  const majority = crlf * 2 >= orig.length - 1 ? '\r\n' : '\n';
  // Segment j of the draft is followed by eols[j]; the last one by nothing.
  const lines = draft.split('\n');
  const eols: string[] = new Array(lines.length - 1).fill(majority);
  let head = 0;
  while (head < lines.length - 1 && head < orig.length - 1 && lines[head] === orig[head].text) {
    eols[head] = orig[head].eol;
    head++;
  }
  // From the end: draft segment n-1-k pairs with original segment len-1-k.
  let tail = 0;
  while (tail < lines.length - head && tail < orig.length - head && lines[lines.length - 1 - tail] === orig[orig.length - 1 - tail].text) {
    const j = lines.length - 1 - tail;
    if (j < eols.length) eols[j] = orig[orig.length - 1 - tail].eol;
    tail++;
  }
  const pool = new Map<string, string[]>();
  for (const l of orig.slice(head, orig.length - tail)) {
    if (!l.eol) continue;
    pool.set(l.text, [...(pool.get(l.text) ?? []), l.eol]);
  }
  for (let j = head; j < lines.length - tail && j < eols.length; j++) {
    eols[j] = pool.get(lines[j])?.shift() ?? majority;
  }
  return lines.map((l, j) => l + (eols[j] ?? '')).join('');
}
