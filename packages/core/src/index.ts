// Types
export type {
  NodeId,
  UserId,
  MapId,
  FleetId,
  CycleId,
  VersionId,
  DependencyType,
  HealthSignal,
  Priority,
  EffortUnit,
  LayoutMode,
  CustomFieldValue,
  Dependency,
  ExternalLink,
  Attachment,
  LinkedPrState,
  Node,
  ComputedNodeValues,
  BlockedBy,
  CustomFieldDef,
  StatusDef,
  PhaseDef,
  ProfilePolicy,
  AiPolicy,
  Baseline,
  MindMap,
  Fleet,
  FleetWithMaps,
  HolidayOverrides,
  User,
  Workspace,
  WorkspaceMember,
  MapPermission,
  Version,
  Cycle,
  Integration,
  SyncLogEntry,
  FieldMapping,
  ScheduledNode,
  CriticalPathResult,
  NodeMap,
} from './types.js';

export { FORGE_LINK_PROVIDERS, isForgeLink, forgeLabel, userReporter } from './types.js';
export type { ForgeKindName, ForgeProblem, NodeReporter } from './types.js';

// Computation engine
export {
  computeEffort,
  computeProgress,
  computeHealth,
  leafHealth,
  computeIsBlocked,
  computeTree,
} from './compute.js';

// Tree operations
export {
  buildNodeMap,
  isAncestor,
  insertNode,
  moveNode,
  deleteNode,
  reorderChildren,
} from './tree.js';

// Dependency analysis
export {
  hasCycle,
  topologicalSort,
  schedule,
  criticalPath, capacityCriticalPath,
  // Orchestration substrate (#111)
  resolvedSiblingOrder,
  isReady,
  scopeOverlap,
} from './dependencies.js';
export type { ScheduleConstraint, ScheduleContext } from './dependencies.js';

// Business-day calendar helpers
export {
  addBusinessDays,
  businessDaysBetween,
  hoursToBusinessDays,
} from './calendar.js';
export { makeDayMapper, applyHolidayOverrides, hasWorkingCalendar, isIsoDate, describeHolidayCalendar } from './workCalendar.js';
export type { DayMapper, OffsetRounding } from './workCalendar.js';

// Status-workflow helpers (#119)
export {
  resolveStatusDef,
  buildIsDonePredicate,
  buildInProgressIds,
  buildTodoIds,
} from './statusWorkflow.js';

// Plan-lint vocabulary shared by engine, MCP tool and panel (docs/plan-linter.md)
export { LINT_RULE_IDS, LINT_ACTIONS, LINT_ACTION_IDS, LINT_FIX_ACTIONS } from './lint.js';
export type { LintRuleId, LintActionId } from './lint.js';

// Release ordering
export { compareVersions, effectiveVersionId, findVersionOrderInversions, nodesInVersion } from './versions.js';
// Per-map AI policy (#375)
export { AI_POLICIES, isAiPolicy } from './types.js';
export type { VersionOrderFields, VersionOrderInversion, VersionMembershipNode } from './versions.js';

// Estimation-calibration evidence gate
export {
  assessCalibration,
  calibrationSamplesFromNodes,
  MIN_CALIBRATION_LEAVES,
  MIN_CALIBRATION_DAYS,
  CALIBRATION_BULK_THRESHOLD,
} from './calibration.js';
export type { CalibrationSample, CalibrationAssessment } from './calibration.js';

// Pull-queue (Leidang) gate predicates + queue snapshot — shared by the
// server's get_next_ticket and the cockpit's Dispatch card.
export {
  DEFAULT_DISPATCH_POLICY,
  DISPATCH_POLICY_KEYS,
  MIX_BUGS_PREFIX,
  MIX_BUGS_REGEX,
  parseMixBugs,
  NEEDS_BRIEF_TAG,
  GATE_BUGS_ONLY,
  GATE_VERSION_PREFIX,
  isBugNode,
  hasBrief,
  TITLE_BRIEF_MIN_WORDS,
  parseGateEntry,
  gateVersionIds,
  GATE_OR,
  matchesDispatchGate,
  pullableNodes,
  dispatchQueueSnapshot,
  dispatchSkipTag,
  dispatchHold,
  parentHolds,
  isEpicLeaf,
  EPIC_HOLD_TAG,
  DISPATCH_SKIP_TAGS,
  BLOCKED_TAG,
  FLEET_FIX_TAG,
  holdsCapSlot,
  fleetCanFix,
  FLEET_CHECK_TAG,
  fleetFixAction,
  planUnblock,
} from './dispatch.js';
export type { DispatchPolicyKey, GateEntry, GateTerm, DispatchState, DispatchQueueSnapshot, DispatchHold, ParentHold, UnblockPlan } from './dispatch.js';

