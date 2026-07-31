/**
 * `uploadMedia` — the client half of the file-upload path.
 *
 * There is no jsdom in this package (every other frontend test here is
 * pure logic), so XMLHttpRequest is stubbed. That's not a compromise for
 * this particular unit: what can actually break is the request it
 * assembles, and the stub is where that becomes observable.
 *
 * The two cases that pin down real bugs:
 *   - **No `Content-Type` header.** Setting it by hand drops the multipart
 *     boundary the browser generates, and the server then can't parse a
 *     body it just received in full — a failure that looks like a server
 *     bug from every angle except this one.
 *   - **Server error messages survive.** The upload's most likely failures
 *     (too large, wrong type) are ones the server explains in German; if
 *     the rejection collapses to "HTTP 413" the user is told nothing
 *     actionable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { uploadMedia, setToken, clearToken, ApiError } from '../api.js';

// ── XHR stub ──────────────────────────────────────────────────────

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

let sent: Sent;
let instance: FakeXhr;

class FakeUpload {
  handlers: Record<string, ((e: unknown) => void)[]> = {};
  addEventListener(type: string, fn: (e: unknown) => void): void {
    (this.handlers[type] ??= []).push(fn);
  }
  emit(type: string, e: unknown): void {
    for (const fn of this.handlers[type] ?? []) fn(e);
  }
}

class FakeXhr {
  upload = new FakeUpload();
  status = 0;
  responseText = '';
  private handlers: Record<string, (() => void)[]> = {};

  open(method: string, url: string): void {
    sent = { method, url, headers: {}, body: undefined };
  }
  setRequestHeader(name: string, value: string): void {
    sent.headers[name] = value;
  }
  addEventListener(type: string, fn: () => void): void {
    (this.handlers[type] ??= []).push(fn);
  }
  send(body: unknown): void {
    sent.body = body;
  }

  /** Drive the response the test wants. */
  respond(status: number, responseText: string): void {
    this.status = status;
    this.responseText = responseText;
    for (const fn of this.handlers['load'] ?? []) fn();
  }
  fail(type: 'error' | 'abort'): void {
    for (const fn of this.handlers[type] ?? []) fn();
  }
}

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal(
    'XMLHttpRequest',
    class {
      constructor() {
        instance = new FakeXhr();
        return instance as unknown as XMLHttpRequest;
      }
    },
  );
  // FormData exists in Node 18+; File does not in every runtime, so the
  // call site only needs something FormData will accept.
  vi.stubGlobal('File', class {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A stand-in for a File — FormData.append only needs a Blob or a string. */
function fakeFile(): File {
  return new Blob(['xxx'], { type: 'video/mp4' }) as unknown as File;
}

const OK_BODY = JSON.stringify({
  id: 'a'.repeat(40),
  url: 'https://mind.project.li/api/media/' + 'a'.repeat(40) + '/clip.mp4',
  filename: 'clip.mp4',
  contentType: 'video/mp4',
  size: 3,
});

// ── Cases ─────────────────────────────────────────────────────────

describe('uploadMedia', () => {
  it('POSTs multipart to /api/media and resolves with the minted URL', async () => {
    const promise = uploadMedia(fakeFile());
    instance.respond(201, OK_BODY);

    const media = await promise;
    expect(sent.method).toBe('POST');
    expect(sent.url).toMatch(/\/api\/media$/);
    expect(sent.body).toBeInstanceOf(FormData);
    expect(media.url).toContain('/api/media/');
    expect(media.filename).toBe('clip.mp4');
  });

  it('never sets Content-Type — the browser owns the multipart boundary', async () => {
    const promise = uploadMedia(fakeFile());
    instance.respond(201, OK_BODY);
    await promise;

    const names = Object.keys(sent.headers).map((h) => h.toLowerCase());
    expect(names).not.toContain('content-type');
  });

  it('sends the session token so the server can attribute the upload', async () => {
    setToken('jwt-abc');
    const promise = uploadMedia(fakeFile());
    instance.respond(201, OK_BODY);
    await promise;

    expect(sent.headers['Authorization']).toBe('Bearer jwt-abc');
  });

  it('omits the header entirely when logged out rather than sending "Bearer null"', async () => {
    clearToken();
    const promise = uploadMedia(fakeFile());
    instance.respond(201, OK_BODY);
    await promise;

    expect(sent.headers['Authorization']).toBeUndefined();
  });

  it('reports progress as a fraction', async () => {
    const seen: number[] = [];
    const promise = uploadMedia(fakeFile(), (f) => seen.push(f));

    instance.upload.emit('progress', { lengthComputable: true, loaded: 25, total: 100 });
    instance.upload.emit('progress', { lengthComputable: true, loaded: 100, total: 100 });
    instance.respond(201, OK_BODY);
    await promise;

    expect(seen).toEqual([0.25, 1]);
  });

  it('ignores progress events that carry no total instead of emitting NaN', async () => {
    const seen: number[] = [];
    const promise = uploadMedia(fakeFile(), (f) => seen.push(f));

    instance.upload.emit('progress', { lengthComputable: false, loaded: 5, total: 0 });
    instance.upload.emit('progress', { lengthComputable: true, loaded: 5, total: 0 });
    instance.respond(201, OK_BODY);
    await promise;

    expect(seen).toEqual([]);
  });

  it("surfaces the server's own explanation for a rejected upload", async () => {
    const promise = uploadMedia(fakeFile());
    instance.respond(
      413,
      JSON.stringify({
        error: { code: 'FILE_TOO_LARGE', message: 'Datei überschreitet das Limit von 100 MB' },
      }),
    );

    await expect(promise).rejects.toThrow('Datei überschreitet das Limit von 100 MB');
    await promise.catch((err) => {
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(413);
      expect(err.code).toBe('FILE_TOO_LARGE');
    });
  });

  it('still fails usefully when the error body is not JSON', async () => {
    const promise = uploadMedia(fakeFile());
    instance.respond(502, '<html>Bad Gateway</html>');

    await expect(promise).rejects.toThrow(/502/);
  });

  it('rejects on a network error', async () => {
    const promise = uploadMedia(fakeFile());
    instance.fail('error');
    await expect(promise).rejects.toThrow(/Netzwerkfehler/);
  });

  it('rejects on abort', async () => {
    const promise = uploadMedia(fakeFile());
    instance.fail('abort');
    await expect(promise).rejects.toThrow(/abgebrochen/);
  });
});
