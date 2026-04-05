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
  importGitHubIssues,
  getGitHubIssue,
  verifyWebhookSignature,
} from './github.js';

export type {
  GitHubIssue,
  GitHubWebhookPayload,
  WebhookResult,
  ImportedIssue,
} from './github.js';
