/**
 * Webhook helpers shared by every forge.
 *
 * GitHub signs deliveries with HMAC-SHA256 over the raw body and sends
 * `sha256=<hex>` in `X-Hub-Signature-256`. Gitea sends the same header
 * (plus its own `X-Gitea-Signature`, bare hex), so one verifier serves both.
 */

export interface WebhookHeaders {
  /** Event name, e.g. `issues`, `pull_request`. */
  event: string | undefined;
  /** `sha256=<hex>` signature over the raw body. */
  signature: string | undefined;
  /** Unique delivery id, when the forge sends one. */
  delivery: string | undefined;
}

type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Read the forge event headers off an inbound request. GitHub-compatible
 * headers only for now — Gitea sends them too. #368 adds the `X-Gitea-*`
 * fallbacks once real deliveries have been captured as fixtures.
 */
export function readWebhookHeaders(headers: HeaderBag): WebhookHeaders {
  return {
    event: header(headers, 'x-github-event'),
    signature: header(headers, 'x-hub-signature-256'),
    delivery: header(headers, 'x-github-delivery'),
  };
}

/**
 * Verify a webhook signature (HMAC-SHA256, `sha256=` prefixed hex).
 * Returns true if the signature is valid.
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!signature) return false;

  // Use Node.js crypto via dynamic import to keep this file
  // free of Node.js-specific imports at the top level
  const { createHmac, timingSafeEqual } = await import('node:crypto');

  const expected = 'sha256=' + createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  // Constant-time comparison
  if (expected.length !== signature.length) return false;

  try {
    return timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}
