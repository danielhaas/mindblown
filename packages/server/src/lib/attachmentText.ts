/**
 * Reading an attachment's *contents* — the text an AI can reason over.
 *
 * Attachments were metadata-only until now: a URL, a title, a type. An
 * agent could list them and fetch the capability URL with its own HTTP
 * client, but nothing inside MindBlown handed it the text. This module is
 * that read path, shared by the REST route
 * (`GET …/attachments/:attachmentId/text`) and the in-app chat backend.
 *
 * What it reads: files stored in our own media directory — the ones an
 * upload minted a `/api/media/<id>/<name>` URL for. Text-like files come
 * back verbatim (UTF-8), PDFs through a text extractor. Everything else
 * (images, video, office documents, archives) and every external link is
 * refused with a reason the caller can pass on, never fetched: this module
 * never opens a network connection.
 *
 * The result is paged by character offset, because an attachment can be
 * 100 MB and a tool result cannot. Extraction runs on every page request;
 * that is deliberate — a cache is a second thing to get wrong, and paging
 * through one big file is the rare case, not the common one.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Attachment } from '@mindblown/core';
import { MEDIA_ROUTE_PREFIX, downloadName, isMediaId, mediaDir } from './media.js';

/** Files above this are not read at all — the whole file has to fit in memory to extract. */
export const EXTRACT_MAX_BYTES = 32 * 1024 * 1024;

/** Default page size in characters — a comfortable tool result, ~5k tokens. */
export const DEFAULT_PAGE_CHARS = 20_000;
/** Ceiling on one page — enough for a whole spec, small enough to never blow a context. */
export const MAX_PAGE_CHARS = 200_000;

/** How many leading bytes the text sniff looks at. */
const SNIFF_BYTES = 64 * 1024;

/** Extensions read as plain text without sniffing. Lower-case, no dot. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst', 'adoc', 'org', 'tex',
  'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'xml', 'html', 'htm', 'svg', 'log',
  'sh', 'bash', 'zsh', 'ps1', 'bat',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'php', 'java', 'kt', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'sql', 'css', 'scss', 'less',
  'diff', 'patch',
]);

export type NotReadableReason =
  /** The attachment is a link, not a stored file. */
  | 'link'
  /** A file, but its URL is not one of our media URLs — stored somewhere else. */
  | 'external'
  /** Our URL, but nothing on disk under that id any more. */
  | 'missing'
  /** Bigger than `EXTRACT_MAX_BYTES`. */
  | 'too_large'
  /** A type with no text in it (image, video, archive, office document…). */
  | 'binary'
  /** The extractor failed — a broken or encrypted PDF, for instance. */
  | 'unreadable';

export interface ReadableText {
  readable: true;
  /** The name a person knows the file by (without our `.bin`). */
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** Length of the whole extracted text, before paging. */
  totalChars: number;
  /** Where this page starts. */
  offset: number;
  text: string;
  /** True when there is more text after this page. */
  truncated: boolean;
  /** PDFs only. */
  pages: number | null;
}

export interface NotReadable {
  readable: false;
  reason: NotReadableReason;
  /** One sentence for the caller to pass on. */
  message: string;
}

export type AttachmentText = ReadableText | NotReadable;

export interface ReadOptions {
  /** Character offset the page starts at. Default 0. */
  offset?: number;
  /** Page size in characters. Default `DEFAULT_PAGE_CHARS`, capped at `MAX_PAGE_CHARS`. */
  limit?: number;
}

/** A stored file's location, resolved from a minted media URL. */
export interface StoredMediaLocation {
  id: string;
  /** Name on disk (may carry `.bin`). */
  storedName: string;
  /** Absolute path under the media directory. */
  file: string;
}

/**
 * Where a media URL points on disk — or null when the URL is not shaped
 * like one we minted. The host is not checked: `MEDIA_PUBLIC_BASE_URL` can
 * differ from what an older attachment carries, and the 160-bit id plus
 * the existence check are what make the path trustworthy, not the host.
 * The filename is reduced to its basename, so a URL cannot walk out of the
 * id's directory.
 */
