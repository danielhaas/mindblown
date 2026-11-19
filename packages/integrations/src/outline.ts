/**
 * Outline wiki client (#637) — the two calls "publish to wiki" needs:
 * create a document in a collection, and replace an existing one's content.
 * Outline's API is RPC-style: POST <base>/api/<method> with a JSON body and
 * a Bearer API token; answers `{ data: … }`.
 */

export class OutlineApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OutlineApiError';
  }
}

export interface OutlineDocument {
  id: string;
  /** Absolute URL of the document in the wiki. */
  url: string;
}

export interface OutlineClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

/** "https://wiki.example.com/" → "https://wiki.example.com". */
export function outlineBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/api$/, '');
}

export function createOutlineClient(opts: OutlineClientOptions) {
  const base = outlineBase(opts.baseUrl);
  const doFetch = opts.fetch ?? fetch;

  async function call(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await doFetch(`${base}/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // Non-JSON (a proxy's error page) — the status speaks for it.
    }
    if (!res.ok) {
      const msg = typeof json.message === 'string' ? json.message : typeof json.error === 'string' ? json.error : res.statusText;
      throw new OutlineApiError(res.status, `Outline ${method} failed: HTTP ${res.status}${msg ? ` — ${msg}` : ''}`);
    }
    return (json.data ?? {}) as Record<string, unknown>;
  }

  const toDocument = (data: Record<string, unknown>): OutlineDocument => {
    const id = String(data.id ?? '');
    if (!id) throw new OutlineApiError(502, 'Outline answered without a document id');
    const raw = typeof data.url === 'string' ? data.url : '';
    return { id, url: raw.startsWith('http') ? raw : `${base}${raw || `/doc/${id}`}` };
  };

  return {
    async createDocument(input: { title: string; text: string; collectionId: string }): Promise<OutlineDocument> {
      return toDocument(await call('documents.create', { ...input, publish: true }));
    },
    async updateDocument(input: { id: string; title: string; text: string }): Promise<OutlineDocument> {
      return toDocument(await call('documents.update', { ...input, publish: true }));
    },
  };
}

export type OutlineClient = ReturnType<typeof createOutlineClient>;
