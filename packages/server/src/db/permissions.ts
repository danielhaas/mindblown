import { db } from './connection.js';
import { mapPermissions, maps, users } from './schema.js';
import { eq, and } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

export type PermissionLevel = 'view' | 'edit' | 'admin';

export async function setPermission(mapId: string, userId: string, permission: PermissionLevel) {
  // Upsert: try insert, on conflict update
  const existing = await db
    .select()
    .from(mapPermissions)
    .where(and(eq(mapPermissions.mapId, mapId), eq(mapPermissions.userId, userId)))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(mapPermissions)
      .set({ permission })
      .where(and(eq(mapPermissions.mapId, mapId), eq(mapPermissions.userId, userId)));
  } else {
    await db.insert(mapPermissions).values({ mapId, userId, permission });
  }

  return { mapId, userId, permission };
}

export async function getPermission(mapId: string, userId: string): Promise<PermissionLevel | null> {
  // Check if user is the map creator (always admin)
  const [map] = await db.select({ createdBy: maps.createdBy }).from(maps).where(eq(maps.id, mapId)).limit(1);
  if (map && map.createdBy === userId) {
    return 'admin';
  }

  const [row] = await db
    .select({ permission: mapPermissions.permission })
    .from(mapPermissions)
    .where(and(eq(mapPermissions.mapId, mapId), eq(mapPermissions.userId, userId)))
    .limit(1);

  return (row?.permission as PermissionLevel) ?? null;
}

export async function listPermissions(mapId: string) {
  const rows = await db
    .select({
      mapId: mapPermissions.mapId,
      userId: mapPermissions.userId,
      permission: mapPermissions.permission,
      userName: users.name,
      userEmail: users.email,
    })
    .from(mapPermissions)
    .innerJoin(users, eq(mapPermissions.userId, users.id))
    .where(eq(mapPermissions.mapId, mapId));

  return rows;
}

export async function revokePermission(mapId: string, userId: string) {
  const [deleted] = await db
    .delete(mapPermissions)
    .where(and(eq(mapPermissions.mapId, mapId), eq(mapPermissions.userId, userId)))
    .returning();
  return deleted ?? null;
}

export async function generatePublicToken(mapId: string): Promise<string | null> {
  const token = randomBytes(32).toString('hex');
  const [updated] = await db
    .update(maps)
    .set({ publicToken: token })
    .where(eq(maps.id, mapId))
    .returning({ id: maps.id, publicToken: maps.publicToken });
  return updated ? token : null;
}

export async function getMapByPublicToken(token: string) {
  const [map] = await db
    .select()
    .from(maps)
    .where(eq(maps.publicToken, token))
    .limit(1);
  return map ?? null;
}

/**
 * Check if a permission level grants at least the required level.
 * admin > edit > view
 */
export function hasPermission(actual: PermissionLevel | null, required: PermissionLevel): boolean {
  if (!actual) return false;
  const levels: Record<PermissionLevel, number> = { view: 1, edit: 2, admin: 3 };
  return levels[actual] >= levels[required];
}
