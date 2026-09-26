/**
 * Attachments — files and links a person (or an agent) hangs on a node.
 *
 * Agents could already *see* attachments in `get_map` output; until these
 * tools they had no way to add one. A fleet worker that produces a review,
 * a screenshot or an export had nowhere to put it except a URL pasted into
 * the description. These three close that: hang a link, upload a small
 * file inline, take one down again.
 *
 * Two doors for a file, on purpose. `attach_file` takes the bytes as
 * base64 in the tool arguments — simple, and enough for what an agent
 * produces (a report, a screenshot). It is capped well below the multipart
 * route's ceiling, and the error for anything bigger says exactly what to
 * run instead: multipart to `POST /api/media` with an API key, then
 * `attach_link` with the returned URL and `kind: 'file'`.
 */

import { z } from 'zod';
import { defineTool } from '../spec.js';
import type { AttachmentSummary, NodeWithComputed } from '../types.js';

/** Decoded-size ceiling for an inline file — mirrors the server route's cap. */
export const INLINE_FILE_MAX_BYTES = 8 * 1024 * 1024;

const MULTIPART_HINT =
  'Upload larger files with multipart instead: ' +
  'curl -H "Authorization: Bearer <api key>" -F file=@<path> <server>/api/media ' +
  "— then hang the returned url on the node with attach_link (kind: 'file').";

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Bytes a base64 string decodes to, without decoding it. */
export function base64DecodedLength(b64: string): number {
  const clean = b64.replace(/\s+/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/** The attachment the call just added: the newest one carrying that URL. */
function newest(node: NodeWithComputed, url: string): AttachmentSummary | undefined {
  const matching = (node.attachments ?? []).filter((a) => a.url === url);
  return matching.sort((a, b) => b.addedAt.localeCompare(a.addedAt))[0];
}

function countLine(node: NodeWithComputed): string {
  const n = node.attachments?.length;
  return n == null ? '' : `\nThe node now has ${n} attachment${n === 1 ? '' : 's'}.`;
}

export const attachLinkTool = defineTool({
  name: 'attach_link',
  description:
    "Hang a link on a node — a spec, a design, a PR, a document somewhere else. Also the second step for a file uploaded via multipart POST /api/media: pass its url with kind 'file'. Attachments show in the node's property panel, in the map's Files tab, and in get_map / list_attachments output. To attach a file that belongs to the whole map rather than one node, use the map's root node id.",
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('Node to hang the link on (the root node id for a map-level file)'),
    url: z.string().describe('Absolute http(s) URL'),
    title: z.string().optional().describe('Label shown in the list. Defaults to the host name (or the file name for kind file).'),
    kind: z
      .enum(['link', 'file'])
      .optional()
      .describe("'link' (default) for anything external; 'file' for a URL that POST /api/media returned."),
    mimeType: z.string().optional().describe("Files only — the type POST /api/media reported."),
    sizeBytes: z.number().int().nonnegative().optional().describe('Files only — the size POST /api/media reported.'),
  },
  handler: async (backend, args) => {
    if (!isHttpUrl(args.url)) {
      return `Error: url must be an absolute http:// or https:// address (got "${args.url}").`;
    }
    const kind = args.kind ?? 'link';
    const node = await backend.addAttachment(args.mapId, args.nodeId, {
      kind,
      url: args.url,
      title: args.title,
      mimeType: kind === 'file' ? args.mimeType ?? null : undefined,
      sizeBytes: kind === 'file' ? args.sizeBytes ?? null : undefined,
    });
    const added = newest(node, args.url);
    const label = added?.title ?? args.title ?? args.url;
    return (
      `Attached ${kind} "${label}" to node ${args.nodeId} ("${node.text}").` +
      (added ? `\nAttachment id: ${added.id}` : '') +
      countLine(node)
    );
  },
});

export const attachFileTool = defineTool({
  name: 'attach_file',
  description:
    `Upload a small file (up to ${INLINE_FILE_MAX_BYTES / (1024 * 1024)} MB) and hang it on a node in one step — a report, a screenshot, an export. Send the bytes as base64. The server stores it and answers the URL it is reachable at; the attachment shows in the node's property panel, in the map's Files tab, and in get_map / list_attachments. Images, video and PDF are served inline; everything else downloads under its original name. Anyone with the URL can read the file. For bigger files use multipart POST /api/media, then attach_link with kind 'file'. For a map-level file, use the root node id.`,
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('Node to hang the file on (the root node id for a map-level file)'),
    filename: z.string().min(1).describe('Original file name, extension included — decides how the file is served.'),
    contentType: z.string().optional().describe("MIME type, e.g. 'application/pdf'. Defaults to application/octet-stream."),
    contentBase64: z.string().min(1).describe('The file contents, base64-encoded.'),
  },
  handler: async (backend, args) => {
    const size = base64DecodedLength(args.contentBase64);
    if (size <= 0) return 'Error: contentBase64 decodes to nothing.';
    if (size > INLINE_FILE_MAX_BYTES) {
      return (
        `Error: the file decodes to ${(size / (1024 * 1024)).toFixed(1)} MB; inline uploads are capped at ` +
        `${INLINE_FILE_MAX_BYTES / (1024 * 1024)} MB. ${MULTIPART_HINT}`
      );
    }
    const node = await backend.attachFile(args.mapId, args.nodeId, {
      filename: args.filename,
      contentType: args.contentType,
      contentBase64: args.contentBase64,
    });
    // The server renames (safe stem, our extension), so find the new entry
    // by recency rather than by name.
    const added = [...(node.attachments ?? [])].sort((a, b) => b.addedAt.localeCompare(a.addedAt))[0];
    return (
      `Uploaded "${args.filename}" (${size} bytes) and attached it to node ${args.nodeId} ("${node.text}").` +
      (added ? `\nAttachment id: ${added.id}\nURL: ${added.url}` : '') +
      countLine(node)
    );
  },
});

