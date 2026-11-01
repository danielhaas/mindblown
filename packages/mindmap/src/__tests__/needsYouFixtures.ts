/**
 * Tickets in each "Needs you" state (#610), shared by the component tests
 * and the Playwright harness (e2e/harness.tsx).
 */
import type { AskRow, Node, PendingApproval, StatusDef } from '@mindblown/core';

export const MAP_ID = 'map-1';

export const WORKFLOW: StatusDef[] = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '#64748b', position: 0 },
  { id: 'doing', name: 'Doing', category: 'in_progress', color: '#2563eb', position: 1 },
  { id: 'done', name: 'Done', category: 'done', color: '#16a34a', position: 2 },
];

const APPROVED = { state: 'approved', merge: 'auto', by: null, at: '2026-10-28T00:00:00.000Z' } as const;
const PROPOSED = { state: 'proposed', merge: 'pr-only', by: null, at: '2026-10-30T00:00:00.000Z' } as const;

export function makeNode(id: string, extra: Partial<Node> = {}): Node {
  return {
    id,
    mapId: MAP_ID,
    parentId: 'root',
    childrenIds: [],
    text: id,
    description: 'A brief long enough to work from.',
    externalLinks: [],
    status: 'todo',
    tags: [],
    blockedReason: null,
    approval: APPROVED,
    priority: null,
    effortEstimate: null,
    percentComplete: null,
    dueDate: null,
    startDate: null,
    assigneeIds: [],
    dependencies: [],
    scopes: [],
    revision: 1,
    ...extra,
  } as unknown as Node;
}

export const ROOT = makeNode('root', { parentId: null, text: 'Project', approval: null, childrenIds: ['approve', 'question', 'blocked', 'brief', 'held', 'plain'] });
export const APPROVE = makeNode('approve', { text: 'Add CSV export', approval: PROPOSED, revision: 3 });
export const QUESTION = makeNode('question', { text: 'Pick a chart library' });
export const BLOCKED = makeNode('blocked', { text: 'Deploy to staging', blockedReason: 'Needs the staging token' });
export const BRIEF = makeNode('brief', { text: 'Locations', description: null });
export const HELD = makeNode('held', { text: 'Rotate keys', tags: ['needs-human'] });
export const PLAIN = makeNode('plain', { text: 'Nothing waits here' });
export const ALL_NODES = [ROOT, APPROVE, QUESTION, BLOCKED, BRIEF, HELD, PLAIN];

export const PENDING: PendingApproval = {
  mapId: MAP_ID,
  mapName: 'Project',
  nodeId: 'approve',
  revision: 3,
  title: 'Add CSV export',
  description: 'Export the list as CSV.',
  reportedBy: null,
  reporterLabel: 'github:octo',
  trustLevel: 'external',
  approval: PROPOSED,
  issue: { ref: '#12', url: 'https://github.com/o/r/issues/12' },
  hints: ['asks for credentials'],
  canApprove: true,
  createdAt: '2026-10-30T00:00:00.000Z',
};

export const ASK: AskRow = {
  ask: {
    id: 'ask-7',
    ticket: 7,
    requirement: null,
    title: 'Pick a chart library',
    url: null,
    sources: ['tick:decision'],
    question: 'Recharts or visx?',
    question_author: 'worker',
    options: ['Recharts', 'visx'],
    answerer: 'Dan',
    hint: 'decision',
    priority: null,
    milestone: null,
    needs_version: false,
    idle_hours: null,
    unblocks: { node_id: 'question', node_title: 'Pick a chart library', node_status: 'todo', claimed_by: null, worker: null, pr: null, pr_state: null },
    moot: false,
  },
  mapId: MAP_ID,
  status: 'open',
  pushedAt: '2026-10-31T00:00:00.000Z',
  firstSeenAt: '2026-10-31T00:00:00.000Z',
  answer: null,
  answeredBy: null,
  answeredAt: null,
  writes: [],
  workerPending: false,
};
