/**
 * Data shapes returned by backend operations.
 * Mirror the server's API response envelopes (also used by packages/mcp/src/api.ts).
 */
import type { TrustPolicy } from '@mindblown/core';

export interface MapSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  rootNodeId: string;
  effortUnit: string;
  healthThreshold: number;
  computedProgress: number;
  healthSignal: string;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp when the map was archived; null/absent = active. */
  archivedAt?: string | null;
  /** #491 — only on the reply to an update that set it (admin-only, never broadcast). */
  trustPolicy?: TrustPolicy;
}

export interface NodeWithComputed {
  id: string;
  mapId: string;
  parentId: string | null;
  childrenIds: string[];
  text: string;
  description: string | null;
  effortEstimate: number | null;
  /** 'ai' = an AI draft estimate (#318); null/absent = a person's. */
  estimateSource?: 'ai' | null;
  actualEffort: number | null;
  percentComplete: number | null;
  status: string | null;
  assigneeIds: string[];
  priority: string | null;
  dueDate: string | null;
  startDate: string | null;
  tags: string[];
  dependencies: Array<{ targetNodeId: string; type: string; lag: number }>;
  versionId: string | null;
  cycleId: string | null;
  externalLinks: Array<{
    provider: string;
    externalId: string;
    url: string;
    syncEnabled: boolean;
    lastSyncedAt: string | null;
  }>;
  /** Forge PR mirror (webhook-maintained); absent/null when none. */
  linkedPr?: { number: number; repo: string; state: 'open' | 'closed' | 'merged'; draft?: boolean } | null;
  /** Who asked for the node (#490); server-set, read-only. null = unknown. */
  reportedBy?:
    | { kind: 'user'; userId: string }
    | { kind: 'forge'; provider: string; login: string }
    | null;
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
  // Requirements register — non-null requirementId marks a requirement.
  requirementId: string | null;
  requirementPriority: 'must' | 'should' | 'could' | null;
  requirementText: string | null;
  // References a PhaseDef.id from the map's `phases` list (statusWorkflow
  // idiom). null = no phase assigned.
  phaseId: string | null;
  // Orchestration substrate (#111) — surfaced for slot accounting (#153).
  claimedBySession: string | null;
  claimedAt: string | null;
  /** When work started (core Node field); optional — older servers omit it. */
  startedAt?: string | null;
  /** The worker's own ETA (core Node field); optional — older servers omit it. */
  expectedDoneAt?: string | null;
  computedEffort: number;
  computedProgress: number;
  healthSignal: string;
  /**
   * Files and links hung on the node (core `Attachment`). Optional here
   * because this is a hand-maintained mirror and older servers omit it;
   * the attachment tools only read it to report a count.
   */
  attachments?: AttachmentSummary[];
}

/** One attachment as the tools report it (mirrors core `Attachment`). */
export interface AttachmentSummary {
  id: string;
  kind: 'file' | 'link';
  url: string;
  title: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  addedAt: string;
  addedBy?: string | null;
}

/** Pull-queue profile routing thresholds (mirrors core ProfilePolicy, #262). */
export interface ProfilePolicy {
  /** Heavy-class floor in hours. Omitted = one day (the map's hoursPerDay). */
  heavyMinHours?: number;
  /** Light-eligible ceiling in hours. Omitted = 2. */
  lightMaxHours?: number;
}

/** Project phase definition (mirrors core PhaseDef; statusWorkflow idiom). */
export interface PhaseDef {
  id: string;
  name: string;
  position: number;
  color?: string;
  targetDate?: string | null;
}

export interface MapDetail {
  map: MapSummary & {
    statusWorkflow: Array<{ id: string; name: string; category: string; color: string; position: number }>;
    baselines: unknown[];
    wipLimit: number | null;
    /** Project phase definitions; `position` = canonical phase order. */
    phases?: PhaseDef[];
    /** #110 — public-holiday calendar; null/absent = every day counts. */
    holidayJurisdiction?: string | null;
    holidayOverrides?: { add: string[]; remove: string[] };
    /** #477 — the fleet the map is connected to; null/absent = none. */
    fleetId?: string | null;
    fleetName?: string | null;
    fleetShare?: number;
    /** The map's own pull-queue cap; 0 = on hold. */
    maxActiveClaims?: number;
    /** Repo binding, derived at read time (core MindMap.forgeKind / forgeProblem). */
    forgeKind?: 'github' | 'gitea' | null;
    forgeProblem?: { kind: 'unbound' | 'refused'; repo: string; message: string } | null;
    githubRepoOwner?: string | null;
    githubRepoName?: string | null;
    /** Guided onboarding: setup checklist finished or dismissed; null = still open. */
    setupCompletedAt?: string | null;
  };
  nodes: NodeWithComputed[];
}
