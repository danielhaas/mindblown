/**
 * @mindblown/integrations — forge (GitHub, Gitea) issue sync, import/export.
 *
 * Bidirectional sync between MindBlown nodes and external issue trackers.
 * Handles field mapping, conflict resolution, and webhook processing.
 *
 * Layout:
 *   forge/types.ts   — `ForgeClient` interface + normalised payloads
 *   forge/github.ts  — `GitHubForge` (the only file that knows github.com)
 *   forge/webhook.ts — signature verification, header reading
 *   forge/index.ts   — `createForgeClient` factory + defaults
 *   github.ts        — node ↔ issue sync operations over any `ForgeClient`
 *   github-app.ts    — GitHub App JWT/installation/OAuth plumbing
 */
export const PACKAGE_NAME = '@mindblown/integrations' as const;

// ── Forge abstraction (#367) ─────────────────────────────────────

export {
  FORGE_KINDS,
  isForgeKind,
  ForgeApiError,
  forgeLabel,
  GitHubForge,
  GiteaForge,
  giteaEndpoint,
  normalizeGiteaIssue,
  normalizeGiteaWebhookAction,
  normalizeGiteaReviewDelivery,
  giteaAuthorizeUrl,
  exchangeGiteaAuthorizationCode,
  refreshGiteaAccessToken,
  giteaUserForge,
  getGiteaUser,
  listGiteaUserRepos,
  createGiteaUserRepo,
  GITHUB_API_BASE,
  GITHUB_WEB_BASE,
  GITHUB_ENDPOINT,
  issueWebUrl,
  forgeDefaults,
  resolveForgeEndpoint,
  createForgeClient,
  githubForge,
  readWebhookHeaders,
  verifyWebhookSignature,
  MERGE_METHODS,
} from './forge/index.js';

export type {
  ForgeKind,
  ForgeEndpoint,
  ForgeConnection,
  ForgeClient,
  ForgeFetch,
  ForgeResponse,
  ForgeRequestInit,
  ForgeIssue,
  ForgeMilestone,
  ForgePullRequest,
  ForgeRawResponse,
  CreateIssueInput,
  UpdateIssueInput,
  IssuesListQuery,
  MilestoneRef,
  IssueCloseEvent,
  ListPullRequestsQuery,
  RepoTree,
  RepoTreeFile,
  PutFileInput,
  PutFileResult,
  CreatePullRequestInput,
  RequestOptions,
  GitHubForgeOptions,
  GiteaForgeOptions,
  GiteaOAuthApp,
  GiteaOAuthTokens,
  GiteaUser,
  GiteaRepo,
  WebhookHeaders,
  ForgePullRequestDetail,
  ForgePullRequestFile,
  ForgeCheck,
  MergeMethod,
  MergePullRequestInput,
  RepoMergeSettings,
} from './forge/index.js';

// ── Sync operations ──────────────────────────────────────────────

export {
  createGitHubIssue,
  updateGitHubIssue,
  closeGitHubIssue,
  processWebhook,
  extractClosingIssueRefs,
  extractReferencedIssueRefs,
  extractClosingNodeRefs,
  extractReferencedNodeRefs,
  importGitHubIssues,
  _clearIssueListCacheForTests,
  fetchChangedIssues,
  extractVersionFromMilestone,
  getGitHubIssue,
  GitHubApiError,
  GitHubScanTruncatedError,
  GitHubPaginationLimitError,
  paginateGitHub,
  githubFetchPage,
  parseLinkNext,
  reopenGitHubIssue,
  commentOnGitHubIssue,
  setGitHubIssueMilestone,
  getRepoDefaultBranch,
  findClosingPrsForIssue,
  probeIssueLanded,
  parseExternalId,
  getIssueCloseEvent,
} from './github.js';

export type {
  GitHubIssue,
  GitHubWebhookPayload,
  WebhookResult,
  ImportedIssue,
  ClosingPrRef,
  GitHubPage,
  IssueLandingProbe,
  IssueStateHoldReason,
  UpdateIssueResult,
  UpdateIssueOptions,
} from './github.js';

// ── GitHub App (github.com only) ─────────────────────────────────

export {
  getGitHubAppConfig,
  isGitHubAppConfigured,
  mintAppJwt,
  mintInstallationToken,
  mintScopedRepoToken,
  listInstallationRepositories,
  exchangeUserAuthorizationCode,
  refreshUserAccessToken,
  getGitHubUser,
  buildInstallUrl,
  buildOAuthAuthorizeUrl,
  listUserInstallations,
  listUserInstallationRepositories,
  createGitHubRepository,
} from './github-app.js';

export type {
  GitHubAppConfig,
  InstallationToken,
  UserOAuthTokens,
  GitHubUser,
  GitHubRepo,
  GitHubInstallationAccount,
} from './github-app.js';

// ── Outline wiki (#637): publish a map's timeline as a document ──
export { createOutlineClient, outlineBase, OutlineApiError } from './outline.js';
export type { OutlineClient, OutlineClientOptions, OutlineDocument } from './outline.js';
