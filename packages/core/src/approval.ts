/**
 * Deciding on proposed tickets (#494): the rows a trusted person sees,
 * and the hint that flags text written at the agent rather than about a
 * problem.
 *
 * The hint is a pattern check, never a verdict: it never rejects
 * anything, it only tells the person what to read twice.
 */
import type { NodeApproval, NodeReporter } from './types.js';
import type { TrustLevel } from './trust.js';

/** One proposed ticket waiting for a trusted person. */
export interface PendingApproval {
  mapId: string;
  mapName: string;
  nodeId: string;
  /** The node revision this row shows — send it back as `expectedRevision`. */
  revision: number;
  title: string;
  /** The description as plain text ('' when there is none). */
  description: string;
  reportedBy: NodeReporter | null;
  /** The reporter as a person reads it: a user's name, `github:login`, or "unknown". */
  reporterLabel: string;
  trustLevel: TrustLevel;
  approval: NodeApproval;
  /** The linked forge issue, if any. */
  issue: { ref: string; url: string } | null;
  /** What `approvalHints` flagged in title + description. */
  hints: string[];
  /** The AI's read of the current text; null = not read yet, or AI is off for the map. */
  review: ApprovalReview | null;
  /** The reader may approve or reject it: on the map's trusted list, not a fleet key. */
  canApprove: boolean;
  createdAt: string;
}

/**
 * The AI's first read of a proposed ticket: does it make sense, and is
 * there enough to work from? Advice for the person who decides — it never
 * approves or rejects, and the ticket text it read is untrusted.
 *
 *   ready       clear, actionable, enough detail to start
 *   needs-info  makes sense, but the questions must be answered first
 *   doubtful    not a sensible task as written: unclear, not actionable,
 *               or written at the agent rather than about a problem
 */
export type ApprovalReviewVerdict = 'ready' | 'needs-info' | 'doubtful';

export interface ApprovalReview {
  verdict: ApprovalReviewVerdict;
  /** One sentence: why this verdict. */
  reason: string;
  /** What to ask the reporter (0–3); empty unless something is missing. */
  questions: string[];
  /** The provider that answered (`claude`, `ollama`). */
  provider: string;
  reviewedAt: string;
  /** When a trusted person posted the questions on the issue; null = not asked for this text. */
  askedAt: string | null;
}

export interface PendingApprovalList {
  items: PendingApproval[];
  now: string;
}

/** What a trusted person decides. `merge` defaults to the stamp's own (the policy's). */
export interface ApproveInput {
  merge?: 'auto' | 'pr-only';
  /** Edit & approve: the new description (plain text), written before the stamp. */
  description?: string;
  /** The revision the person read; a ticket changed since is refused (409). */
  expectedRevision?: number;
}

export interface RejectInput {
  /** Posted on the linked forge issue. */
  note?: string;
  /** Close the forge issue as not planned. Default: it stays open. */
  closeIssue?: boolean;
}

/** Ask the reporter: the questions (the AI's, as the person edited them), posted on the linked issue. */
export interface AskReporterInput {
  questions: string[];
}

export const MAX_ASK_QUESTIONS = 5;

const HINTS: Array<[RegExp, string]> = [
  [/\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|earlier|all|your)\b.{0,20}\b(instructions?|rules|prompt)/i, 'tells the agent to ignore its instructions'],
  [/\b(system prompt|you are (an?|the) (ai|assistant|agent|llm)|as an ai\b|dear (ai|agent|claude|assistant))/i, 'speaks to the agent, not about the problem'],
  [/\b(api[ _-]?keys?|access tokens?|secrets?|passwords?|private keys?|ssh keys?|credentials?|\.env\b|authorized_keys)/i, 'mentions keys, tokens or credentials'],
  [/\b(add|grant|give)\b.{0,30}\b(ssh key|deploy key|collaborator|admin|write access|access to)/i, 'asks to grant access or add a key'],
  [/\b(curl|wget)\b[^\n]*\|\s*(ba|z)?sh\b|\b(run|execute)\b.{0,30}\b(this|the following)\b.{0,15}\b(command|script)|\brm -rf\b|\bsudo\b/i, 'asks to run a command'],
  // Not "open" / "visit": repro steps say "open https://…/login" all the time.
  [/\b(fetch|download|curl|wget)\b.{0,30}https?:\/\//i, 'asks to fetch a URL'],
];

/** Flags in a ticket's text worth a second read before approving (#494). Empty when nothing matched. */
export function approvalHints(text: string): string[] {
  return HINTS.filter(([re]) => re.test(text)).map(([, label]) => label);
}
