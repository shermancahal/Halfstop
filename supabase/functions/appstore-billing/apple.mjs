/**
 * Asking Apple about an App Store purchase, as the developer rather than the
 * buyer.
 *
 * Plain JavaScript, like play-billing/google.mjs, so the parts that can be
 * wrong quietly are tested rather than trusted: the key is read, a token is
 * signed with it, and the request names the right app and the right purchase.
 * Everything that talks to Apple takes `fetch` as an argument, so a test can
 * see exactly what would have been sent.
 *
 * WHY THIS IS THE SAFE SHAPE
 *
 * Apple signs what the phone and the notifications carry - JWS with a
 * certificate chain in the header - and the tempting design is to verify
 * those signatures and believe the contents. That means parsing X.509 and
 * checking a chain to Apple's root by hand, where a permissive bug looks like
 * strangers with subscriptions. So nothing the phone or a notification sends
 * is believed at all. Each only names a transaction id, and what that
 * transaction is - whose, which product, until when - is read from Apple's
 * App Store Server API over a connection this function opens, authenticated
 * with a key that never leaves Supabase's secrets. The JWS in that answer is
 * decoded, not verified, because it arrived from Apple over TLS in answer to
 * this function's own question; a forged request can at most make this ask
 * Apple about an id, and write down whatever Apple answers.
 */

export const API = {
  Production: 'https://api.storekit.itunes.apple.com',
  Sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
};

const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodeJson = (value) => base64url(new TextEncoder().encode(JSON.stringify(value)));

/**
 * The In-App Purchase key, from the secret the .p8 file was pasted into.
 *
 * Accepted as the file's text or as base64 of it, because the file is
 * multi-line and some ways of setting a secret mangle newlines - and a key
 * with its newlines lost does not import, reported as something about ASN.1
 * rather than as "the paste went wrong".
 *
 * @returns {string} the PEM text, or '' when there is none
 */
export function apiKeyFrom(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.includes('PRIVATE KEY')) return text.replace(/\\n/g, '\n');
  try {
    const decoded = atob(text);
    if (decoded.includes('PRIVATE KEY')) return decoded;
  } catch {
    /* not base64 either */
  }
  return '';
}

function pemBytes(pem) {
  const body = String(pem).replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The bearer token the App Store Server API asks for: ES256, signed with the
 * In-App Purchase key, naming the issuer, the key and the app.
 *
 * Twenty minutes, under Apple's hour, so a clock a little off does not
 * produce a token Apple refuses as too long-lived.
 */
export async function signedApiToken({ key, keyId, issuerId, bundleId }, {
  now = Date.now(), subtle = globalThis.crypto.subtle,
} = {}) {
  const iat = Math.floor(now / 1000);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const claims = { iss: issuerId, iat, exp: iat + 20 * 60, aud: 'appstoreconnect-v1', bid: bundleId };
  const unsigned = `${encodeJson(header)}.${encodeJson(claims)}`;
  const imported = await subtle.importKey('pkcs8', pemBytes(key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto's ECDSA signature is already r || s, which is what JWS wants.
  const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, imported, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(signature)}`;
}

/**
 * The payload of a JWS, decoded and not verified - see the header of this
 * file for why that is enough here, and only here.
 */
export function decodeJWS(jws) {
  const part = String(jws || '').split('.')[1];
  if (!part) return null;
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function refusal(response, what) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.errorMessage || body?.errorCode || '';
  } catch {
    /* no body worth reading */
  }
  return Object.assign(new Error(`${what}: Apple answered ${response.status}${detail ? ` (${detail})` : ''}.`), {
    status: response.status,
  });
}

/**
 * Every subscription status for the customer who owns a transaction.
 *
 * Production first, then the sandbox, which is where TestFlight and
 * development purchases live - Apple's own advice, since a transaction id
 * does not say which it came from. A 404 in both is "Apple does not know it",
 * answered as null rather than thrown.
 *
 * @returns {Promise<object|null>} the StatusResponse, with `environment`
 */
export async function getSubscriptionStatuses({ token, transactionId, fetch = globalThis.fetch }) {
  const id = encodeURIComponent(String(transactionId));
  for (const environment of ['Production', 'Sandbox']) {
    const response = await fetch(`${API[environment]}/inApps/v1/subscriptions/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 404) continue;
    if (!response.ok) throw await refusal(response, 'Reading the subscription');
    const body = await response.json();
    return { environment, ...body };
  }
  return null;
}
