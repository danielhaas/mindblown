/**
 * Reading an attachment's contents — the rules that decide what comes back
 * as text, what is refused and why, and how a long text is paged.
 *
 * Real temp directory under the media layout (`<root>/<id>/<name>`), no DB:
 * the function takes the attachment row it needs. The PDF is built by hand
 * — the smallest valid document with one text object — so the extractor is
 * exercised for real without a binary fixture in the repo.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PAGE_CHARS,
  EXTRACT_MAX_BYTES,
  MAX_PAGE_CHARS,
  looksLikeText,
  pageOf,
  readAttachmentText,
  storedMediaLocation,
} from '../attachmentText.js';

const ID = 'a'.repeat(40);
const BASE = 'https://mind.example';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mb-att-text-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function store(id: string, storedName: string, bytes: Buffer | string): Promise<string> {
  await mkdir(path.join(root, id), { recursive: true });
  await writeFile(path.join(root, id, storedName), bytes);
  return `${BASE}/api/media/${id}/${encodeURIComponent(storedName)}`;
}

function fileAttachment(url: string, mimeType: string | null = null) {
  return { kind: 'file' as const, url, title: 'x', mimeType };
}

/** One page, one Helvetica line, uncompressed content stream, correct xref. */
function minimalPdf(line: string): Buffer {
  const content = `BT /F1 18 Tf 40 700 Td (${line}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf +=
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

describe('storedMediaLocation', () => {
  it('resolves a minted URL to <root>/<id>/<name>', () => {
    const loc = storedMediaLocation(`${BASE}/api/media/${ID}/spec.md.bin`, root);
    expect(loc).toEqual({ id: ID, storedName: 'spec.md.bin', file: path.join(root, ID, 'spec.md.bin') });
  });

  it('decodes the filename and ignores the host', () => {
    const loc = storedMediaLocation(`http://other.host:3001/api/media/${ID}/my%20spec.txt.bin`, root);
    expect(loc?.file).toBe(path.join(root, ID, 'my spec.txt.bin'));
  });

  it('refuses anything not shaped like a minted URL', () => {
    expect(storedMediaLocation('https://example.com/spec.pdf', root)).toBeNull();
    expect(storedMediaLocation(`${BASE}/api/media/not-an-id/spec.pdf`, root)).toBeNull();
    expect(storedMediaLocation(`${BASE}/api/media/${ID}`, root)).toBeNull();
    expect(storedMediaLocation(`${BASE}/api/media/${ID}/a/b.pdf`, root)).toBeNull();
    expect(storedMediaLocation('not a url', root)).toBeNull();
  });

  it('cannot walk out of the id directory', () => {
    const loc = storedMediaLocation(`${BASE}/api/media/${ID}/..%2F..%2Fetc%2Fpasswd`, root);
    expect(loc?.file).toBe(path.join(root, ID, 'passwd'));
  });
});

describe('readAttachmentText — refusals', () => {
  it('a link is not read', async () => {
    const r = await readAttachmentText({ kind: 'link', url: 'https://example.com/spec', title: 'spec', mimeType: null }, {}, root);
    expect(r).toMatchObject({ readable: false, reason: 'link' });
  });

  it('a file stored elsewhere is not fetched', async () => {
    const r = await readAttachmentText(fileAttachment('https://files.example.com/spec.txt'), {}, root);
    expect(r).toMatchObject({ readable: false, reason: 'external' });
  });

  it('a minted URL with nothing on disk is missing', async () => {
    const r = await readAttachmentText(fileAttachment(`${BASE}/api/media/${ID}/spec.txt.bin`), {}, root);
    expect(r).toMatchObject({ readable: false, reason: 'missing' });
  });

  it('an image is binary, with the message naming what is readable', async () => {
    const url = await store(ID, 'shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    const r = await readAttachmentText(fileAttachment(url, 'image/png'), {}, root);
    expect(r).toMatchObject({ readable: false, reason: 'binary' });
    expect((r as { message: string }).message).toContain('shot.png');
    expect((r as { message: string }).message).toContain('PDF');
  });

  it('an unknown binary type is binary even without a mime type', async () => {
    const url = await store(ID, 'archive.zip.bin', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0x08, 0]));
    const r = await readAttachmentText(fileAttachment(url), {}, root);
    expect(r).toMatchObject({ readable: false, reason: 'binary' });
  });

  it('a damaged PDF is unreadable, not a crash', async () => {
    const url = await store(ID, 'broken.pdf', Buffer.from('%PDF-1.4\nthis is not a pdf'));
    const r = await readAttachmentText(fileAttachment(url, 'application/pdf'), {}, root);
    expect(r).toMatchObject({ readable: false, reason: 'unreadable' });
  });
});