// Leidang fleet telemetry — rollup/tick shapes + the reading the Fleet card shows
export {
  ROLLUP_STALE_MIN,
  WORKER_DEAD_MIN,
  parseRollup,
  rollupServedMaps,
  redactRollup,
  redactTick,
  parseTick,
  hostFreshness,
  isWorkerDead,
  effectiveWorkerState,
  summarizeFleet,
  silentSatellites,
  estimateServerNow,
  ticketPhase,
  ticketPhases,
  stopBlockerReason,
  ticketPhaseText,
  TICK_WINDOW_DEFAULT_LIMIT,
  TICK_HISTORY_DEFAULT_LIMIT,
  TICK_WINDOW_MAX_LIMIT,
  parseTickWindow,
  severityRank,
  summarizeTick,
  FLEET_SHARE_MIN,
  FLEET_SHARE_MAX,
  DEFAULT_FLEET_SHARE,
  clampFleetShare,
  capOnFleetConnect,
  orderFleetPull,
  advanceFleetPull,
} from './fleet.js';
export type {
  FleetPullDeficits,
  FleetWorkerStatus,
  FleetClaimPhase,
  FleetRollup,
  FleetTickPayload,
  TicketPhase,
  HostFreshness,
  HostSummary,
  HeldClaim,
  FleetSummary,
  SilentReason,
  TickWindow,
  TickSummary,
} from './fleet.js';

// Asks inbox — the fleet's open human questions + the write plan of an answer
export {
  ASK_ANSWERERS,
  ASK_HINTS,
  ASK_ACTIONS,
  ASK_STATUSES,
  ASK_NO_QUESTION_HINTS,
  parseAsk,
  parseAskDocument,
  decisionLine,
  decisionCommentBody,
  prependDecision,
  planAskWrites,
  sortAsks,
  isNoQuestion,
  isVersionOnly,
  questionParts,
  countAsks,
  digestAsks,
  formatAskDigest,
} from './asks.js';
export type {
  Ask,
  AskAnswerer,
  AskHint,
  AskAction,
  AskStatus,
  AskDocument,
  AskDocumentMeta,
  AskAnswerInput,
  AskWrite,
  AskRow,
  AskNodeState,
  AskWritePlan,
  AskCounts,
  AskDigest,
  QuestionParts,
} from './asks.js';

// Rich-text rendering
export { proseMirrorToPlainText } from './richtext.js';

// Linked-PR sync gates
export {
  prBlocksIssueClose,
  prBlocksNodeReopen,
  hasCloseSnapshot,
  isPrematureCloseLink,
  issueCloseAction,
} from './linkedPr.js';
export type { IssueCloseAction } from './linkedPr.js';

// Requirements register helpers
export {
  collectRequirementGhLinks,
  requirementStage,
  stageCounts,
  BUILT_THRESHOLD,
  STAGE_LABEL,
  STAGE_ORDER,
  STAGE_COLOR,
} from './requirements.js';
export type {
  GhLinkSource,
  RequirementGhLink,
  RequirementGate,
  RequirementStage,
  RequirementVerdict,
} from './requirements.js';

// Velocity & capacity helpers
export {
  FOCUS_FACTOR_MIN,
  FOCUS_FACTOR_MAX,
  DEFAULT_FOCUS_FACTOR,
  clampFocusFactor,
  scopedCapacityDays,
  analyzeRepoThroughput,
  netDeliveryRate,
  OFFLINE_MERGE_HOURS,
  assessForecastConfidence,
  summarisePace,
  CONFIDENCE_DIVERGENCE_FLOOR_DAYS,
  CONFIDENCE_DIVERGENCE_RATIO,
} from './velocity.js';
export type { ScopedCapacityInput, PrRecord, RepoThroughput, PaceDay, PaceSummary } from './velocity.js';
export type {
  ForecastConfidence,
  ForecastConfidenceInput,
  ForecastConfidenceLevel,
} from './velocity.js';

// Forecast evidence — how much of a scope's own history stands behind its forecast (#319/#342/#343)
export {
  MIN_OWN_COMPLETIONS,
  MIN_OWN_RATE_COMPLETIONS,
  MIN_OWN_SPAN_DAYS,
  IMPORTED_DONE_WITHIN_MS,
  ownCompletionStats,
  assessForecastEvidence,
  chooseTicketRate,
  forecastHeadline,
} from './forecastEvidence.js';
export type {
  ForecastEvidence,
  ForecastEvidenceState,
  OwnCompletionStats,
  TicketRateChoice,
  ForecastHeadline,
  HeadlineConfidence,
} from './forecastEvidence.js';

