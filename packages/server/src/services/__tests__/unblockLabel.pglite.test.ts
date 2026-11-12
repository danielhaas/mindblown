/**
 * clear_blocker takes the `blocked` label off the linked issue too (#622).
 * On 12.11.2026 a cleared ticket kept `blocked` on its GitHub issue — the
 * outbound sync rewrites labels only on a link with sync on — and it had
 * to come off by hand.
 *
 * On PGlite: the real unblockNode. Only the forge is stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../../db/connection.js', async () =>
  (await import('../../test/pgliteDb.js')).pgliteConnection());
const forge = vi.hoisted(() => ({
  removeIssueLabel: vi.fn(async (..._args: unknown[]) => ({ status: 200, bodyText: '' })),
  endpoint: { kind: 'github' },
}));
vi.mock('../../lib/githubContext.js', () => ({ getGitHubContextForMap: vi.fn(async () => ({ owner: 'o', repo: 'r', forge })) }));

import { db } from '../../db/connection.js';
import { users, workspaces, maps, nodes } from '../../db/schema.js';
import { truncateAll } from '../../test/pgliteDb.js';
import { unblockNode } from '../unblock.js';

async function seed(extra: { tags?: string[]; linked?: boolean } = {}) {
  const [user] = await db.insert(users).values({ email: 'a@example.com', name: 'A' }).returning();
  const [ws] = await db.insert(workspaces).values({ name: 'W', slug: 'w', ownerId: user.id }).returning();
  const [map] = await db.insert(maps).values({ workspaceId: ws.id, name: 'M', createdBy: user.id }).returning();
  const [root] = await db.insert(nodes).values({ mapId: map.id, text: 'root', createdBy: user.id }).returning();
  const [node] = await db
    .insert(nodes)
    .values({
      mapId: map.id,
      parentId: root.id,
      text: 'CI red',
      createdBy: user.id,
      tags: extra.tags ?? ['blocked'],
      status: 'blocked',
      blockedReason: 'red CI',
      externalLinks: extra.linked === false ? [] : [{ provider: 'github', externalId: 'o/r#42', url: 'https://github.com/o/r/issues/42', syncEnabled: false, lastSyncedAt: null, isPullRequest: false }],
    })
    .returning();
  return { user, map, node };
}

async function reread(id: string) {
  const [row] = await db.select().from(nodes).where(eq(nodes.id, id));
  return row;
}

describe('unblockNode takes the blocked label off the linked issue (#622)', () => {
  beforeEach(async () => {
    await truncateAll(db);
    vi.clearAllMocks();
  });

  it('removes only `blocked` — a skip tag on the node stays a person\'s step', async () => {
    const { user, map, node } = await seed({ tags: ['blocked', 'needs-human'] });
    const out = await unblockNode(map.id, node.id, user.id);
    expect(forge.removeIssueLabel.mock.calls).toEqual([['o', 'r', 42, 'blocked']]);
    expect(out.labelWrite).toMatchObject({ kind: 'gh-edit', target: '#42', done: true });
    const after = await reread(node.id);
    expect(after.tags).toEqual(['needs-human']);
    expect(after.blockedReason).toBeNull();
  });

  it('a 404 (label not on the issue) is fine', async () => {
    forge.removeIssueLabel.mockResolvedValueOnce({ status: 404, bodyText: 'Label does not exist' });
    const { user, map, node } = await seed();
    const out = await unblockNode(map.id, node.id, user.id);
    expect(out.labelWrite?.done).toBe(true);
    expect(out.labelWrite?.error).toBeUndefined();
  });

  it('a 500 leaves the node unblocked and reports the failed label write', async () => {
    forge.removeIssueLabel.mockResolvedValueOnce({ status: 500, bodyText: 'boom' });
    const { user, map, node } = await seed();
    const out = await unblockNode(map.id, node.id, user.id);
    expect(out.labelWrite?.done).toBe(false);
    expect(out.labelWrite?.error).toBeTruthy();
    expect(out.statusReset).toBe(true);
    const after = await reread(node.id);
    expect(after.tags).toEqual([]);
    expect(after.blockedReason).toBeNull();
    expect(after.status).toBe('todo');
  });

  it('no linked issue, or no blocked tag: nothing goes to the forge', async () => {
    const a = await seed({ linked: false });
    expect((await unblockNode(a.map.id, a.node.id, a.user.id)).labelWrite).toBeUndefined();
    await truncateAll(db);
    const b = await seed({ tags: [] });
    expect((await unblockNode(b.map.id, b.node.id, b.user.id)).labelWrite).toBeUndefined();
    expect(forge.removeIssueLabel).not.toHaveBeenCalled();
  });
});
