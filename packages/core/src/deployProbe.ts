/**
 * Merged, not live — for every project (follow-up to #645, which saw only
 * MindBlown's own checkout).
 *
 * A map's `deployProbe` is a URL that returns the commit its project runs
 * in production — JSON `{"commit": "<sha>"}` or the bare sha — or `none`
 * (nothing is deployed). The server reads it periodically and lists the
 * commits on the bound repo's default branch that the deployed one lacks.
 * A map in a fleet with a repo and no probe gets one setup question
 * ("how is <map> deployed?") until someone answers it.
 *
 * Pure: the server fetches (services/deployProbe.ts).
 */
import type { Ask } from './asks.js';

/** The probe value of a map that is not deployed anywhere. */
export const DEPLOY_PROBE_NONE = 'none';

/** Is this probe a URL to read (not unset, not `none`)? */
export function isProbeUrl(probe: string | null | undefined): probe is string {
  return typeof probe === 'string' && /^https?:\/\//i.test(probe);
}

/**
 * The value to store for what a person typed: a http(s) URL, `none`, or
 * null (empty = unset). Anything else is an error message.
 */
export function normalizeDeployProbe(v: unknown): { value: string | null } | { error: string } {
  if (v === null || v === undefined) return { value: null };
  if (typeof v !== 'string') return { error: 'deployProbe must be a URL, "none" or null' };
  const t = v.trim();
  if (!t) return { value: null };
  if (t.toLowerCase() === DEPLOY_PROBE_NONE) return { value: DEPLOY_PROBE_NONE };
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return { error: `deployProbe "${t}" is not a URL — give the address that returns the deployed commit, or "none"` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'deployProbe must be an http(s) URL or "none"' };
  return { value: url.toString() };
}

const SHA = /^[0-9a-f]{7,40}$/i;

/**
 * The deployed commit in a probe's response body: JSON with `commit` (or
 * `sha`), a JSON string, or the plain sha on the first line. Null when
 * there is none.
 */
export function parseProbeBody(body: string): string | null {
  const t = body.trim();
  if (!t) return null;
  if (t.startsWith('{') || t.startsWith('"')) {
    try {
      const j: unknown = JSON.parse(t);
      const v = typeof j === 'string' ? j : j && typeof j === 'object' ? ((j as Record<string, unknown>).commit ?? (j as Record<string, unknown>).sha) : null;
      return typeof v === 'string' && SHA.test(v.trim()) ? v.trim().toLowerCase() : null;
    } catch {
      return null;
    }
  }
  const first = t.split(/\s+/)[0];
  return SHA.test(first) ? first.toLowerCase() : null;
}

/** "2 merges not live on Navy for 19 h" — the waiting line and the mail line. */
export function notLiveLabel(count: number, mapName: string, since: string, now: Date): string {
  const h = Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / 3_600_000));
  const age = h < 1 ? 'under an hour' : h < 48 ? `${h} h` : `${Math.floor(h / 24)} days`;
  return `${count} ${count === 1 ? 'merge' : 'merges'} not live on ${mapName} for ${age}`;
}

// ── The setup question ─────────────────────────────────────────

export const DEPLOY_PROBE_ASK_PREFIX = 'deploy-probe-';
export const DEPLOY_PROBE_ASK_OPTIONS = ['None — not deployed'] as const;

export function deployProbeAskId(mapId: string): string {
  return DEPLOY_PROBE_ASK_PREFIX + mapId;
}

/** The map a setup question is about, or null for any other ask id. */
export function deployProbeAskMapId(askId: string): string | null {
  return askId.startsWith(DEPLOY_PROBE_ASK_PREFIX) && askId.length > DEPLOY_PROBE_ASK_PREFIX.length ? askId.slice(DEPLOY_PROBE_ASK_PREFIX.length) : null;
}

/** "How is <map> deployed?" — asked of a map in a fleet with a repo and no probe. */
export function buildDeployProbeAsk(map: { id: string; name: string }, answerer: string): Ask {
  return {
    id: deployProbeAskId(map.id),
    map_id: map.id,
    ticket: null,
    requirement: null,
    title: `How is ${map.name} deployed?`,
    url: null,
    sources: ['mindblown-deploy'],
    question:
      `The fleet merges ${map.name}'s PRs, but nothing shows whether they are live. ` +
      'Add a deploy probe — a URL that returns the deployed commit (JSON {"commit": "<sha>"} or the plain sha, e.g. https://…/api/version) — or say none.',
    question_author: 'MindBlown',
    options: [...DEPLOY_PROBE_ASK_OPTIONS],
    answerer,
    hint: 'decision',
    priority: null,
    milestone: null,
    needs_version: false,
    idle_hours: null,
    unblocks: { node_id: null, node_title: null, node_status: null, claimed_by: null, worker: null, pr: null, pr_state: null },
    moot: false,
  };
}

/** The probe an answer sets: "none" / "no" / the option → none, a URL → it; null = not an answer this question takes. */
export function deployProbeFromAnswer(decision: string): string | null {
  const d = decision.trim();
  const lower = d.toLowerCase();
  if (lower === 'none' || lower === 'no' || lower.startsWith('none ') || lower.startsWith('none—') || lower === DEPLOY_PROBE_ASK_OPTIONS[0].toLowerCase()) {
    return DEPLOY_PROBE_NONE;
  }
  const url = /https?:\/\/\S+/i.exec(d)?.[0];
  if (!url) return null;
  const n = normalizeDeployProbe(url);
  return 'value' in n ? n.value : null;
}
