/**
 * #152 — pull_request: closed (merged=true) → linked nodes transition to done.
 *
 * Covers the canonical handler in routes/integrations.ts that subscribes
 * to PR merge events for repos that don't send `issues` webhooks (e.g.
 * FulcrumCRM/crm). Verifies:
 *
 *   1. Multi-issue: PR body with "Closes #1, fixes #2" transitions BOTH
 *      linked nodes (the legacy processWebhook PR branch only returned
 *      the first ref).
 *   2. Idempotency: replay of the same payload finds the node already
 *      done and reports `already_done` without writing.
 *   3. Unsigned requests are rejected before the handler reaches the DB.
 *   4. Non-merged closures (PR closed without merging) are passed
 *      through unchanged.
 *   5. References to issues with no linked MindBlown node are reported
 *      as `not_linked` (not an error).
 *   6. (#199) PR merged to a NON-default branch (V1-hotfix flow targeting
 *      `release/v1`) does NOT transition the linked node, mirroring
 *      GitHub's auto-close semantics.
 *   7. (#199) PR with missing `base.ref` does NOT transition (fail-safe).
 *
 * Signature verification is stubbed to pass; HMAC plumbing is covered
 * by separate tests in `webhookAuthCheck.test.ts`. The processWebhook
 * spy delegates to the REAL implementation (see the @mindblown/integrations
 * mock factory below) so the tests exercise the production fall-through —
 * a noop stub would have masked the legacy PR-merge bypass that #199
 * fixes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

interface NodeRow {
  id: string;
  externalLinks: Array<{
    provider: string;
    externalId: string;
    url: string;
    syncEnabled: boolean;
    lastSyncedAt: string | null;
    previousPercentComplete?: number | null;
    previousStatus?: string | null;
    mergeCommitSha?: string | null;
    mergedPrNumber?: number | null;
  }>;
}

interface NodeRecord extends NodeRow {
  mapId: string;
  status: string | null;
  percentComplete: number | null;
}

const mocks = vi.hoisted(() => {
  const nodeStore = new Map<string, {
    mapId: string;
    status: string | null;
    percentComplete: number | null;
    externalLinks: NodeRow['externalLinks'];
  }>();
  return {
    nodeStore,
    getNodeMock: vi.fn(),
    updateNodeMock: vi.fn(),
    selectNodesMock: vi.fn(),
    broadcastMock: vi.fn(),
    verifySignatureMock: vi.fn(async () => true),
    closeGitHubIssueMock: vi.fn(async () => undefined),
    handleAbandonedPrMock: vi.fn(
      async (_ctx: unknown, _pr: unknown): Promise<unknown[]> => [],
    ),
    // Initial implementation is a placeholder; the mock factory below
    // rewires this to delegate to the real processWebhook so the
    // tests exercise production behaviour. The signature is widened
    // to accept the real (payload, event) shape from @mindblown/integrations.
    processWebhookMock: vi.fn(
      (...args: unknown[]): unknown => ({ action: 'noop', nodeUpdates: null, externalId: null }),
    ),
  };
});

vi.mock('@mindblown/integrations', async () => {
  // Use REAL implementations of the pure functions (processWebhook,
  // extractClosingIssueRefs) so the tests assert against the
  // production code path — not against a noop mock that would hide
  // the legacy PR-merge → done branch (#199 review caught exactly
  // this masking bug). Side-effect functions (GitHub API,
  // signature verification) stay mocked.
  //
  // processWebhook is wrapped in a spy so per-test `.mock.calls`
  // assertions still work, but the spy delegates to the real
  // implementation by default. Individual tests may override the
  // return value with `mocks.processWebhookMock.mockReturnValueOnce(...)`.
  const actual = await vi.importActual<typeof import('@mindblown/integrations')>(
    '@mindblown/integrations',
  );
  // Cast through `unknown` to satisfy the `vi.fn(...)` parameter widening.
  // The runtime contract — "delegate every call to the real
  // implementation" — matches the production wiring.
  mocks.processWebhookMock.mockImplementation(
    actual.processWebhook as unknown as (...args: unknown[]) => unknown,
  );
  return {
    ...actual,
    createGitHubIssue: vi.fn(),
    getGitHubIssue: vi.fn(),
    importGitHubIssues: vi.fn(),
    extractVersionFromMilestone: vi.fn(),
    verifyWebhookSignature: mocks.verifySignatureMock,
    mintInstallationToken: vi.fn(),
    isGitHubAppConfigured: vi.fn(() => true),
    processWebhook: mocks.processWebhookMock,
    closeGitHubIssue: mocks.closeGitHubIssueMock,
  };
});

vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => mocks.selectNodesMock(),
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => undefined }),
    }),
    insert: () => ({ values: () => ({ returning: async () => [] }) }),
    transaction: async <T,>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb({}),
  },
}));

vi.mock('../../db/schema.js', () => ({
  integrations: { __name: 'integrations' },
  versions: { __name: 'versions' },
  nodes: { __name: 'nodes' },
  maps: { __name: 'maps' },
  triageDecisions: { __name: 'triageDecisions' },
}));

vi.mock('../../db/nodes.js', () => ({
  getNode: mocks.getNodeMock,
  createNode: vi.fn(),
  updateNode: mocks.updateNodeMock,
  // Moved out of routes/integrations.ts, where it was a second copy of
  // the same scan. Same behaviour, over this file's node rows.
  findNodeIdByExternalId: async (externalId: string) => {
    for (const row of await mocks.selectNodesMock()) {
      const links = (row.externalLinks ?? []) as Array<{ provider: string; externalId: string }>;
      if (links.some((l) => l.provider === 'github' && l.externalId === externalId)) {
        return row.id as string;
      }
    }
    return null;
  },
  notDeleted: { __pred: true, check: () => true },
}));

vi.mock('../../sync/githubCatchup.js', () => ({ reconcileRepo: vi.fn() }));
vi.mock('../../sync/driftAudit.js', () => ({ runDriftAudit: vi.fn() }));
vi.mock('../../sync/webhookAuthCheck.js', () => ({ recordWebhookCall: vi.fn() }));
vi.mock('../../auth.js', () => ({ requireAdmin: vi.fn() }));
vi.mock('../../sync/parentEpicRollup.js', () => ({
  rollupParentsForChildTitle: vi.fn(),
}));
vi.mock('../../sync/prAbandon.js', () => ({
  handleAbandonedPr: mocks.handleAbandonedPrMock,
}));
vi.mock('../../sync/closedIssueAudit.js', () => ({ auditClosedIssues: vi.fn() }));
vi.mock('../../sync/githubIngest.js', () => ({
  ingestNewIssuesForRepo: vi.fn(),
  ensureInboxNode: vi.fn(),
  ensureNodeForIssue: vi.fn(),
  findNodesByExternalIds: vi.fn(),
}));
vi.mock('../../ws.js', () => ({ broadcast: mocks.broadcastMock }));
vi.mock('../../sync/triage.js', () => ({
  triageIssue: vi.fn(),
  clearTriageDebounce: vi.fn(),
  computeInputHash: vi.fn(),
  markTriageDebounce: vi.fn(),
  isWithinDebounceWindow: vi.fn(() => false),
}));
vi.mock('../../sync/mapContext.js', () => ({ buildMapContext: vi.fn() }));
vi.mock('../../sync/triageHistory.js', () => ({ recordTriageHistory: vi.fn() }));
vi.mock('../../sync/triageLabelWriteback.js', () => ({ applyTriageLabel: vi.fn() }));
vi.mock('../../lib/githubContext.js', () => ({
  getGitHubContextForMap: vi.fn(async () => null),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ __pred: true, check: () => true })),
  and: vi.fn(() => ({ __pred: true, check: () => true })),
}));

import { integrationRoutes } from '../integrations.js';

async function buildApp(logger = false): Promise<FastifyInstance> {
  const app = Fastify({ logger });
  await app.register(integrationRoutes);
  return app;
}

function prMergedPayload(opts: {
  number: number;
  title: string;
  body: string | null;
  baseRef?: string;
  defaultBranch?: string;
}): Record<string, unknown> {
  // Default to base=main + default_branch=main so existing single-arg
  // calls (which predate the default-branch gate added 2026-06-11)
  // still exercise the success path.
  return {
    action: 'closed',
    pull_request: {
      number: opts.number,
      merged: true,
      html_url: `https://github.com/owner/repo/pull/${opts.number}`,
      title: opts.title,
      body: opts.body,
      base: { ref: opts.baseRef ?? 'main' },
    },
    repository: { full_name: 'owner/repo', default_branch: opts.defaultBranch ?? 'main' },
  };
}

function seedLinkedNode(args: {
  nodeId: string;
  externalId: string;
  status?: string | null;
  percentComplete?: number | null;
}): NodeRecord {
  const node: NodeRecord = {
    id: args.nodeId,
    mapId: 'map-1',
    status: args.status ?? 'in_progress',
    percentComplete: args.percentComplete ?? 50,
    externalLinks: [
      {
        provider: 'github',
        externalId: args.externalId,
        url: `https://github.com/${args.externalId.replace('#', '/issues/')}`,
        syncEnabled: true,
        lastSyncedAt: null,
      },
    ],
  };
  return node;
}

beforeEach(() => {
  mocks.getNodeMock.mockReset();
  mocks.updateNodeMock.mockReset();
  mocks.selectNodesMock.mockReset();
  // Default to an empty result set; tests override per-case. Empty is
  // safe because both consumers — the integration-secret loop and the
  // findNodeByExternalId scan — expect an array.
  mocks.selectNodesMock.mockResolvedValue([]);
  mocks.broadcastMock.mockReset();
  mocks.verifySignatureMock.mockReset();
  mocks.verifySignatureMock.mockResolvedValue(true);
  mocks.closeGitHubIssueMock.mockReset();
  mocks.closeGitHubIssueMock.mockResolvedValue(undefined);
  mocks.handleAbandonedPrMock.mockReset();
  mocks.handleAbandonedPrMock.mockResolvedValue([]);
  // Clear call history but PRESERVE the implementation set in the
  // module-mock factory above — the spy delegates to real
  // processWebhook so the new V1-hotfix / missing-base.ref tests
  // exercise the production fall-through, not a noop stub.
  mocks.processWebhookMock.mockClear();
  process.env.GITHUB_APP_WEBHOOK_SECRET = 'test-secret';
});

describe('webhook: pull_request.closed merged=true (#152)', () => {
  it('transitions a single linked node to done', async () => {
    const node = seedLinkedNode({ nodeId: 'n-100', externalId: 'owner/repo#100' });
    mocks.selectNodesMock.mockResolvedValue([{ id: node.id, externalLinks: node.externalLinks }]);
    mocks.getNodeMock.mockResolvedValue(node);
    mocks.updateNodeMock.mockResolvedValue({ ...node, status: 'done', percentComplete: 100 });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: prMergedPayload({ number: 555, title: 'feat: add Y (Closes #100)', body: null }),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      received: true,
      action: 'pull_request.merged',
      prNumber: 555,
      matched: true,
    });
    expect(body.transitions).toEqual([
      { externalId: 'owner/repo#100', nodeId: 'n-100', status: 'transitioned' },
    ]);
    // handlePrClosed now also parses title-only Closes refs, so it
    // fires a linkedPr-clear updateNode alongside the status
    // transition. Filter to the transition call this test cares about.
    const doneCalls = mocks.updateNodeMock.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown> | undefined)?.status === 'done',
    );
    expect(doneCalls).toHaveLength(1);
    const [calledNodeId, calledFields] = doneCalls[0];
    expect(calledNodeId).toBe('n-100');
    expect(calledFields).toMatchObject({ status: 'done', percentComplete: 100 });
    expect(mocks.broadcastMock).toHaveBeenCalledWith(
      'map-1',
      expect.objectContaining({ type: 'node:updated', source: 'github_webhook_pr_merge' }),
    );
  });

  it('iterates ALL closing refs in PR body (multi-issue support)', async () => {
    const nodeA = seedLinkedNode({ nodeId: 'n-A', externalId: 'owner/repo#1' });
    const nodeB = seedLinkedNode({ nodeId: 'n-B', externalId: 'owner/repo#2' });
    mocks.selectNodesMock.mockResolvedValue([
      { id: nodeA.id, externalLinks: nodeA.externalLinks },
      { id: nodeB.id, externalLinks: nodeB.externalLinks },
    ]);
    mocks.getNodeMock.mockImplementation(async (id: string) =>
      id === 'n-A' ? nodeA : id === 'n-B' ? nodeB : null,
    );
    mocks.updateNodeMock.mockImplementation(async (id: string) => ({
      ...(id === 'n-A' ? nodeA : nodeB),
      status: 'done',
      percentComplete: 100,
    }));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: prMergedPayload({
        number: 999,
        title: 'big sweep',
        body: 'Closes #1, fixes #2',
      }),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    // handlePrClosed (linkedPr cleanup) ALSO fires once per node, so
    // the total updateNode count is 4 (2 linkedPr clears + 2 status
    // transitions). Filter to the status=done calls to assert on the
    // transition-specific behaviour this test cares about.
    const doneTransitionCalls = mocks.updateNodeMock.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown> | undefined)?.status === 'done',
    );
    expect(doneTransitionCalls).toHaveLength(2);
    const transitioned = res.json().transitions as Array<{ externalId: string; status: string }>;
    expect(transitioned).toHaveLength(2);
    expect(transitioned.every((t) => t.status === 'transitioned')).toBe(true);
  });

  it('is idempotent — replaying the same merge does NOT re-transition', async () => {
    const node = seedLinkedNode({
      nodeId: 'n-200',
      externalId: 'owner/repo#200',
      status: 'done',
      percentComplete: 100,
    });
    mocks.selectNodesMock.mockResolvedValue([{ id: node.id, externalLinks: node.externalLinks }]);
    mocks.getNodeMock.mockResolvedValue(node);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: prMergedPayload({ number: 200, title: 'Closes #200', body: null }),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().transitions).toEqual([
      { externalId: 'owner/repo#200', nodeId: 'n-200', status: 'already_done' },
    ]);
    // No status re-transition. handlePrClosed may still fire its
    // linkedPr-clear (title-only Closes refs are parsed now) — assert
    // no call wrote a status.
    const doneCalls = mocks.updateNodeMock.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown> | undefined)?.status != null,
    );
    expect(doneCalls).toHaveLength(0);
    expect(mocks.broadcastMock).not.toHaveBeenCalled();
  });

  it('reports refs with no linked node as not_linked (not an error)', async () => {
    mocks.selectNodesMock.mockResolvedValue([]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: prMergedPayload({ number: 7, title: 'Closes #404', body: null }),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      action: 'pull_request.merged',
      matched: false,
      transitions: [
        { externalId: 'owner/repo#404', nodeId: '', status: 'not_linked' },
      ],
    });
    expect(mocks.updateNodeMock).not.toHaveBeenCalled();
  });

  it('rejects unsigned requests with 401 before touching the DB', async () => {
    mocks.verifySignatureMock.mockResolvedValue(false);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=forged',
      },
      payload: prMergedPayload({ number: 1, title: 'Closes #1', body: null }),
    });
    await app.close();

    expect(res.statusCode).toBe(401);
    // The legacy PAT-secret lookup runs a SELECT before the 401, but
    // no mutations and no node lookups should fire.
    expect(mocks.updateNodeMock).not.toHaveBeenCalled();
    expect(mocks.getNodeMock).not.toHaveBeenCalled();
    expect(mocks.broadcastMock).not.toHaveBeenCalled();
  });

  it('PR closed without merging (merged=false) does not transition anything', async () => {
    const node = seedLinkedNode({ nodeId: 'n-300', externalId: 'owner/repo#300' });
    mocks.selectNodesMock.mockResolvedValue([{ id: node.id, externalLinks: node.externalLinks }]);
    mocks.getNodeMock.mockResolvedValue(node);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: {
        action: 'closed',
        pull_request: {
          number: 300,
          merged: false,
          html_url: 'https://github.com/owner/repo/pull/300',
          title: 'Closes #300',
          body: null,
        },
        repository: { full_name: 'owner/repo' },
      },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(mocks.updateNodeMock).not.toHaveBeenCalled();
    // Falls through to processWebhook mock (which returns a noop).
    expect(mocks.processWebhookMock).toHaveBeenCalled();
  });

  it('records the merge commit on the link — the evidence a later close needs', async () => {
    // `handlePrClosed` CLEARS the mirror on a default-branch merge, so
    // five minutes later a done node looks identical to one that never
    // had a PR. Without this stamp the outbound sync has nothing local
    // to close on and must pay for a probe — or, before the fix, closed
    // COMPLETED on no evidence at all.
    const node = seedLinkedNode({ nodeId: 'n-101', externalId: 'owner/repo#101' });
    mocks.selectNodesMock.mockResolvedValue([{ id: node.id, externalLinks: node.externalLinks }]);
    mocks.getNodeMock.mockResolvedValue(node);
    mocks.updateNodeMock.mockResolvedValue({ ...node, status: 'done', percentComplete: 100 });

    const payload = prMergedPayload({ number: 900, title: 't', body: 'Closes #101' });
    (payload.pull_request as Record<string, unknown>).merge_commit_sha = 'f00dcafe';

    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload,
    });
    await app.close();

    const doneCall = mocks.updateNodeMock.mock.calls.find(
      (call: unknown[]) => (call[1] as Record<string, unknown> | undefined)?.status === 'done',
    );
    const links = (doneCall![1] as { externalLinks: Array<Record<string, unknown>> }).externalLinks;
    expect(links[0]).toMatchObject({ mergeCommitSha: 'f00dcafe', mergedPrNumber: 900 });
  });

  it('records the merge commit even on the already-done path', async () => {
    // The node is NORMALLY already done here — the agent marks it done
    // when it opens the PR. If the idempotency short-circuit skipped
    // the stamp, the evidence would be recorded in exactly the case it
    // is never needed and skipped in the one where it always is.
    const node = seedLinkedNode({
      nodeId: 'n-102',
      externalId: 'owner/repo#102',
      status: 'done',
      percentComplete: 100,
    });
    mocks.selectNodesMock.mockResolvedValue([{ id: node.id, externalLinks: node.externalLinks }]);
    mocks.getNodeMock.mockResolvedValue(node);

    const payload = prMergedPayload({ number: 901, title: 't', body: 'Closes #102' });
    (payload.pull_request as Record<string, unknown>).merge_commit_sha = 'f00dcafe';

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload,
    });
    await app.close();

    expect(res.json().transitions).toEqual([
      { externalId: 'owner/repo#102', nodeId: 'n-102', status: 'already_done' },
    ]);
    const stampCall = mocks.updateNodeMock.mock.calls.find((call: unknown[]) => {
      const fields = call[1] as { externalLinks?: Array<Record<string, unknown>> };
      return fields.externalLinks?.[0]?.mergeCommitSha === 'f00dcafe';
    });
    expect(stampCall, 'merge commit was not stamped on the already-done path').toBeDefined();
    expect((stampCall![1] as Record<string, unknown>).status).toBeUndefined();
  });

  it('does not re-stamp the merge commit on a webhook replay', async () => {
    const node = seedLinkedNode({
      nodeId: 'n-103',
      externalId: 'owner/repo#103',
      status: 'done',
      percentComplete: 100,
    });
    node.externalLinks[0].mergeCommitSha = 'f00dcafe';
    mocks.selectNodesMock.mockResolvedValue([{ id: node.id, externalLinks: node.externalLinks }]);
    mocks.getNodeMock.mockResolvedValue(node);

    const payload = prMergedPayload({ number: 902, title: 't', body: 'Closes #103' });
    (payload.pull_request as Record<string, unknown>).merge_commit_sha = 'f00dcafe';

    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload,
    });
    await app.close();

    expect(mocks.updateNodeMock).not.toHaveBeenCalled();
  });
  it('PR merged to a NON-default branch (V1-hotfix flow) does NOT transition', async () => {
    // Regression for the 2026-06-11 drift on crm #2291 / #2292: a
    // PR targeting `release/v1` (V1 hotfix) merged with `Fixes #2291`
    // in the body. GitHub does NOT auto-close issues when a PR merges
    // to anything other than the default branch, but this handler used
    // to transition the linked node to `done` anyway — desyncing
    // MindBlown ("done") from GitHub ("open") and blocking re-dispatch
    // on `main` until the forward-port PR landed.
    //
    // The default-branch gate mirrors GitHub's own judgement: only
    // transition when base.ref === repository.default_branch.
    const node = seedLinkedNode({ nodeId: 'n-2291', externalId: 'owner/repo#2291' });
    mocks.selectNodesMock.mockResolvedValue([{ id: node.id, externalLinks: node.externalLinks }]);
    mocks.getNodeMock.mockResolvedValue(node);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: prMergedPayload({
        number: 2346,
        title: 'fix(#2291): sanitize LLM upstream errors',
        body: '## Summary\n\nFixes #2291. Raw error messages were leaking internal hostnames.',
        baseRef: 'release/v1',
        defaultBranch: 'main',
      }),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    // What MUST NOT happen on a non-default-branch merge is the
    // status → done transition. (handlePrClosed no longer clears
    // `linkedPr` on such merges either — covered by its own test
    // below.)
    const doneTransitionCalls = mocks.updateNodeMock.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown> | undefined)?.status === 'done',
    );
    expect(doneTransitionCalls).toHaveLength(0);
    expect(mocks.broadcastMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: 'github_webhook_pr_merge' }),
    );
    // Falls through to processWebhook mock.
    expect(mocks.processWebhookMock).toHaveBeenCalled();
  });

  it('PR merged to a NON-default branch keeps linkedPr armed (merged + landedOnDefault:false)', async () => {
    // Companion to the transition gate above, on the mirror side: a
    // release-branch merge means the work has NOT landed on main, so
    // the issue-close gate must stay armed. Clearing the mirror here
    // used to disarm it — the next outbound sync then closed the issue
    // as COMPLETED, and the catchup wiped the node with an empty
    // snapshot. The state stays 'merged' (NOT 'closed' — that would
    // let the catchup treat shipped release work like an abandoned
    // PR and wipe the node's done-state), flagged landedOnDefault:false.
    const node = seedLinkedNode({ nodeId: 'n-hf', externalId: 'owner/repo#77' });
    const linkedPr = {
      number: 555, repo: 'owner/repo', url: 'u', head: 'hotfix', base: 'release/v1',
      author: 'a', draft: false, state: 'open', mergeable: true, changedFiles: [],
      reviews: [], checks: { state: null, failures: [] }, lastSyncedAt: null,
    };
    mocks.selectNodesMock.mockResolvedValue([
      { id: node.id, externalLinks: node.externalLinks, linkedPr },
    ]);
    mocks.getNodeMock.mockResolvedValue(node);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: prMergedPayload({
        number: 555,
        title: 'hotfix',
        body: 'Fixes #77',
        baseRef: 'release/v1',
        defaultBranch: 'main',
      }),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const linkedPrWrites = mocks.updateNodeMock.mock.calls.filter(
      (call: unknown[]) =>
        Object.prototype.hasOwnProperty.call(call[1] ?? {}, 'linkedPr'),
    );
    expect(linkedPrWrites).toHaveLength(1);
    expect((linkedPrWrites[0][1] as { linkedPr: { state: string } }).linkedPr).toMatchObject({
      state: 'merged',
      landedOnDefault: false,
    });
  });

  it("a sibling PR's merge does NOT clear another PR's in-flight mirror (number guard)", async () => {
    // Supersede pattern: abandoned PR A and replacement PR B both say
    // 'Closes #88'; the mirror belongs to B (in flight). A's late
    // merge/close event must not clear or clobber B's mirror — that
    // would disarm the close gate while B still runs.
    const node = seedLinkedNode({ nodeId: 'n-88', externalId: 'owner/repo#88' });
    const linkedPrB = {
      number: 900, repo: 'owner/repo', url: 'u', head: 'fix-b', base: 'main',
      author: 'b', draft: false, state: 'open', mergeable: true, changedFiles: [],
      reviews: [], checks: { state: null, failures: [] }, lastSyncedAt: null,
    };
    mocks.selectNodesMock.mockResolvedValue([
      { id: node.id, externalLinks: node.externalLinks, linkedPr: linkedPrB },
    ]);
    mocks.getNodeMock.mockResolvedValue(node);

    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      // PR A (number 899) merges; mirror belongs to B (900).
      payload: prMergedPayload({ number: 899, title: 'old attempt', body: 'Closes #88' }),
    });
    await app.close();

    const linkedPrWrites = mocks.updateNodeMock.mock.calls.filter(
      (call: unknown[]) =>
        Object.prototype.hasOwnProperty.call(call[1] ?? {}, 'linkedPr'),
    );
    expect(linkedPrWrites).toHaveLength(0);
  });

  it('closes title-only-ref issues explicitly after a default-branch merge', async () => {
    // GitHub's auto-close honors closing keywords only in the PR BODY;
    // a title-only ref leaves the issue open after the merge. Since the
    // node just transitioned to done and the mirror is cleared, an open
    // issue would read as a reopen on the next catchup tick and revert
    // the shipped work — so the merge handler closes it itself.
    const node = seedLinkedNode({ nodeId: 'n-77', externalId: 'owner/repo#77' });
    // Chimera row: serves the node lookups AND getGitHubContextForRepo's
    // maps/integrations selects (the harness routes every db.select
    // through the same mock).
    mocks.selectNodesMock.mockResolvedValue([
      {
        id: node.id,
        externalLinks: node.externalLinks,
        installationId: 'inst-1',
        provider: 'github',
        enabled: true,
        config: { owner: 'owner', repo: 'repo', token: 'tok' },
      },
    ]);
    mocks.getNodeMock.mockResolvedValue(node);
    mocks.updateNodeMock.mockResolvedValue({ ...node, status: 'done', percentComplete: 100 });

    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: prMergedPayload({ number: 901, title: 'feat: thing (Closes #77)', body: null }),
    });
    // The close runs fire-and-forget after the response — let it drain.
    await new Promise((r) => setTimeout(r, 20));
    await app.close();

    expect(mocks.closeGitHubIssueMock).toHaveBeenCalledTimes(1);
    const closeCall = mocks.closeGitHubIssueMock.mock.calls[0] as unknown[];
    expect((closeCall[0] as { externalId: string }).externalId).toBe('owner/repo#77');
    expect(closeCall[2]).toBe('completed');
  });

  it('PR with missing base.ref does NOT transition status to done (fail-safe)', async () => {
    // Malformed or legacy payloads with no base.ref should NOT trigger
    // the status transition. Better to drop a real merge than to
    // wrongly transition a hotfix one — the drift audit (catchup) will
    // pick up any genuinely closed issue within 5min anyway.
    // handlePrClosed may still fire to clear linkedPr — that's fine.
    const node = seedLinkedNode({ nodeId: 'n-99', externalId: 'owner/repo#99' });
    mocks.selectNodesMock.mockResolvedValue([{ id: node.id, externalLinks: node.externalLinks }]);
    mocks.getNodeMock.mockResolvedValue(node);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: {
        action: 'closed',
        pull_request: {
          number: 99,
          merged: true,
          html_url: 'https://github.com/owner/repo/pull/99',
          title: 'Closes #99',
          body: null,
          // base intentionally omitted
        },
        repository: { full_name: 'owner/repo', default_branch: 'main' },
      },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const doneTransitionCalls = mocks.updateNodeMock.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown> | undefined)?.status === 'done',
    );
    expect(doneTransitionCalls).toHaveLength(0);
  });
});

describe('webhook: pull_request.closed merged=false → reopen sweep', () => {
  /**
   * Both the node scan and the PAT-integration lookup read through the
   * same stubbed `select().from().where()`, so one array serves both:
   * the node row (no `config`) and the integration row (no
   * `externalLinks`).
   */
  function seedRepoIntegration(extra: unknown[] = []): void {
    mocks.selectNodesMock.mockResolvedValue([
      { config: { owner: 'owner', repo: 'repo', token: 'pat-token' }, enabled: true },
      ...extra,
    ]);
  }

  function abandonedPayload(body: string | null, title = 'fix: something'): Record<string, unknown> {
    return {
      action: 'closed',
      pull_request: {
        number: 6089,
        merged: false,
        draft: false,
        state: 'closed',
        html_url: 'https://github.com/owner/repo/pull/6089',
        title,
        body,
        head: { ref: 'fix/6085', sha: 'abc' },
        base: { ref: 'main' },
        user: { login: 'django-dev-max' },
        mergeable: true,
      },
      repository: { full_name: 'owner/repo', default_branch: 'main' },
    };
  }

  it('runs the reopen sweep for a PR closed without merging', async () => {
    seedRepoIntegration();

    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: abandonedPayload('Closes #6085'),
    });
    await app.close();

    expect(mocks.handleAbandonedPrMock).toHaveBeenCalledTimes(1);
    const [ctx, pr] = mocks.handleAbandonedPrMock.mock.calls[0];
    expect(ctx).toMatchObject({ owner: 'owner', repo: 'repo', token: 'pat-token' });
    expect(pr).toMatchObject({ number: 6089, body: 'Closes #6085' });
  });

  it('does NOT run the reopen sweep when the PR merged', async () => {
    seedRepoIntegration();

    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: prMergedPayload({ number: 6089, title: 't', body: 'Closes #6085' }),
    });
    await app.close();

    expect(mocks.handleAbandonedPrMock).not.toHaveBeenCalled();
  });

  it('still acknowledges the webhook when the sweep throws', async () => {
    seedRepoIntegration();
    mocks.handleAbandonedPrMock.mockRejectedValue(new Error('GitHub API 502'));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: abandonedPayload('Closes #6085'),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
  });
});
