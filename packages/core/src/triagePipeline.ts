/**
 * Triage pipeline state (#320). When the triage model fails the same way on
 * every issue (credits exhausted, model down), the queue fills with N
 * identical "uncertain" rows and the operator has to scroll to see the
 * pattern. This folds them into one state — "broken since <date>: <cause>,
 * N tickets" — shared by the Triage panel, the PM Cockpit and the MCP
 * digests. The rows stay available behind it.
 */

/** The fields a decision row needs for this — server rows and API rows alike. */
export interface TriagePipelineInput {
  reason: string | null;
  decidedAt: string;
  decision: string;
}

export interface TriagePipelineState {
  /** Triage is failing right now: the newest decision is an error, many share one cause. */
  broken: boolean;
  /**
   * The pipeline recovered (a successful decision is newer than the newest
   * error) but rows from the outage still carry the error — they need a
   * Re-classify. Not an alert.
   */
  stale: boolean;
  /** Rows carrying the top cause. */
  count: number;
  cause: string | null;
  /** Oldest pending error row (ISO). */
  since: string | null;
}

/**
 * Only rows whose reason STARTS with the marker (the server writes
 * `triage_error: …` at the start). Model reasoning that merely quotes the
 * text must not count — nor become the "cause", which API keys may read.
 */
const TRIAGE_ERROR_RE = /^triage_error[:\s]*(.*)/i;

const NONE: TriagePipelineState = { broken: false, stale: false, count: 0, cause: null, since: null };

/**
 * "400 {"type":"error","error":{"message":"Your credit balance is too low…"}}"
 * → "Your credit balance is too low…". The API error JSON is the cause a PM
 * has to read; the envelope around it is not.
 */
export function humaniseTriageCause(raw: string): string {
  const start = raw.indexOf('{');
  if (start === -1) return raw;
  const candidates = [raw.slice(start), raw.slice(start, raw.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    try {
      const j = JSON.parse(c) as { error?: { message?: string }; message?: string };
      const msg = j.error?.message ?? j.message;
      if (msg) return `${raw.slice(0, start).trim()} ${msg}`.trim();
    } catch {
      // truncated JSON — fall through to the regex
    }
  }
  const m = /"message"\s*:\s*"([^"]*)/.exec(raw);
  return m ? `${raw.slice(0, start).trim()} ${m[1]}`.trim() : raw;
}

/**
 * N pending decisions sharing one error text = the pipeline, not the tickets.
 * A successful decision newer than the newest error means it recovered:
 * `stale` instead of `broken`.
 */
export function triagePipelineState(decisions: TriagePipelineInput[], threshold = 5): TriagePipelineState {
  const errors: Array<{ cause: string; at: string }> = [];
  let newestOk = '';
  for (const d of decisions) {
    const m = TRIAGE_ERROR_RE.exec(d.reason ?? '');
    if (m) errors.push({ cause: triageCauseKey(m[1]), at: d.decidedAt });
    else if (d.decidedAt > newestOk) newestOk = d.decidedAt;
  }
  if (errors.length < threshold) return NONE;
  const causes = new Map<string, number>();
  for (const e of errors) causes.set(e.cause, (causes.get(e.cause) ?? 0) + 1);
  const [cause, count] = [...causes.entries()].sort((a, b) => b[1] - a[1])[0];
  if (count < threshold) return NONE;
  const ats = errors.map((e) => e.at).sort();
  const recovered = newestOk > ats[ats.length - 1];
  return { broken: !recovered, stale: recovered, count, cause, since: ats[0] ?? null };
}

/**
 * The comparable cause: provider error message, no ticket numbers, and no
 * quoted model output — "no parseable JSON (got \"…\")" carries up to 200
 * chars of what the model said, which the session-only row routes exist to
 * keep from API-key callers.
 */
export function triageCauseKey(raw: string): string {
  return humaniseTriageCause(raw.replace(/\s*\(?got\s+["“][\s\S]*$/i, ''))
    .replace(/\(?#\d+\)?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}