export function storedMediaLocation(url: string, root: string = mediaDir()): StoredMediaLocation | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const prefix = `${MEDIA_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length).split('/');
  if (rest.length !== 2) return null;
  const [id, rawName] = rest;
  if (!isMediaId(id)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawName);
  } catch {
    return null;
  }
  const storedName = path.basename(decoded);
  if (!storedName || storedName === '.' || storedName === '..') return null;
  return { id, storedName, file: path.join(root, id, storedName) };
}

/** Last extension of a display name, lower-case, or '' when there is none. */
function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

function isTextMime(mime: string | null | undefined): boolean {
  const m = (mime ?? '').split(';')[0].trim().toLowerCase();
  if (!m) return false;
  if (m.startsWith('text/')) return true;
  return /^application\/(json|xml|yaml|x-yaml|toml|javascript|typescript|x-sh|sql|x-ndjson)$/.test(m) || m.endsWith('+json') || m.endsWith('+xml');
}

/**
 * Is this buffer plain text? Valid UTF-8 in its first 64 KB and no NUL
 * byte. Good enough to accept a `.foo` file someone renamed and to reject
 * every real binary format, which all carry NULs early.
 */
export function looksLikeText(bytes: Buffer): boolean {
  const head = bytes.subarray(0, SNIFF_BYTES);
  if (head.includes(0)) return false;
  try {
    // A cut in the middle of a multi-byte sequence at the sniff boundary
    // must not count as invalid — decode with a stream flag.
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: head.length === SNIFF_BYTES });
    return true;
  } catch {
    return false;
  }
}

function decodeText(bytes: Buffer): string {
  let text = bytes.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, '\n');
}

async function extractPdf(bytes: Buffer): Promise<{ text: string; pages: number }> {
  // Loaded on first use: unpdf pulls a full pdf.js in, and most servers
  // never read a PDF.
  const { extractText, getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const result = await extractText(doc, { mergePages: true });
  const text = result.text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, pages: result.totalPages };
}

/** Cut one page out of the text. Clamps the offset; the limit is defaulted and capped. */
export function pageOf(
  text: string,
  opts: ReadOptions,
): Pick<ReadableText, 'totalChars' | 'offset' | 'text' | 'truncated'> {
  const totalChars = text.length;
  const offset = Math.min(Math.max(0, Math.floor(opts.offset ?? 0)), totalChars);
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_PAGE_CHARS)), MAX_PAGE_CHARS);
  const end = Math.min(offset + limit, totalChars);
  return { totalChars, offset, text: text.slice(offset, end), truncated: end < totalChars };
}

function notReadable(reason: NotReadableReason, message: string): NotReadable {
  return { readable: false, reason, message };
}

/**
 * Read one attachment as text, one page of it. Never throws for an
 * attachment that simply cannot be read — that is a `readable: false`
 * answer with a reason. Throws only for what is a bug or an outage
 * (a media directory that cannot be read at all).
 */
export async function readAttachmentText(
  attachment: Pick<Attachment, 'kind' | 'url' | 'title' | 'mimeType'>,
  opts: ReadOptions = {},
  root: string = mediaDir(),
): Promise<AttachmentText> {
  if (attachment.kind !== 'file') {
    return notReadable('link', 'This attachment is a link, not a stored file. Open the URL to read it.');
  }
  const loc = storedMediaLocation(attachment.url, root);
  if (!loc) {
    return notReadable('external', 'This file is not stored in MindBlown. Open the URL to read it.');
  }

  let size: number;
  try {
    size = (await stat(loc.file)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return notReadable('missing', 'The stored file is gone from the media directory.');
    }
    throw err;
  }
  if (size > EXTRACT_MAX_BYTES) {
    return notReadable(
      'too_large',
      `The file is ${formatBytes(size)}; only files up to ${formatBytes(EXTRACT_MAX_BYTES)} are read as text. Open the URL instead.`,
    );
  }

  const filename = downloadName(loc.storedName);
  const ext = extensionOf(filename);
  const contentType = (attachment.mimeType ?? '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  const bytes = await readFile(loc.file);

  if (ext === 'pdf' || contentType === 'application/pdf') {
    try {
      const { text, pages } = await extractPdf(bytes);
      return { readable: true, filename, contentType, sizeBytes: size, pages, ...pageOf(text, opts) };
    } catch (err) {
      return notReadable(
        'unreadable',
        `The PDF could not be read (${(err as Error).message}). It may be encrypted or damaged.`,
      );
    }
  }

  if (TEXT_EXTENSIONS.has(ext) || isTextMime(contentType) || looksLikeText(bytes)) {
    return { readable: true, filename, contentType, sizeBytes: size, pages: null, ...pageOf(decodeText(bytes), opts) };
  }

  return notReadable(
    'binary',
    `"${filename}" (${contentType}) has no text to extract. Text files, source code, CSV/JSON and PDFs are readable; images, video, archives and office documents are not — open the URL instead.`,
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
