/**
 * @mindblown/integrations — GitHub Issues sync, Jira, Linear, import/export.
 *
 * Bidirectional sync between MindBlown nodes and external issue trackers.
 * Handles field mapping, conflict resolution, and webhook processing.
 */
export const PACKAGE_NAME = '@mindblown/integrations' as const;

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
  verifyWebhookSignature,
  GitHubApiError,
  GitHubScanTruncatedError,
  GitHubPaginationLimitError,
  paginateGitHub,
  githubFetchPage,
  parseLinkNext,
  reopenGitHubIssue,
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
  IssueCloseEvent,
  IssueStateHoldReason,
  UpdateIssueResult,
  UpdateIssueOptions,
} from './github.js';

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
