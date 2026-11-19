/**
 * Wrong-map guard: a ticket that names another map's repo. One map plans
 * one repo (#421), so a node whose `Repo:` line or title prefix names a
 * repo that a different map plans was almost always filed in the wrong
 * map (19.11.2026: four claude-fleet tickets in the MindBlown map, the
 * fleet cloned mindblown for them).
 *
 * Strong signals only. Running text ("like claude-fleet #98") never
 * counts: tickets mention neighbouring repos as context all the time.
 */

/** Holds a ticket out of the pull queue until it is moved or a person confirms it belongs here. */
export const MISFILED_TAG = 'misfiled?';

/** A repo a node names: `owner/name`, or a bare name (owner null). */
export interface NamedRepo {
  owner: string | null;
  name: string;
}

export interface RepoBinding {
  owner: string;
  name: string;
}

/** A map the reporter can see, with the repo it plans (null = unbound). */
export interface MapRepoCandidate {
  id: string;
  name: string;
  repo: RepoBinding | null;
}

/** The answer create_node and plan_lint give: the repo named and the map that plans it. */
export interface MisfiledRepo {
  /** `owner/name` of the repo the node names. */
  repo: string;
  suggestedMapId: string;
  suggestedMapName: string;
}

const NAME = /^[A-Za-z0-9_.-]+$/;

/** Plain text of a description with one line per paragraph AND per hard break. */
function descriptionLines(description: unknown): string[] {
  if (description == null) return [];
  if (typeof description === 'string') return description.split(/\r?\n/);
  if (typeof description !== 'object') return [];
  let text = '';
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const obj = node as { type?: string; text?: unknown; content?: unknown };
    if (obj.type === 'text' && typeof obj.text === 'string') {
      text += obj.text;
      return;
    }
    if (obj.type === 'hardBreak') {
      text += '\n';
      return;
    }
    if (Array.isArray(obj.content)) {
      for (const child of obj.content) walk(child);
      if (obj.type !== undefined && obj.type !== 'doc') text += '\n';
    }
  };
  walk(description);
  return text.split('\n');
}

/** A repo from a `Repo:` value: a forge URL, `owner/name`, or a bare name. */
export function parseRepoRef(raw: string): NamedRepo | null {
  let v = raw.trim();
  // A markdown link: the target is the repo.
  const link = /\]\(([^)\s]+)\)/.exec(v);
  if (link) v = link[1];
  v = v.replace(/^[`<*_"']+/, '').split(/[\s`>*"']/)[0].replace(/[.,;:)]+$/, '');
  if (!v) return null;
  const url = /^(?:https?:\/\/)?(?:www\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d+)?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(v);
  if (url) return { owner: url[1], name: url[2] };
  const pair = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(v);
  if (pair) return { owner: pair[1], name: pair[2] };
  return NAME.test(v) && /[A-Za-z]/.test(v) ? { owner: null, name: v } : null;
}

// `Repo: x`, `**Repo:** x`, `- Repo: x`, `Repository: x`.
const REPO_LINE = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?\s*repo(?:sitory)?\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.+)$/i;

// Title prefixes: `<repo>: …`, `<repo> (…) …`, `(<repo>) …`, `<component> (<repo>): …`.
const TITLE_PATTERNS = [
  /^\s*([A-Za-z0-9_.\-/]+):\s/,
  /^\s*([A-Za-z0-9_.\-/]+)\s+\(/,
  /^\s*\(([A-Za-z0-9_.\-/]+)\)/,
  /^\s*[^():]+?\s\(([A-Za-z0-9_.\-/]+)\)\s*:/,
];

/** Every repo a node names through a strong signal (a `Repo:` line or a title prefix). */
export function namedRepos(node: { text: string; description?: unknown }): NamedRepo[] {
  const out: NamedRepo[] = [];
  for (const line of descriptionLines(node.description)) {
    const m = REPO_LINE.exec(line);
    const ref = m ? parseRepoRef(m[1]) : null;
    if (ref) out.push(ref);
  }
  for (const re of TITLE_PATTERNS) {
    const m = re.exec(node.text ?? '');
    const ref = m ? parseRepoRef(m[1]) : null;
    if (ref) out.push(ref);
  }
  return out;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function names(ref: NamedRepo, repo: RepoBinding): boolean {
  return same(ref.name, repo.name) && (ref.owner === null || same(ref.owner, repo.owner));
}

/**
 * Whether a node is filed in the wrong map: it names a repo that another
 * map plans, and its own map plans a different one. null when the node
 * names no repo, names its own map's repo, its own map is unbound, or no
 * other bound map plans the repo.
 */
export function findMisfiledRepo(
  node: { text: string; description?: unknown },
  ownRepo: RepoBinding | null,
  maps: MapRepoCandidate[],
): MisfiledRepo | null {
  if (!ownRepo) return null;
  const named = namedRepos(node);
  if (named.length === 0) return null;
  if (named.some((r) => names(r, ownRepo))) return null;
  for (const ref of named) {
    const hit = maps.find(
      (m) => m.repo !== null && names(ref, m.repo) && !(same(m.repo.owner, ownRepo.owner) && same(m.repo.name, ownRepo.name)),
    );
    if (hit && hit.repo) {
      return { repo: `${hit.repo.owner}/${hit.repo.name}`, suggestedMapId: hit.id, suggestedMapName: hit.name };
    }
  }
  return null;
}

/** The line create_node's tool output carries for a misfiled ticket. */
export function misfiledHint(m: MisfiledRepo): string {
  return `This names ${m.repo}, which map ${m.suggestedMapName} plans — move it with move_node_to_map (toMapId: ${m.suggestedMapId}). The fleet holds it (tag ${MISFILED_TAG}) until it is moved or the tag is removed.`;
}
