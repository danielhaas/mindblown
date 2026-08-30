// Types
export type {
  NodeId,
  UserId,
  MapId,
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
  Baseline,
  MindMap,
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
  criticalPath,
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

// Status-workflow helpers (#119)
export {
  resolveStatusDef,
  buildIsDonePredicate,
  buildInProgressIds,
  buildTodoIds,
} from './statusWorkflow.js';

// Release ordering
export { compareVersions, effectiveVersionId, findVersionOrderInversions } from './versions.js';
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

// Rich-text rendering
export { proseMirrorToPlainText } from './richtext.js';

// Linked-PR sync gates
export {
  prBlocksIssueClose,
  prBlocksNodeReopen,
  hasCloseSnapshot,
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
  STAGE_LABEL_DE,
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
  CONFIDENCE_DIVERGENCE_FLOOR_DAYS,
  CONFIDENCE_DIVERGENCE_RATIO,
} from './velocity.js';
export type { ScopedCapacityInput, PrRecord, RepoThroughput } from './velocity.js';
export type {
  ForecastConfidence,
  ForecastConfidenceInput,
  ForecastConfidenceLevel,
} from './velocity.js';
