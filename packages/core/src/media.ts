/**
 * Uploaded files (#292, decision D, Dan 10.10.2026): video and images stay
 * capability URLs — a `<video>` / `<img>` cannot send a credential, and a
 * screen recording or screenshot is what that trade was made for. Every
 * other file (specs, exports, spreadsheets, PDFs) is served only to a
 * signed-in caller who can see the map it hangs on. One list, read by the
 * server's auth exemption and by the web app's download path.
 */
export const PUBLIC_MEDIA_EXTENSIONS: ReadonlySet<string> = new Set(['mp4', 'webm', 'mov', 'png', 'jpg', 'jpeg', 'gif', 'webp']);

/** Is a stored file name (last path segment) one of the public media types? */
export function isPublicMediaFileName(name: string): boolean {
  const clean = name.split(/[?#]/)[0];
  const ext = clean.includes('.') ? clean.slice(clean.lastIndexOf('.') + 1).toLowerCase() : '';
  return PUBLIC_MEDIA_EXTENSIONS.has(ext);
}