describe('readAttachmentText — text', () => {
  it('reads a .bin-stored text file under its real name, CRLF normalised, BOM dropped', async () => {
    const url = await store(ID, 'notes.md.bin', '﻿# Notes\r\nline two\r\n');
    const r = await readAttachmentText(fileAttachment(url, 'text/markdown'), {}, root);
    expect(r).toEqual({
      readable: true,
      filename: 'notes.md',
      contentType: 'text/markdown',
      sizeBytes: 22,
      pages: null,
      totalChars: 17,
      offset: 0,
      text: '# Notes\nline two\n',
      truncated: false,
    });
  });

  it('reads by extension when the mime type is generic', async () => {
    const url = await store(ID, 'data.csv.bin', 'a,b\n1,2\n');
    const r = await readAttachmentText(fileAttachment(url, 'application/octet-stream'), {}, root);
    expect(r).toMatchObject({ readable: true, text: 'a,b\n1,2\n' });
  });

  it('sniffs an unknown extension that holds UTF-8', async () => {
    const url = await store(ID, 'report.qqq.bin', 'Grüezi — plain text after all');
    const r = await readAttachmentText(fileAttachment(url), {}, root);
    expect(r).toMatchObject({ readable: true, text: 'Grüezi — plain text after all' });
  });

  it('pages a long text by offset and reports what remains', async () => {
    const body = 'x'.repeat(50);
    const url = await store(ID, 'long.txt.bin', body);
    const first = await readAttachmentText(fileAttachment(url, 'text/plain'), { limit: 20 }, root);
    expect(first).toMatchObject({ readable: true, totalChars: 50, offset: 0, truncated: true });
    expect((first as { text: string }).text).toHaveLength(20);

    const last = await readAttachmentText(fileAttachment(url, 'text/plain'), { offset: 40, limit: 20 }, root);
    expect(last).toMatchObject({ readable: true, offset: 40, truncated: false });
    expect((last as { text: string }).text).toHaveLength(10);

    const past = await readAttachmentText(fileAttachment(url, 'text/plain'), { offset: 500 }, root);
    expect(past).toMatchObject({ readable: true, offset: 50, text: '', truncated: false });
  });
});

describe('readAttachmentText — PDF', () => {
  it('extracts the text and reports the page count', async () => {
    const url = await store(ID, 'spec.pdf', minimalPdf('Hello attachment world'));
    const r = await readAttachmentText(fileAttachment(url, 'application/pdf'), {}, root);
    expect(r).toMatchObject({
      readable: true,
      filename: 'spec.pdf',
      contentType: 'application/pdf',
      pages: 1,
      text: 'Hello attachment world',
      truncated: false,
    });
  });
});

describe('pageOf', () => {
  it('defaults and caps the page size', () => {
    const text = 'y'.repeat(MAX_PAGE_CHARS + 10);
    expect(pageOf(text, {}).text).toHaveLength(DEFAULT_PAGE_CHARS);
    expect(pageOf(text, { limit: 10 * MAX_PAGE_CHARS }).text).toHaveLength(MAX_PAGE_CHARS);
    expect(pageOf(text, { limit: 0 }).text).toHaveLength(1);
    expect(pageOf(text, { offset: -5, limit: 3 })).toMatchObject({ offset: 0, text: 'yyy' });
  });
});

describe('looksLikeText', () => {
  it('accepts UTF-8 and rejects NULs and invalid sequences', () => {
    expect(looksLikeText(Buffer.from('hello wörld'))).toBe(true);
    expect(looksLikeText(Buffer.from([0x68, 0x00, 0x69]))).toBe(false);
    expect(looksLikeText(Buffer.from([0xff, 0xfe, 0x41]))).toBe(false);
  });

  it('is not fooled by a multi-byte character cut at the sniff boundary', () => {
    const head = Buffer.alloc(64 * 1024 - 1, 0x61);
    const tail = Buffer.from('ü'); // two bytes, straddles the 64 KB boundary
    expect(looksLikeText(Buffer.concat([head, tail, Buffer.from('more')]))).toBe(true);
  });
});

describe('size ceiling', () => {
  it('is 32 MB', () => {
    expect(EXTRACT_MAX_BYTES).toBe(32 * 1024 * 1024);
  });
});
