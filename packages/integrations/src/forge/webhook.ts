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
  /** Which forge sent it, by its own header: `gitea` when `X-Gitea-Event` is present, else `github`. */
  kind: 'github' | 'gitea';
}

type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Read the forge event headers off an inbound request. Gitea sends the
 * GitHub-compatible headers as well (verified on 1.27), so the GitHub
 * names win and the Gitea ones are the fallback; `kind` records who sent it
 * so the ingest can normalise Gitea's action vocabulary.
 */
export function readWebhookHeaders(headers: HeaderBag): WebhookHeaders {
  const giteaEvent = header(headers, 'x-gitea-event');
  const giteaSig = header(headers, 'x-gitea-signature');
  return {
    event: header(headers, 'x-github-event') ?? giteaEvent,
    signature:
      header(headers, 'x-hub-signature-256') ??
      (giteaSig ? (giteaSig.startsWith('sha256=') ? giteaSig : `sha256=${giteaSig}`) : undefined),
    delivery: header(headers, 'x-github-delivery') ?? header(headers, 'x-gitea-delivery'),
    kind: giteaEvent ? 'gitea' : 'github',
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
