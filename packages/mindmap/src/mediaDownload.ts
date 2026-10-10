/**
 * Documents uploaded to MindBlown need a signed-in caller since #292
 * (decision D): only video and images are capability URLs. The app keeps
 * its token in localStorage, not a cookie, so a plain link to such a file
 * would 401 — instead the app fetches it with the session and hands the
 * browser a blob to save.
 */
import { isPublicMediaFileName } from '@mindblown/core';
import { getToken } from './api.js';

const MEDIA_PATH = /^\/api\/media\/[0-9a-f]{40}\/([^/?#]+)/;

/** A MindBlown upload that is not video or an image — download it with the session. */
export function needsSessionDownload(url: string): boolean {
  let path: string;
  try {
    const u = new URL(url, window.location.origin);
    if (u.origin !== window.location.origin) return false;
    path = u.pathname;
  } catch {
    return false;
  }
  const m = MEDIA_PATH.exec(path);
  return m != null && !isPublicMediaFileName(m[1]);
}

/** Fetch with the session token and save under the server's filename. */
export async function downloadWithSession(url: string): Promise<void> {
  const token = getToken();
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (res.status === 404) throw new Error('This file is no longer attached anywhere you can see.');
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const fromHeader = /filename="([^"]+)"/.exec(disposition)?.[1];
  const fromPath = decodeURIComponent(new URL(url, window.location.origin).pathname.split('/').pop() ?? 'download').replace(/\.bin$/, '');
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = fromHeader ?? fromPath;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/** onClick for an attachment link: session download for documents, normal navigation otherwise. */
export function attachmentClick(url: string) {
  return (e: { preventDefault: () => void }) => {
    if (!needsSessionDownload(url)) return;
    e.preventDefault();
    downloadWithSession(url).catch((err: unknown) => alert(err instanceof Error ? err.message : String(err)));
  };
}
