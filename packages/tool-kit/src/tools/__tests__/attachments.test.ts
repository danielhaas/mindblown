/**
 * Attachment tools — what reaches the backend, and what is refused before
 * it gets there.
 *
 * The backend is a recorder: the rules that matter here are the tool's own
 * (URL scheme, the inline size cap, the wording that points at multipart),
 * not the server's, which have their own suites.
 */

import { describe, it, expect } from 'vitest';
import {
  attachLinkTool,
  attachFileTool,
  removeAttachmentTool,
  readAttachmentTool,
  base64DecodedLength,
  INLINE_FILE_MAX_BYTES,
} from '../attachments.js';
import type { ToolBackend } from '../../backend.js';
import type { NodeWithComputed } from '../../types.js';

type Calls = {
  add: Array<{ mapId: string; nodeId: string; input: Record<string, unknown> }>;
  file: Array<{ mapId: string; nodeId: string; file: Record<string, unknown> }>;
  remove: Array<{ mapId: string; nodeId: string; attachmentId: string }>;
};

function makeBackend(): { backend: ToolBackend; calls: Calls } {
  const calls: Calls = { add: [], file: [], remove: [] };
  const node = (attachments: NodeWithComputed['attachments']): NodeWithComputed =>
    ({ id: 'n1', text: 'Spec work', attachments }) as unknown as NodeWithComputed;
  const backend = {
    addAttachment: async (mapId: string, nodeId: string, input: Record<string, unknown>) => {
      calls.add.push({ mapId, nodeId, input });
      return node([
        { id: 'att-old', kind: 'link', url: 'https://old', title: 'old', addedAt: '2026-01-01T00:00:00Z' },
        { id: 'att-new', kind: input.kind as 'link', url: input.url as string, title: (input.title as string) ?? 'example.com', addedAt: '2026-09-25T10:00:00Z' },
      ]);
    },
    attachFile: async (mapId: string, nodeId: string, file: Record<string, unknown>) => {
      calls.file.push({ mapId, nodeId, file });
      return node([
        { id: 'att-f', kind: 'file', url: 'https://mind.example/api/media/abc/report.pdf', title: 'report.pdf', addedAt: '2026-09-25T10:00:00Z' },
      ]);
    },
    removeAttachment: async (mapId: string, nodeId: string, attachmentId: string) => {
      calls.remove.push({ mapId, nodeId, attachmentId });
      return node([]);
    },
  } as unknown as ToolBackend;
  return { backend, calls };
}

describe('attach_link', () => {
  it('forwards a link and names the new attachment id', async () => {
    const { backend, calls } = makeBackend();
    const out = await attachLinkTool.handler(backend, {
      mapId: 'm',
      nodeId: 'n1',
      url: 'https://example.com/spec.pdf',
      title: 'The spec',
    });
    expect(calls.add).toEqual([
      { mapId: 'm', nodeId: 'n1', input: { kind: 'link', url: 'https://example.com/spec.pdf', title: 'The spec', mimeType: undefined, sizeBytes: undefined } },
    ]);
    expect(out).toContain('Attached link "The spec"');
    expect(out).toContain('Attachment id: att-new');
    expect(out).toContain('now has 2 attachments');
  });

  it("carries the multipart route's metadata when kind is file", async () => {
    const { backend, calls } = makeBackend();
    await attachLinkTool.handler(backend, {
      mapId: 'm',
      nodeId: 'n1',
      url: 'https://mind.example/api/media/abc/x.xlsx.bin',
      kind: 'file',
      mimeType: 'application/vnd.ms-excel',
      sizeBytes: 4096,
    });
    expect(calls.add[0].input).toMatchObject({ kind: 'file', mimeType: 'application/vnd.ms-excel', sizeBytes: 4096 });
  });

  it('refuses a URL without a scheme before it reaches the backend', async () => {
    const { backend, calls } = makeBackend();
    const out = await attachLinkTool.handler(backend, { mapId: 'm', nodeId: 'n1', url: 'example.com/spec' });
    expect(out).toMatch(/^Error: url must be an absolute http/);
    expect(calls.add).toEqual([]);
  });

  it('refuses javascript: and other non-http schemes', async () => {
    const { backend, calls } = makeBackend();
    const out = await attachLinkTool.handler(backend, { mapId: 'm', nodeId: 'n1', url: 'javascript:alert(1)' });
    expect(out).toMatch(/^Error/);
    expect(calls.add).toEqual([]);
  });
});

describe('attach_file', () => {
  it('forwards the file and reports the URL the server minted', async () => {
    const { backend, calls } = makeBackend();
    const b64 = Buffer.from('%PDF-1.4').toString('base64');
    const out = await attachFileTool.handler(backend, {
      mapId: 'm',
      nodeId: 'n1',
      filename: 'report.pdf',
      contentType: 'application/pdf',
      contentBase64: b64,
    });
    expect(calls.file).toEqual([
      { mapId: 'm', nodeId: 'n1', file: { filename: 'report.pdf', contentType: 'application/pdf', contentBase64: b64 } },
    ]);
    expect(out).toContain('Uploaded "report.pdf" (8 bytes)');
    expect(out).toContain('URL: https://mind.example/api/media/abc/report.pdf');
    expect(out).toContain('Attachment id: att-f');
  });

  it('refuses an oversized file without sending it, and says what to do instead', async () => {
    const { backend, calls } = makeBackend();
    // One byte over the cap, as base64 — built from length, not allocated.
    const over = 'A'.repeat(Math.ceil(((INLINE_FILE_MAX_BYTES + 1) * 4) / 3));
    const out = await attachFileTool.handler(backend, {
      mapId: 'm',
      nodeId: 'n1',
      filename: 'big.zip',
      contentBase64: over,
    });
    expect(out).toMatch(/^Error: .*capped at 8 MB/);
    expect(out).toContain('/api/media');
    expect(out).toContain('attach_link');
    expect(calls.file).toEqual([]);
  });

  it('refuses content that decodes to nothing', async () => {
    const { backend, calls } = makeBackend();
    const out = await attachFileTool.handler(backend, { mapId: 'm', nodeId: 'n1', filename: 'x', contentBase64: '=' });
    expect(out).toMatch(/^Error/);
    expect(calls.file).toEqual([]);
  });
});

