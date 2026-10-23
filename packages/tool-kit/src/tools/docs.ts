/**
 * Repo docs (#550) — the markdown files of the map's connected repo, as
 * the Docs tab shows them. An agent that plans against a repo can read
 * its README, ADRs and specs without a checkout. Read-only; the default
 * branch, as the forge has it right now.
 */

import { z } from 'zod';
import { defineTool } from '../spec.js';
import { formatBytes } from './attachments.js';

const DOC_DEFAULT_CHARS = 20_000;
const DOC_MAX_CHARS = 200_000;

export const listDocsTool = defineTool({
  name: 'list_docs',
  description:
    "List the markdown documents (*.md, *.markdown) on the default branch of the map's connected GitHub/Gitea repo — the same list the Docs tab shows. Read one with read_doc. Fails when the map has no repo connected.",
  schema: {
    mapId: z.string().describe('The map ID'),
  },
  handler: async (backend, args) => {
    const res = await backend.listRepoDocs(args.mapId);
    const head = `${res.docs.length} doc${res.docs.length === 1 ? '' : 's'} in ${res.repo.owner}/${res.repo.name} @ ${res.repo.branch}`;
    const lines = res.docs.map((d) => `- ${d.path} (${formatBytes(d.size)})`);
    const note = res.truncated ? '\n\nNOTE: the repo tree is too large for one listing — some docs are missing.' : '';
    return `${head}\n\n${lines.join('\n')}${note}`;
  },
});

export const readDocTool = defineTool({
  name: 'read_doc',
  description:
    "Read one markdown document of the map's connected repo (default branch), by its repo path from list_docs, e.g. 'docs/product-vision.md'. Long documents are paged: the result says the offset to continue from.",
  schema: {
    mapId: z.string().describe('The map ID'),
    path: z.string().describe('Repo-relative path, as list_docs prints it'),
    offset: z.number().int().min(0).optional().describe('Character offset to start from (default 0)'),
    maxChars: z
      .number()
      .int()
      .min(1)
      .max(DOC_MAX_CHARS)
      .optional()
      .describe(`Characters per page (default ${DOC_DEFAULT_CHARS}, max ${DOC_MAX_CHARS})`),
  },
  handler: async (backend, args) => {
    const doc = await backend.readRepoDoc(args.mapId, args.path);
    const total = doc.text.length;
    const offset = Math.min(args.offset ?? 0, total);
    const end = Math.min(offset + (args.maxChars ?? DOC_DEFAULT_CHARS), total);
    const range = total === 0 ? 'empty file' : offset === total ? `end of file (${total} chars in total)` : `chars ${offset}–${end - 1} of ${total}`;
    const header = `# ${doc.path} (${formatBytes(doc.size)}) — ${range}\n${doc.webUrl}`;
    const tail = end < total ? `\n\n[${total - end} characters remain — call read_doc again with offset ${end}]` : '';
    return `${header}\n\n${doc.text.slice(offset, end)}${tail}`;
  },
});

export const docsTools = [listDocsTool, readDocTool];
