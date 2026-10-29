/**
 * Revoking Sign in with Apple when an account is closed.
 *
 * Apple asks an app that offers Sign in with Apple to revoke the user's
 * tokens when they delete their account, so the app stops being listed under
 * "Sign in with Apple" in their Apple ID settings and the next sign-in is a
 * fresh one. Supabase keeps no Apple token to revoke, and nothing here stores
 * one either: the iPhone app shows Apple's sheet once more when the account is
 * closed, and hands this the one-time authorization code it returns. That
 * code is exchanged for a token and the token is revoked, there and then.
 *
 * Plain JavaScript, like appstore-billing/apple.mjs, so the request shapes
 * are tested rather than trusted; everything that talks to Apple takes
 * `fetch` as an argument. The key handling is that file's, repeated rather
 * than imported, because each function is deployed as its own bundle.
 *
 * WHAT THE KEY IS
 *
 * A "Sign in with Apple" key from the Apple Developer site (Keys), with the
 * app's App ID as its primary - not the In-App Purchase key, which Apple's
 * token endpoint refuses. It signs a short-lived client secret naming the
 * team, the key and the app.
 */

export const APPLE_ID = 'https://appleid.apple.com';

const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodeJson = (value) => base64url(new TextEncoder().encode(JSON.stringify(value)));

/** The key's PEM text from a secret holding the .p8 file or base64 of it, or ''. */
export function signInKeyFrom(raw) {
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
 * The client secret Apple's token endpoints ask for: ES256, signed with the
 * Sign in with Apple key, naming the team (issuer) and the app (subject).
 * Five minutes, which is all one deletion needs.
 */
export async function clientSecret({ key, keyId, teamId, clientId }, {
  now = Date.now(), subtle = globalThis.crypto.subtle,
} = {}) {
  const iat = Math.floor(now / 1000);
  const header = { alg: 'ES256', kid: keyId };
  const claims = { iss: teamId, iat, exp: iat + 5 * 60, aud: APPLE_ID, sub: clientId };
  const unsigned = `${encodeJson(header)}.${encodeJson(claims)}`;
  const imported = await subtle.importKey('pkcs8', pemBytes(key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto's ECDSA signature is already r || s, which is what JWS wants.
  const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, imported, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(signature)}`;
}

/** The `sub` of an Apple ID token - which Apple ID it is for - decoded, not verified. */
export function idTokenSubject(idToken) {
  const part = String(idToken || '').split('.')[1];
  if (!part) return '';
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return String(JSON.parse(atob(padded))?.sub || '');
  } catch {
    return '';
  }
}

async function said(response) {
  try {
    const body = await response.json();
    return body?.error_description || body?.error || '';
  } catch {
    return '';
  }
}

const form = (fields) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

/**
 * Exchange the app's one-time code for a token, and revoke it.
 *
 * `expectSubject` is the Apple ID the closing account signed in with. A code
 * for any other Apple ID is refused rather than revoked: a code is not the
 * caller's to name, and revoking somebody else's link is not this account's
 * business.
 *
 * Never throws for something Apple says. A refusal comes back as
 * { revoked: false, why }, because the account is closed either way - a
 * deletion is not held hostage to Apple's answer.
 *
 * @returns {Promise<{revoked: boolean, why?: string}>}
 */
export async function revokeAppleLink({
  code, expectSubject = '', key, keyId, teamId, clientId, fetch = globalThis.fetch, now, subtle,
}) {
  if (!code) return { revoked: false, why: 'no authorization code' };
  const secret = await clientSecret({ key, keyId, teamId, clientId }, { now, subtle });

  const exchanged = await fetch(`${APPLE_ID}/auth/token`, form({
    client_id: clientId, client_secret: secret, code, grant_type: 'authorization_code',
  }));
  if (!exchanged.ok) {
    return { revoked: false, why: `Apple refused the code: ${exchanged.status} ${await said(exchanged)}`.trim() };
  }
  const tokens = await exchanged.json();

  const subject = idTokenSubject(tokens?.id_token);
  if (expectSubject && subject !== expectSubject) {
    return { revoked: false, why: 'the code is for a different Apple ID' };
  }

  const refresh = String(tokens?.refresh_token || '');
  const token = refresh || String(tokens?.access_token || '');
  if (!token) return { revoked: false, why: 'Apple returned no token to revoke' };

  const revoked = await fetch(`${APPLE_ID}/auth/revoke`, form({
    client_id: clientId, client_secret: secret, token,
    token_type_hint: refresh ? 'refresh_token' : 'access_token',
  }));
  if (!revoked.ok) {
    return { revoked: false, why: `Apple refused the revocation: ${revoked.status} ${await said(revoked)}`.trim() };
  }
  return { revoked: true };
}