describe('remove_attachment', () => {
  it('forwards the ids and reports the remaining count', async () => {
    const { backend, calls } = makeBackend();
    const out = await removeAttachmentTool.handler(backend, { mapId: 'm', nodeId: 'n1', attachmentId: 'att-1' });
    expect(calls.remove).toEqual([{ mapId: 'm', nodeId: 'n1', attachmentId: 'att-1' }]);
    expect(out).toContain('Removed attachment att-1');
    expect(out).toContain('now has 0 attachments');
  });
});

describe('read_attachment', () => {
  type ReadCall = { mapId: string; nodeId: string; attachmentId: string; opts: Record<string, unknown> | undefined };
  function readBackend(answer: Awaited<ReturnType<ToolBackend['readAttachment']>>): { backend: ToolBackend; calls: ReadCall[] } {
    const calls: ReadCall[] = [];
    const backend = {
      readAttachment: async (mapId: string, nodeId: string, attachmentId: string, opts?: Record<string, unknown>) => {
        calls.push({ mapId, nodeId, attachmentId, opts });
        return answer;
      },
    } as unknown as ToolBackend;
    return { backend, calls };
  }

  it('forwards ids and paging and renders header, text and the continue hint', async () => {
    const { backend, calls } = readBackend({
      readable: true,
      attachmentId: 'att-1',
      filename: 'spec.pdf',
      contentType: 'application/pdf',
      sizeBytes: 3 * 1024 * 1024,
      totalChars: 50,
      offset: 10,
      text: 'x'.repeat(20),
      truncated: true,
      pages: 3,
    });
    const out = await readAttachmentTool.handler(backend, { mapId: 'm', nodeId: 'n1', attachmentId: 'att-1', offset: 10, maxChars: 20 });
    expect(calls).toEqual([{ mapId: 'm', nodeId: 'n1', attachmentId: 'att-1', opts: { offset: 10, limit: 20 } }]);
    expect(out).toContain('# spec.pdf (application/pdf, 3.0 MB, 3 pages) — chars 10–29 of 50');
    expect(out).toContain('\n\n' + 'x'.repeat(20));
    expect(out).toContain('[20 characters remain — call read_attachment again with offset 30]');
  });

  it('renders a complete text file without a continue hint', async () => {
    const { backend, calls } = readBackend({
      readable: true,
      attachmentId: 'att-2',
      filename: 'notes.md',
      contentType: 'text/markdown',
      sizeBytes: 12,
      totalChars: 12,
      offset: 0,
      text: '# Notes\nhi!\n',
      truncated: false,
      pages: null,
    });
    const out = await readAttachmentTool.handler(backend, { mapId: 'm', nodeId: 'n1', attachmentId: 'att-2' });
    expect(calls[0].opts).toEqual({ offset: undefined, limit: undefined });
    expect(out).toContain('# notes.md (text/markdown, 12 bytes) — chars 0–11 of 12');
    expect(out).not.toContain('remain');
  });

  it('says end of file for an empty page instead of a range that does not exist', async () => {
    const { backend } = readBackend({
      readable: true,
      attachmentId: 'att-4',
      filename: 'notes.md',
      contentType: 'text/markdown',
      sizeBytes: 50,
      totalChars: 50,
      offset: 50,
      text: '',
      truncated: false,
      pages: null,
    });
    const out = await readAttachmentTool.handler(backend, { mapId: 'm', nodeId: 'n1', attachmentId: 'att-4', offset: 50 });
    expect(out).toContain('— end of file (50 chars in total)');
    expect(out).not.toContain('chars 50–');
  });

  it('passes the reason and the URL on when the file has no text', async () => {
    const { backend } = readBackend({
      readable: false,
      attachmentId: 'att-3',
      reason: 'binary',
      message: '"shot.png" (image/png) has no text to extract.',
      url: 'https://mind.example/api/media/abc/shot.png',
    });
    const out = await readAttachmentTool.handler(backend, { mapId: 'm', nodeId: 'n1', attachmentId: 'att-3' });
    expect(out).toBe('Cannot read attachment att-3: "shot.png" (image/png) has no text to extract.\nURL: https://mind.example/api/media/abc/shot.png');
  });
});

describe('base64DecodedLength', () => {
  it('matches Buffer for padded and unpadded input', () => {
    for (const s of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', '%PDF-1.4 hello world']) {
      const b64 = Buffer.from(s).toString('base64');
      expect(base64DecodedLength(b64)).toBe(Buffer.from(b64, 'base64').length);
    }
  });

  it('ignores whitespace, as the decoder does', () => {
    const b64 = Buffer.from('hello world').toString('base64');
    const wrapped = b64.slice(0, 4) + '\n' + b64.slice(4);
    expect(base64DecodedLength(wrapped)).toBe(11);
  });
});
