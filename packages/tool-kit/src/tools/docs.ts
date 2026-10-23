/**
 * Repo docs (#550) — the markdown files of the map's connected repo, as
 * the Docs tab shows them. An agent that plans against a repo can read
 * its README, ADRs and specs without a checkout, on the default branch as
 * the forge has it right now. Edits (#552) go through a pull request.
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
    const header = `# ${doc.path} (${formatBytes(doc.size)}) — ${range}\nsha ${doc.sha} · ${doc.webUrl}`;
    const tail =
      end < total
        ? `\n\n[${total - end} characters remain — call read_doc again with offset ${end}. To edit, propose_doc_edit needs the complete text, not this page.]`
        : '';
    return `${header}\n\n${doc.text.slice(offset, end)}${tail}`;
  },
});

export const proposeDocEditTool = defineTool({
  name: 'propose_doc_edit',
  description:
    "Propose a change to one markdown document of the map's connected repo (#552). Opens a pull request: MindBlown creates a fresh branch off the default branch, commits the new text and opens a PR back — the default branch itself is never written. Pass the WHOLE new file text and the `sha` read_doc printed for the version you edited; if the doc changed since, nothing is created and you get a conflict — read it again and redo the edit. Needs edit permission on the map.",
  schema: {
    mapId: z.string().describe('The map ID'),
    path: z.string().describe('Repo-relative path of an existing doc, as list_docs prints it'),
    text: z.string().describe('The complete new file content (not a diff)'),
    baseSha: z.string().describe('The sha read_doc printed for the version you edited'),
    message: z.string().optional().describe('Commit message; its first line is the PR title (default "docs: update <path>")'),
    allowLargeDeletion: z
      .boolean()
      .optional()
      .describe('Set true only when you deliberately remove more than half of the document'),
  },
  handler: async (backend, args) => {
    // read_doc pages long docs; one page passed back as `text` would delete
    // the rest of the file in the PR. Refuse a drastic shrink unless meant.
    if (!args.allowLargeDeletion) {
      const current = await backend.readRepoDoc(args.mapId, args.path);
      if (args.text.length < current.text.length / 2) {
        return (
          `Refused: the new text (${args.text.length} chars) is less than half of ${args.path} (${current.text.length} chars). ` +
          'propose_doc_edit replaces the WHOLE file — if you read it in pages, read every page and send the complete text. ' +
          'If you really mean to delete most of it, call again with allowLargeDeletion: true.'
        );
      }
    }
    const res = await backend.proposeRepoDocEdit(args.mapId, { path: args.path, text: args.text, baseSha: args.baseSha, message: args.message });
    return `Opened PR #${res.pullRequest.number} for ${res.path}: ${res.pullRequest.url}\nbranch ${res.branch} · commit ${res.commitSha.slice(0, 7)}`;
  },
});

export const docsTools = [listDocsTool, readDocTool, proposeDocEditTool];
