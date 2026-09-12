/**
 * Is this really from Stripe?
 *
 * The whole of the webhook's security is this file. The endpoint cannot be
 * behind a session - Stripe has none - so the only thing between the open
 * internet and a row saying somebody has paid is the signature on the request.
 * Get it wrong in the permissive direction and anybody who finds the URL can
 * write themselves a subscription.
 *
 * Plain JavaScript rather than TypeScript, and pure, so the one part that must
 * not be wrong can be tested by `npm test` on this machine instead of only by
 * a real payment in a deployed function.
 *
 * Stripe signs `${timestamp}.${body}` with HMAC-SHA256 under the endpoint
 * secret, and sends it as `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>]`.
 * More than one v1 appears while a secret is being rotated, and any of them
 * matching is a pass.
 */

/** Five minutes, which is Stripe's own suggestion. */
export const DEFAULT_TOLERANCE = 300;

/**
 * Pull the timestamp and the v1 signatures out of the header.
 *
 * Anything unparseable comes back empty rather than throwing, because the
 * caller's answer to both is the same: refuse.
 */
export function parseSignatureHeader(header) {
  const parts = String(header || '').split(',');
  let timestamp = 0;
  const signatures = [];
  for (const part of parts) {
    const [key, value] = part.split('=', 2);
    if (key?.trim() === 't') timestamp = Number(value) || 0;
    // v0 is the test-mode scheme and is deliberately not accepted: it signs a
    // different payload, and treating the two alike is how a scheme meant for
    // the CLI ends up trusted in production.
    if (key?.trim() === 'v1' && value) signatures.push(value.trim());
  }
  return { timestamp, signatures };
}

/** Constant time, so a wrong signature cannot be guessed a character at a time. */
export function matches(given, expected) {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const hex = (buffer) => [...new Uint8Array(buffer)]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** The signature Stripe should have sent for this body at this time. */
export async function sign(payload, secret, timestamp) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  return hex(signed);
}

/**
 * Whether to believe this request.
 *
 * The body has to be the exact bytes Stripe sent, so the caller reads it as
 * text and hands the same string to both this and JSON.parse. Parsing first
 * and re-serialising changes key order and whitespace, and the signature is
 * over the characters rather than over the meaning.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export async function verify(payload, header, secret, { now = Date.now(), tolerance = DEFAULT_TOLERANCE } = {}) {
  if (!secret) return { ok: false, reason: 'no signing secret is configured' };

  const { timestamp, signatures } = parseSignatureHeader(header);
  if (!timestamp || !signatures.length) return { ok: false, reason: 'the signature header is not readable' };

  /*
   * Old enough to be a replay is refused even when the signature is perfect.
   *
   * A signature does not expire on its own, so without this a request captured
   * once could be sent again for ever - and "subscription active" replayed
   * after a cancellation is exactly the one somebody would choose.
   */
  const age = Math.abs(Math.floor(now / 1000) - timestamp);
  if (age > tolerance) return { ok: false, reason: `the timestamp is ${age}s away, outside the tolerance` };

  const expected = await sign(payload, secret, timestamp);
  // Any of them, because more than one arrives while a secret is rotating.
  if (!signatures.some((candidate) => matches(candidate, expected))) {
    return { ok: false, reason: 'no signature matched' };
  }
  return { ok: true };
}
