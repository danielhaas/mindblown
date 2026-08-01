/**
 * The two pieces of attachment behaviour that are logic rather than markup:
 * how a size is written for a person, and what the client actually sends.
 *
 * The component itself isn't rendered — this package has no jsdom, and the
 * parts worth pinning don't need one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatSize } from '../AttachmentsSection.js';
import { isHttpUrl } from '../verification.js';

describe('formatSize', () => {
  it('writes bytes the way a person reads them', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(1024 * 1024 * 3.5)).toBe('3.5 MB');
    expect(formatSize(1024 * 1024 * 1024 * 2)).toBe('2.0 GB');
  });

  it('drops the decimal once the number is big enough not to need it', () => {
    // 1.5 KB reads better than 2 KB; 640 KB reads better than 640.2 KB.
    expect(formatSize(1024 * 640)).toBe('640 KB');
    expect(formatSize(1024 * 9.5)).toBe('9.5 KB');
  });

  it('renders nothing rather than a wrong number when the size is unknown', () => {
    // Links carry no size, and files uploaded before the field existed
    // carry null. "0 B" next to a real document would be a lie.
    expect(formatSize(null)).toBeNull();
    expect(formatSize(undefined)).toBeNull();
    expect(formatSize(-1)).toBeNull();
  });

  it('stays under a GB boundary without rolling over to a bogus unit', () => {
    expect(formatSize(1024 * 1024 * 1024 * 1024)).toBe('1024 GB');
  });
});

describe('link validation before sending', () => {
  it('accepts what a person actually pastes', () => {
    expect(isHttpUrl('https://example.com/spec.pdf')).toBe(true);
    expect(isHttpUrl('http://intranet.local/doc')).toBe(true);
  });

  it('refuses the schemes that turn a rendered link into an exploit', () => {
    // The list renders every attachment as an `<a href>`, so this is the
    // guard that stops a stored `javascript:` from being one click away.
    // Checked client-side only to answer instantly — the server repeats it.
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
      'java\nscript:alert(1)',
    ]) {
      expect(isHttpUrl(bad)).toBe(false);
    }
  });

  it('refuses the common typo — a bare host with no scheme', () => {
    expect(isHttpUrl('example.com/spec')).toBe(false);
    expect(isHttpUrl('www.example.com')).toBe(false);
  });
});

// ── What the client sends ────────────────────────────────────────

describe('addAttachment / removeAttachment', () => {
  const store = new Map<string, string>();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'n1', attachments: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('POSTs to the node sub-resource rather than replacing the whole node', async () => {
    const api = await import('../api.js');
    await api.addAttachment('m1', 'n1', { kind: 'link', url: 'https://example.com' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/maps/m1/nodes/n1/attachments');
    expect(init.method).toBe('POST');
    // Decisive: no `attachments` array in the body. Sending one would mean
    // the client had to know the current list, which is the race this
    // endpoint exists to avoid.
    expect(JSON.parse(init.body)).toEqual({ kind: 'link', url: 'https://example.com' });
  });

  it('DELETEs one attachment by id', async () => {
    const api = await import('../api.js');
    await api.removeAttachment('m1', 'n1', 'att-7');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/maps/m1/nodes/n1/attachments/att-7');
    expect(init.method).toBe('DELETE');
  });
});
