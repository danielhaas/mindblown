/**
 * Publish a map's timeline to the workspace's Outline wiki (#637).
 *
 * One-way push: the map is the source, the wiki page is read-only output.
 * The first publish creates the document in the configured collection and
 * stores its id on the map (map_wiki_documents); every later publish
 * replaces that same document's content. A document someone deleted in the
 * wiki is created afresh rather than failing forever.
 *
 * The Outline connection (base URL, API token, collection) is workspace-wide,
 * like a workspace's GitHub token: an `integrations` row, provider 'outline',
 * the token sealed with ENCRYPTION_KEY when the server has one.
 */
import { createOutlineClient, outlineBase, OutlineApiError } from '@mindblown/integrations';
import * as mapDb from '../db/maps.js';
import * as wikiDb from '../db/wiki.js';
import { decrypt, encrypt, isEncrypted } from '../crypto.js';
import { buildTimelineMarkdown } from '../export/timeline.js';

export class WikiValidationError extends Error {}
export class WikiForbiddenError extends Error {}
export class WikiNotConfiguredError extends Error {}
export class WikiPublishError extends Error {}

export interface WikiStatus {
  configured: boolean;
  provider: 'outline';
  baseUrl: string | null;
  collectionId: string | null;
  document: { id: string; url: string; publishedAt: string } | null;
}

export interface WikiPublishResult {
  documentId: string;
  documentUrl: string;
  /** true = this publish created the document; false = it updated it. */
  created: boolean;
  publishedAt: string;
}

const FRONTEND_URL = () => (process.env.PUBLIC_URL || process.env.FRONTEND_URL || 'http://localhost:5180').replace(/\/+$/, '');

export function mapUrl(mapId: string): string {
  return `${FRONTEND_URL()}/?map=${mapId}`;
}

function seal(token: string): string {
  return process.env.ENCRYPTION_KEY ? encrypt(token) : token;
}

function open(stored: string): string {
  return isEncrypted(stored) ? decrypt(stored) : stored;
}

export async function wikiStatus(mapId: string): Promise<WikiStatus | null> {
  const ws = await wikiDb.mapWorkspace(mapId);
  if (!ws) return null;
  const config = await wikiDb.getOutlineConfig(ws.workspaceId);
  const doc = await wikiDb.getWikiDocument(mapId);
  return {
    configured: !!config,
    provider: 'outline',
    baseUrl: config ? outlineBase(config.baseUrl) : null,
    collectionId: config?.collectionId ?? null,
    document: doc ? { id: doc.documentId, url: doc.documentUrl, publishedAt: doc.publishedAt } : null,
  };
}

export interface WikiSettingsInput {
  baseUrl?: unknown;
  /** Omit to keep the stored token. */
  token?: unknown;
  collectionId?: unknown;
}

/** Set the workspace's Outline connection. The workspace owner only: the token speaks for the whole workspace. */
export async function saveWikiSettings(mapId: string, input: WikiSettingsInput, userId: string | null): Promise<WikiStatus | null> {
  const ws = await wikiDb.mapWorkspace(mapId);
  if (!ws) return null;
  if (!userId || ws.ownerId !== userId) {
    throw new WikiForbiddenError('Only the workspace owner may set the wiki connection');
  }
  if (typeof input.baseUrl !== 'string' || !input.baseUrl.trim()) throw new WikiValidationError('baseUrl is required (e.g. https://wiki.example.com)');
  let parsed: URL;
  try {
    parsed = new URL(input.baseUrl.trim());
  } catch {
    throw new WikiValidationError(`baseUrl is not a URL: ${input.baseUrl}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new WikiValidationError('baseUrl must be http(s)');
  if (typeof input.collectionId !== 'string' || !input.collectionId.trim()) throw new WikiValidationError('collectionId is required');

  const existing = await wikiDb.getOutlineConfig(ws.workspaceId);
  let token: string;
  if (input.token === undefined || input.token === null || input.token === '') {
    if (!existing) throw new WikiValidationError('token is required (an Outline API token)');
    token = existing.token;
  } else if (typeof input.token !== 'string') {
    throw new WikiValidationError('token must be a string');
  } else {
    token = seal(input.token.trim());
  }
  await wikiDb.saveOutlineConfig(ws.workspaceId, {
    baseUrl: outlineBase(parsed.toString()),
    token,
    collectionId: input.collectionId.trim(),
  });
  return wikiStatus(mapId);
}

/** The note at the top of the wiki page: read-only output, edit the map. */
export function wikiPreface(mapId: string): string[] {
  return [
    `> **Generated from MindBlown — do not edit here.** This page is overwritten each time the plan is published. Change the plan in the [map](${mapUrl(mapId)}).`,
  ];
}

/** The document body for the wiki: Outline keeps the title separately, so the H1 goes. */
function splitTitle(markdown: string): { title: string; text: string } {
  const m = /^# (.+)\n+/.exec(markdown);
  if (!m) return { title: 'Timeline', text: markdown };
  return { title: m[1].trim(), text: markdown.slice(m[0].length) };
}

export async function publishMapToWiki(
  mapId: string,
  opts: { userId?: string | null; timeZone?: string; now?: Date; fetch?: typeof fetch } = {},
): Promise<WikiPublishResult | null> {
  const data = await mapDb.getMap(mapId);
  if (!data) return null;
  const config = await wikiDb.getOutlineConfig(data.map.workspaceId);
  if (!config) {
    throw new WikiNotConfiguredError(
      'No wiki is connected to this workspace yet — set the Outline URL, API token and collection under Import / Export → Publish to wiki (PUT /api/maps/:id/wiki).',
    );
  }
  const now = opts.now ?? new Date();
  const markdown = buildTimelineMarkdown(data, { timeZone: opts.timeZone, preface: wikiPreface(mapId), now });
  const { title, text } = splitTitle(markdown);
  const client = createOutlineClient({ baseUrl: config.baseUrl, token: open(config.token), fetch: opts.fetch });

  const existing = await wikiDb.getWikiDocument(mapId);
  let doc: { id: string; url: string } | null = null;
  let created = false;
  try {
    if (existing) {
      try {
        doc = await client.updateDocument({ id: existing.documentId, title, text });
      } catch (err) {
        // Deleted in the wiki: start a new page rather than fail every time.
        if (!(err instanceof OutlineApiError) || err.status !== 404) throw err;
      }
    }
    if (!doc) {
      doc = await client.createDocument({ title, text, collectionId: config.collectionId });
      created = true;
    }
  } catch (err) {
    if (err instanceof OutlineApiError) throw new WikiPublishError(err.message);
    // fetch's own failure (DNS, refused, TLS) — the wiki is unreachable.
    if (err instanceof TypeError) throw new WikiPublishError(`Could not reach the wiki at ${outlineBase(config.baseUrl)}: ${err.message}`);
    throw err;
  }

  await wikiDb.saveWikiDocument(mapId, { documentId: doc.id, documentUrl: doc.url, publishedAt: now, publishedBy: opts.userId ?? null });
  return { documentId: doc.id, documentUrl: doc.url, created, publishedAt: now.toISOString() };
}
