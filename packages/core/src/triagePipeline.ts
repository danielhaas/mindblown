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
  broken: boolean;
  count: number;
  cause: string | null;
  since: string | null;
}

const TRIAGE_ERROR_RE = /triage_error[:\s]*(.*)/i;

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

/** N pending decisions sharing one error text = the pipeline, not the tickets. */
export function triagePipelineState(decisions: TriagePipelineInput[], threshold = 5): TriagePipelineState {
  const errors = decisions
    .map((d) => ({ m: TRIAGE_ERROR_RE.exec(d.reason ?? ''), at: d.decidedAt }))
    .filter((x) => x.m);
  if (errors.length < threshold) return { broken: false, count: 0, cause: null, since: null };
  const causes = new Map<string, number>();
  for (const e of errors) {
    // Same cause, different ticket number → one key.
    const key = humaniseTriageCause(e.m![1]).replace(/\(?#\d+\)?/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    causes.set(key, (causes.get(key) ?? 0) + 1);
  }
  const [cause, count] = [...causes.entries()].sort((a, b) => b[1] - a[1])[0];
  if (count < threshold) return { broken: false, count: 0, cause: null, since: null };
  const since = errors.map((e) => e.at).sort()[0] ?? null;
  return { broken: true, count: errors.length, cause, since };
}

