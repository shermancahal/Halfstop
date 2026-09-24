/**
 * Asking Google about a Play purchase, as the developer rather than the buyer.
 *
 * Plain JavaScript, like stripe-webhook/signature.mjs, so the parts that can
 * be wrong quietly are tested rather than trusted: the service account is
 * read, a token is signed with its key, and the request names the right app
 * and the right purchase. Everything that talks to Google takes `fetch` as an
 * argument, so a test can see exactly what would have been sent.
 *
 * WHY THIS IS THE SAFE HALF
 *
 * The App Store side was left unbuilt because it means verifying signatures
 * on notifications that grant entitlements, where a permissive bug looks like
 * strangers with subscriptions. This is a different shape. Nothing the phone
 * or a notification says is believed: each one only names a purchase token,
 * and what that token bought, for whom and until when is asked of Google's
 * own API over a connection this function opens, authenticated with a key
 * that never leaves Supabase's secrets. A forged request can at most make
 * this ask Google about a token, and write down whatever Google answers.
 */

const ANDROID_PUBLISHER = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

/**
 * The service account from the secret it was pasted into.
 *
 * The key file Google Cloud downloads is JSON with the private key inside it,
 * newlines escaped. Accepted as that JSON or as base64 of it, because the
 * JSON is multi-line and some ways of setting a secret mangle newlines - and
 * a key with its newlines lost is a key that does not import, reported as
 * something about ASN.1 rather than as "the paste went wrong".
 *
 * @returns {{ email: string, key: string, tokenUri: string } | null}
 */
export function serviceAccountFrom(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const attempts = [text];
  if (!text.startsWith('{')) {
    try {
      attempts.push(atob(text));
    } catch {
      /* not base64 either */
    }
  }
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      const email = String(parsed?.client_email || '');
      const key = String(parsed?.private_key || '').replace(/\\n/g, '\n');
      if (email && key.includes('PRIVATE KEY')) {
        return { email, key, tokenUri: String(parsed.token_uri || TOKEN_URI) };
      }
    } catch {
      /* try the next reading */
    }
  }
  return null;
}

const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodeJson = (value) => base64url(new TextEncoder().encode(JSON.stringify(value)));

/** A PKCS#8 PEM, as the bytes WebCrypto wants. */
function pemBytes(pem) {
  const body = String(pem).replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
}

/**
 * The signed assertion a service account trades for an access token.
 *
 * RS256 over header.claims, per Google's server-to-server OAuth. An hour is
 * the most Google accepts, and this is used within the second it is made.
 */
export async function signedAssertion(account, { now = Date.now(), subtle = globalThis.crypto.subtle } = {}) {
  const issued = Math.floor(now / 1000);
  const unsigned = `${encodeJson({ alg: 'RS256', typ: 'JWT' })}.${encodeJson({
    iss: account.email,
    scope: SCOPE,
    aud: account.tokenUri || TOKEN_URI,
    iat: issued,
    exp: issued + 3600,
  })}`;
  const key = await subtle.importKey('pkcs8', pemBytes(account.key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(signature)}`;
}

/** Google's refusal, as a sentence rather than a status code. */
async function refusal(response, what) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || body?.error_description || body?.error || '';
  } catch {
    /* no body worth reading */
  }
  return new Error(`${what} answered ${response.status}${detail ? `: ${detail}` : ''}`);
}

/** An access token for the Android Publisher API. */
export async function accessToken(account, { fetch = globalThis.fetch, now = Date.now(), subtle } = {}) {
  const assertion = await signedAssertion(account, { now, ...(subtle ? { subtle } : {}) });
  const response = await fetch(account.tokenUri || TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`,
  });
  if (!response.ok) throw await refusal(response, 'Google sign-in for the service account');
  const body = await response.json();
  if (!body?.access_token) throw new Error('Google sign-in for the service account returned no token');
  return body.access_token;
}

/**
 * What a purchase token is, according to Google.
 *
 * subscriptionsv2 rather than the older subscriptions.get: it is the one that
 * reports base plans, and the one Google keeps current.
 */
export async function getSubscription({ accessToken: bearer, packageName, purchaseToken, fetch = globalThis.fetch }) {
  const url = `${ANDROID_PUBLISHER}/${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) throw await refusal(response, 'Google Play');
  return response.json();
}

/**
 * Tell Google the purchase has been honoured.
 *
 * Until this is called, Google refunds the purchase three days after it was
 * made. It is called only after the entitlement is written, so a purchase this
 * project failed to record is one Google returns without anybody noticing.
 */
export async function acknowledge({ accessToken: bearer, packageName, productId, purchaseToken, fetch = globalThis.fetch }) {
  const url = `${ANDROID_PUBLISHER}/${encodeURIComponent(packageName)}/purchases/subscriptions/`
    + `${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw await refusal(response, 'Google Play acknowledgement');
  return true;
}