// Fleet journal — what the fleet did in a window (ticks, claims, delivered, follow-ups, knob writes)
export { buildFleetJournal, journalWindow, splitSession, JOURNAL_EVENT_TYPES } from './fleetJournal.js';
export type {
  FleetJournal,
  JournalInput,
  JournalEventRow,
  JournalNodeRow,
  JournalWindow,
  JournalPreset,
  JournalWorker,
  JournalMapRef,
  JournalClaim,
  JournalRelease,
  JournalDelivered,
  JournalCreated,
  JournalBlocked,
  JournalKnobWrite,
  JournalTick,
  JournalTotals,
  JournalIssue,
} from './fleetJournal.js';

// Claim trail — change_events payloads for claim/release/delivery + the pure reading of them
export {
  CLAIM_EVENT_TYPES,
  parseSession,
  heldMinutes,
  buildClaimedEvent,
  buildReleasedEvent,
  describeSession,
  formatHeld,
  describeClaimEvent,
  claimTrail,
  claimTrailSummary,
} from './claimTrail.js';
export type {
  ClaimVia,
  ReleaseReason,
  ParsedSession,
  ClaimedEvent,
  ReleasedEvent,
  PrMergedEvent,
  ClaimEventType,
  ChangeEventLike,
  ClaimTrailEntry,
} from './claimTrail.js';

// Sprint signals — state vs dates, overlaps, WIP, stalled (#324)
export { sprintSignals, SPRINT_STALLED_DAYS, planSprintTransitions } from './sprintSignals.js';
export type { SprintLike, SprintItem, SprintSignals, SprintTransition } from './sprintSignals.js';

// Triage pipeline state — N identical triage errors folded into one (#320)
export { triagePipelineState, humaniseTriageCause, triageCauseKey } from './triagePipeline.js';
export type { TriagePipelineState, TriagePipelineInput } from './triagePipeline.js';

// Blockers grouped by root cause / unblocker (#322)
export { classifyBlocker, groupBlockers, STALLED_GROUP_LABEL } from './blockers.js';
export type { BlockerKind, BlockerGroup, BlockedItem } from './blockers.js';

// Stalled — in progress, unclaimed, no change for hours
export {
  STALLED_AFTER_HOURS,
  isStalledCandidate,
  findStalled,
  formatIdle,
  describeStalled,
  STALLED_ASK_AFTER_HOURS,
  STALLED_ASK_PREFIX,
  STALLED_ASK_OPTIONS,
  stalledAskId,
  stalledAskNodeId,
  isStalledAskDue,
  stalledAskAfterHours,
  DECISION_TITLE_RE,
  buildStalledAsk,
  stalledAnswerAction,
  stalledAnswerNote,
} from './stalled.js';
export type { StalledNodeLike, StalledLeaf, StalledRelease, StalledActivity, StalledAnswer } from './stalled.js';

// "Your steps" — a person's needs-human tickets on the Questions card
export {
  STEP_ASK_PREFIX,
  STEP_ASK_OPTIONS,
  stepAskId,
  stepAskNodeId,
  isDerivedAsk,
  nextStepOf,
  stepSummaryOf,
  stepParts,
  buildStepAsk,
  stepAnswerAction,
  derivedAnswerPreview,
  BLOCKER_ASK_PREFIX,
  BLOCKER_ASK_OPTIONS,
  blockerAskId,
  blockerAskNodeId,
  derivedAskNodeId,
  isPersonStepAsk,
  buildBlockerAsk,
  blockerAnswerAction,
  blockerFleetAction,
  autoCheckable,
  AUTO_CHECK_BY,
  AUTO_CHECK_GRACE_MINUTES,
  BRIEF_ASK_PREFIX,
  BRIEF_ASK_OPTIONS,
  briefAskId,
  briefAskNodeId,
  buildBriefAsk,
  briefAnswerAction,
} from './humanSteps.js';
export type { StepAnswer, StepParts, BlockerAnswer, BriefAnswer } from './humanSteps.js';

// Which uploaded files stay public capability URLs (#292, decision D)
export { PUBLIC_MEDIA_EXTENSIONS, isPublicMediaFileName } from './media.js';

// Trust policy: who may run the fleet on a map (#491)
export { SAFE_TRUST_LEVEL, defaultTrustPolicy, trustLevel, automationFor, parseTrustPolicy } from './trust.js';
export type { TrustLevel, TrustDispatch, TrustMerge, TrustLevelPolicy, TrustPolicy, TrustAutomation, ForgeUserLink } from './trust.js';

// Guided onboarding: the project setup checklist
export { projectSetup } from './setup.js';
export type { SetupStepId, SetupStep, ProjectSetup } from './setup.js';
