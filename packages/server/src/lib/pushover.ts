/**
 * Push to a phone via Pushover (#493). Configured with PUSHOVER_APP_TOKEN
 * and PUSHOVER_USER_KEY; with either unset it is a no-op, like
 * `lib/email.ts` without SMTP_HOST. Errors are logged, never thrown.
 */

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';

export interface PushInput {
  title: string;
  message: string;
  url?: string;
  urlTitle?: string;
}

export function pushoverConfigured(): boolean {
  return Boolean(process.env.PUSHOVER_APP_TOKEN && process.env.PUSHOVER_USER_KEY);
}

/** Send one push. True when Pushover accepted it; false when unconfigured or it failed. */
export async function sendPush(input: PushInput, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return false;
  const body = new URLSearchParams({ token, user, title: input.title, message: input.message });
  if (input.url) body.set('url', input.url);
  if (input.urlTitle) body.set('url_title', input.urlTitle);
  try {
    const res = await fetchImpl(PUSHOVER_URL, { method: 'POST', body });
    if (!res.ok) {
      console.warn(`[pushover] send failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[pushover] send failed:', err);
    return false;
  }
}
