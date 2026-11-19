/**
 * A free-text answer on a "Your steps" row is a decision that hands the
 * ticket back (#619). On 12.11.2026 three decision tickets answered "yes"
 * from the card stayed held: the answer replaced the question as the next
 * step, needs-human and blocked stayed on, and the fleet never saw them.
 *
 * End to end on PGlite: answer_ask's service with a `step-<nodeId>` id, the
 * real lint fix, the real pull. Only the forge and the socket are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../../db/connection.js', async () =>
  (await import('../../test/pgliteDb.js')).pgliteConnection());
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../routes/nodes.js', () => ({ syncNodeToGitHub: vi.fn(async () => {}) }));
const forge = vi.hoisted(() => ({
  removeIssueLabel: vi.fn(async (_o: string, _r: string, _n: number, label: string) => ({ status: ['blocked', 'needs-human'].includes(label) ? 200 : 404, bodyText: '' })),
  endpoint: { kind: 'github' },
}));
vi.mock('../../lib/githubContext.js', () => ({ getGitHubContextForMap: vi.fn(async () => ({ owner: 'o', repo: 'r', forge })) }));
const commentOnGitHubIssue = vi.hoisted(() => vi.fn(async () => ({ id: 1, html_url: 'x' })));
vi.mock('@mindblown/integrations', async (importOriginal) => ({ ...(await importOriginal<object>()), commentOnGitHubIssue }));

import { db } from '../../db/connection.js';
import { users, workspaces, maps, nodes, fleets } from '../../db/schema.js';
import { truncateAll } from '../../test/pgliteDb.js';
import { answerAsk } from '../asks.js';
import { getNextTicket } from '../orchestration.js';

async function seed() {
  const [user] = await db.insert(users).values({ email: 'a@example.com', name: 'A' }).returning();
  const [ws] = await db.insert(workspaces).values({ name: 'W', slug: 'w', ownerId: user.id }).returning();
  const [fleet] = await db.insert(fleets).values({ name: 'F', ownerId: user.id }).returning();
  const [map] = await db.insert(maps).values({ workspaceId: ws.id, name: 'M', createdBy: user.id, maxActiveClaims: 2 }).returning();
  const [root] = await db.insert(nodes).values({ mapId: map.id, text: 'root', createdBy: user.id }).returning();
  const [step] = await db
    .insert(nodes)
    .values({
      mapId: map.id,
      parentId: root.id,
      text: 'Decision: allow the import on prod?',
      createdBy: user.id,
      tags: ['needs-human', 'blocked'],
      status: 'todo',
      blockedReason: 'needs a decision',
      approval: { state: 'approved' },
      description: '**Next step (a person): allow the import on prod?**\n\nThe import rewrites customer ids.',
      externalLinks: [{ provider: 'github', externalId: 'o/r#42', url: 'https://github.com/o/r/issues/42', syncEnabled: false, lastSyncedAt: null, isPullRequest: false }],
    })
    .returning();
  return { user, fleet, map, step };
}

describe('a step answered with free text (#619)', () => {
  beforeEach(async () => {
    await truncateAll(db);
    vi.clearAllMocks();
  });

  it('records the decision, hands the ticket to the fleet and takes the hold labels off', async () => {
    const { user, fleet, map, step } = await seed();
    expect((await getNextTicket(map.id, 'before')).granted).toBe(false);

    const out = await answerAsk({ fleetId: fleet.id, mapId: map.id, askId: `step-${step.id}` }, { action: 'answered', decision: 'yes, allow it. But keep a dry-run option', by: 'Dan' }, user.id);
    expect(out.ok).toBe(true);

    const date = new Date().toISOString().slice(0, 10);
    const line = `Decision (Dan, ${date}): yes, allow it. But keep a dry-run option`;
    const [after] = await db.select().from(nodes).where(eq(nodes.id, step.id));
    expect(after.description).toBe(`**${line}**\n\nThe import rewrites customer ids.`);
    expect(after.tags).toEqual([]);
    expect(after.blockedReason).toBeNull();
    expect(after.status).toBe('todo');

    expect(commentOnGitHubIssue).toHaveBeenCalledWith('o', 'r', 42, expect.stringContaining(`**${line}**`), forge);
    const removed = forge.removeIssueLabel.mock.calls.map((c) => c[3]);
    expect(removed).toEqual(expect.arrayContaining(['blocked', 'needs-human']));

    const pull = await getNextTicket(map.id, 'worker-1');
    expect(pull.granted).toBe(true);
    expect(pull.ticket?.id).toBe(step.id);
  });

  it('"Still mine" keeps the step, the text its new next step; nothing goes to the issue', async () => {
    const { user, fleet, map, step } = await seed();
    const out = await answerAsk({ fleetId: fleet.id, mapId: map.id, askId: `step-${step.id}` }, { action: 'answered', decision: 'ask Rita first', next: 'mine' }, user.id);
    expect(out.ok).toBe(true);
    const [after] = await db.select().from(nodes).where(eq(nodes.id, step.id));
    expect(after.tags).toContain('needs-human');
    expect(String(after.description)).toMatch(/^\*\*Next step \(a person\): ask Rita first\*\*/);
    expect(commentOnGitHubIssue).not.toHaveBeenCalled();
    expect(forge.removeIssueLabel).not.toHaveBeenCalled();
    expect((await getNextTicket(map.id, 'worker-1')).granted).toBe(false);
  });
});