export const removeAttachmentTool = defineTool({
  name: 'remove_attachment',
  description:
    'Take one attachment (file or link) off a node by its attachment id — the id get_map / list_attachments / read_attachment show. Removing a file attachment does not delete the stored file; the URL stays readable for anyone who has it.',
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node the attachment hangs on'),
    attachmentId: z.string().describe('The attachment id'),
  },
  handler: async (backend, args) => {
    const node = await backend.removeAttachment(args.mapId, args.nodeId, args.attachmentId);
    return `Removed attachment ${args.attachmentId} from node ${args.nodeId} ("${node.text}").` + countLine(node);
  },
});

/** Default page size — mirrors the server's `DEFAULT_PAGE_CHARS`. */
export const READ_DEFAULT_CHARS = 20_000;
/** Largest page the tool asks for — mirrors the server's `MAX_PAGE_CHARS`. */
export const READ_MAX_CHARS = 200_000;

function formatSize(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const readAttachmentTool = defineTool({
  name: 'read_attachment',
  description:
    "Read the contents of a file attached to a node, as text — a spec, a CSV, a log, source code, a PDF. Use the attachment id from get_map / list_attachments. Text-like files come back verbatim, PDFs as extracted text; images, video, archives and office documents have no text and are refused with the URL to open instead, as are links. Long files are paged: the result says how many characters remain and the offset to continue from. Only files stored in MindBlown are read; nothing external is fetched.",
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node the attachment hangs on'),
    attachmentId: z.string().describe('The attachment id'),
    offset: z.number().int().min(0).optional().describe('Character offset to start from (default 0). Use the value the previous page named to continue.'),
    maxChars: z
      .number()
      .int()
      .min(1)
      .max(READ_MAX_CHARS)
      .optional()
      .describe(`Characters per page (default ${READ_DEFAULT_CHARS}, max ${READ_MAX_CHARS})`),
  },
  handler: async (backend, args) => {
    const res = await backend.readAttachment(args.mapId, args.nodeId, args.attachmentId, {
      offset: args.offset,
      limit: args.maxChars,
    });
    if (!res.readable) {
      return `Cannot read attachment ${args.attachmentId}: ${res.message}\nURL: ${res.url}`;
    }
    const end = res.offset + res.text.length;
    const meta = [res.contentType, formatSize(res.sizeBytes), res.pages != null ? `${res.pages} page${res.pages === 1 ? '' : 's'}` : null]
      .filter(Boolean)
      .join(', ');
    const range = res.totalChars === 0 ? 'empty' : `chars ${res.offset}–${Math.max(end - 1, res.offset)} of ${res.totalChars}`;
    const header = `# ${res.filename} (${meta}) — ${range}`;
    const tail = res.truncated
      ? `\n\n[${res.totalChars - end} characters remain — call read_attachment again with offset ${end}]`
      : '';
    return `${header}\n\n${res.text}${tail}`;
  },
});

export const attachmentTools = [attachLinkTool, attachFileTool, removeAttachmentTool, readAttachmentTool];
