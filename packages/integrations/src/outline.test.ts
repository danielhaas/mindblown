import { describe, it, expect, vi } from 'vitest';
import { createOutlineClient, OutlineApiError, outlineBase } from './outline.js';

function reply(status: number, body: unknown) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

describe('Outline client', () => {
  it('creates a published document in the collection, with the token', async () => {
    const fetchMock = vi.fn(async () => reply(200, { data: { id: 'doc-1', url: '/doc/timeline-abc' } }));
    const client = createOutlineClient({ baseUrl: 'https://wiki.example.com/', token: 'ol_api_x', fetch: fetchMock as unknown as typeof fetch });
    const doc = await client.createDocument({ title: 'T', text: 'body', collectionId: 'col-1' });
    expect(doc).toEqual({ id: 'doc-1', url: 'https://wiki.example.com/doc/timeline-abc' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://wiki.example.com/api/documents.create');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ol_api_x');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'T', text: 'body', collectionId: 'col-1', publish: true });
  });

  it('updates a document by id', async () => {
    const fetchMock = vi.fn(async () => reply(200, { data: { id: 'doc-1', url: 'https://wiki.example.com/doc/x' } }));
    const client = createOutlineClient({ baseUrl: 'https://wiki.example.com', token: 't', fetch: fetchMock as unknown as typeof fetch });
    await client.updateDocument({ id: 'doc-1', title: 'T', text: 'new' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://wiki.example.com/api/documents.update');
    expect(JSON.parse(init.body as string)).toEqual({ id: 'doc-1', title: 'T', text: 'new', publish: true });
  });

  it('throws OutlineApiError with the status and Outline message', async () => {
    const fetchMock = vi.fn(async () => reply(404, { ok: false, error: 'not_found', message: 'Document not found' }));
    const client = createOutlineClient({ baseUrl: 'https://wiki.example.com', token: 't', fetch: fetchMock as unknown as typeof fetch });
    const err = await client.updateDocument({ id: 'gone', title: 'T', text: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(OutlineApiError);
    expect(err.status).toBe(404);
    expect(err.message).toContain('Document not found');
  });

  it('normalises the base URL', () => {
    expect(outlineBase(' https://wiki.example.com/api/ ')).toBe('https://wiki.example.com');
  });
});
