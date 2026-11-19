/**
 * Wiki publish storage (#637): the workspace's Outline connection (an
 * `integrations` row, provider 'outline') and the document each map's
 * timeline is published to (`map_wiki_documents`).
 */
import { and, eq } from 'drizzle-orm';
import { db } from './connection.js';
import { integrations, mapWikiDocuments, maps, workspaces } from './schema.js';

export const OUTLINE_PROVIDER = 'outline';

/** As stored: the token sealed (services/wikiPublish.ts seals and opens it). */
export interface StoredOutlineConfig {
  baseUrl: string;
  token: string;
  collectionId: string;
}

export interface WikiDocumentRow {
  mapId: string;
  provider: string;
  documentId: string;
  documentUrl: string;
  publishedAt: string;
}

/** The map's workspace and that workspace's owner; null = no such map. */
export async function mapWorkspace(mapId: string): Promise<{ workspaceId: string; ownerId: string | null } | null> {
  const [r] = await db
    .select({ workspaceId: maps.workspaceId, ownerId: workspaces.ownerId })
    .from(maps)
    .leftJoin(workspaces, eq(workspaces.id, maps.workspaceId))
    .where(eq(maps.id, mapId))
    .limit(1);
  return r ? { workspaceId: r.workspaceId, ownerId: r.ownerId ?? null } : null;
}

export async function getOutlineConfig(workspaceId: string): Promise<StoredOutlineConfig | null> {
  const [row] = await db
    .select({ config: integrations.config, enabled: integrations.enabled })
    .from(integrations)
    .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, OUTLINE_PROVIDER)))
    .limit(1);
  if (!row || !row.enabled) return null;
  const c = row.config as Partial<StoredOutlineConfig>;
  if (!c.baseUrl || !c.token || !c.collectionId) return null;
  return { baseUrl: c.baseUrl, token: c.token, collectionId: c.collectionId };
}

export async function saveOutlineConfig(workspaceId: string, config: StoredOutlineConfig): Promise<void> {
  const [existing] = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, OUTLINE_PROVIDER)))
    .limit(1);
  if (existing) {
    await db
      .update(integrations)
      .set({ config, enabled: true, updatedAt: new Date() })
      .where(eq(integrations.id, existing.id));
  } else {
    await db.insert(integrations).values({ workspaceId, provider: OUTLINE_PROVIDER, config });
  }
}

export async function getWikiDocument(mapId: string): Promise<WikiDocumentRow | null> {
  const [r] = await db.select().from(mapWikiDocuments).where(eq(mapWikiDocuments.mapId, mapId)).limit(1);
  if (!r) return null;
  return {
    mapId: r.mapId,
    provider: r.provider,
    documentId: r.documentId,
    documentUrl: r.documentUrl,
    publishedAt: new Date(r.publishedAt).toISOString(),
  };
}

export async function saveWikiDocument(
  mapId: string,
  doc: { documentId: string; documentUrl: string; publishedAt: Date; publishedBy: string | null },
): Promise<void> {
  const values = { mapId, provider: OUTLINE_PROVIDER, ...doc };
  await db
    .insert(mapWikiDocuments)
    .values(values)
    .onConflictDoUpdate({
      target: mapWikiDocuments.mapId,
      set: { documentId: doc.documentId, documentUrl: doc.documentUrl, publishedAt: doc.publishedAt, publishedBy: doc.publishedBy },
    });
}
