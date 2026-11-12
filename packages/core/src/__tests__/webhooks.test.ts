import { describe, it, expect } from 'vitest';
import { isWebhookEvent, statusCategory, webhookEventsForNodeUpdate } from '../webhooks.js';
import type { Node, StatusDef } from '../types.js';

const workflow: StatusDef[] = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '#000', position: 0 },
  { id: 'doing', name: 'In Progress', category: 'in_progress', color: '#000', position: 1 },
  { id: 'done', name: 'Done', category: 'done', color: '#000', position: 2 },
];

function node(over: Partial<Node> = {}): Node {
  return {
    id: 'n1', mapId: 'm1', text: 'Ship it', status: 'todo', claimedBySession: null, blockedReason: null,
    dueDate: null, percentComplete: null, childrenIds: [],
    ...over,
  } as Node;
}

describe('webhookEventsForNodeUpdate', () => {
  it('a status change into a done status is status_changed + done', () => {
    const out = webhookEventsForNodeUpdate(['status', 'percentComplete'], node({ status: 'done' }), workflow);
    expect(out.map((e) => e.event)).toEqual(['node.status_changed', 'node.done']);
    expect(out[0].data).toMatchObject({ status: 'done', category: 'done', node: { id: 'n1', text: 'Ship it' } });
  });

  it('matches a status by name too', () => {
    expect(webhookEventsForNodeUpdate(['status'], node({ status: 'in progress' }), workflow)[0].data.category).toBe('in_progress');
    expect(statusCategory(workflow, 'DONE')).toBe('done');
    expect(statusCategory(workflow, null)).toBeNull();
  });

  it('claim set = claimed with the session, claim cleared = released', () => {
    expect(webhookEventsForNodeUpdate(['claimedBySession', 'claimedAt'], node({ claimedBySession: 's-1' }), workflow)).toEqual([
      { event: 'node.claimed', data: expect.objectContaining({ sessionId: 's-1' }) },
    ]);
    expect(webhookEventsForNodeUpdate(['claimedBySession'], node(), workflow).map((e) => e.event)).toEqual(['node.released']);
  });

  it('a blocker set is blocked; a blocker cleared is nothing', () => {
    expect(webhookEventsForNodeUpdate(['blockedReason'], node({ blockedReason: 'needs Dan' }), workflow)).toEqual([
      { event: 'node.blocked', data: expect.objectContaining({ reason: 'needs Dan' }) },
    ]);
    expect(webhookEventsForNodeUpdate(['blockedReason'], node(), workflow)).toEqual([]);
  });

  it('fields that mean nothing to a subscriber are nothing', () => {
    expect(webhookEventsForNodeUpdate(['text', 'tags'], node({ status: 'done', claimedBySession: 's' }), workflow)).toEqual([]);
  });
});

describe('isWebhookEvent', () => {
  it('knows the vocabulary', () => {
    expect(isWebhookEvent('queue.empty')).toBe(true);
    expect(isWebhookEvent('node.deleted')).toBe(false);
  });
});
