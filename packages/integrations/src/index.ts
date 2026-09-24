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
  giteaAuthorizeUrl,
  exchangeGiteaAuthorizationCode,
  refreshGiteaAccessToken,
  giteaUserForge,
  getGiteaUser,
  listGiteaUserRepos,
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
  RequestOptions,
  GitHubForgeOptions,
  GiteaForgeOptions,
  GiteaOAuthApp,
  GiteaOAuthTokens,
  GiteaUser,
  GiteaRepo,
  WebhookHeaders,
} from './forge/index.js';

// ── Sync operations ──────────────────────────────────────────────

export {
  createGitHubIssue,
  updateGitHubIssue,
  closeGitHubIssue,
  processWebhook,
  extractClosingIssueRefs,
  importGitHubIssues,
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
  listInstallationRepositories,
  exchangeUserAuthorizationCode,
  refreshUserAccessToken,
  getGitHubUser,
  getInstallationDetails,
  buildInstallUrl,
  buildOAuthAuthorizeUrl,
  listAppInstallations,
} from './github-app.js';

export type {
  GitHubAppConfig,
  InstallationToken,
  UserOAuthTokens,
  GitHubUser,
  GitHubRepo,
  GitHubInstallationAccount,
} from './github-app.js';
