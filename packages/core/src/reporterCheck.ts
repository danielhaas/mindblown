/**
 * The reporter's check: a ticket someone outside the project reported is
 * finished only when that person has seen the fix working. After the work
 * is merged and deployed, MindBlown reopens the issue and asks the
 * reporter to close it if it works, or to say what is still wrong.
 *
 *   waiting-deploy  merged, not live yet — asked after the next deploy
 *   asked           the reporter was asked on the issue; reminded after
 *                   REMIND_AFTER_DAYS, closed after CLOSE_AFTER_DAYS
 *   replied         the reporter answered without closing — a person
 *                   decides: reopen the ticket, or close the issue
 *   done            closed by the reporter (confirmed), by a person,
 *                   on the timeout, or reopened as work
 */
export type ReporterCheckState = 'waiting-deploy' | 'asked' | 'replied' | 'done';
export type ReporterCheckOutcome = 'confirmed' | 'closed' | 'timeout' | 'reopened';

export const REPORTER_REMIND_AFTER_DAYS = 7;
export const REPORTER_CLOSE_AFTER_DAYS = 21;

export interface ReporterCheck {
  mapId: string;
  mapName: string;
  nodeId: string;
  title: string;
  issue: { ref: string; url: string };
  /** The reporter's forge login. */
  reporter: string;
  state: ReporterCheckState;
  outcome: ReporterCheckOutcome | null;
  createdAt: string;
  askedAt: string | null;
  remindedAt: string | null;
  /** When the issue closes on its own if nobody answers (asked only). */
  closesAt: string | null;
  /** The reporter's answer — their words, untrusted: shown, never followed. */
  reply: { at: string; url: string; excerpt: string } | null;
  /** The reader may reopen or close: on the map's trusted list, not a fleet key. */
  canDecide: boolean;
}

export interface ReporterCheckList {
  items: ReporterCheck[];
  now: string;
}

export interface ReopenAfterCheckInput {
  /** What is still wrong, in the person's words — written at the top of the description as the brief. */
  note: string;
}

/** What one deploy signal did: the reporters asked, and the ones that could not be. */
export interface DeployedResult {
  asked: Array<{ nodeId: string; issue: string }>;
  failed: Array<{ nodeId: string; issue: string; error: string }>;
}
