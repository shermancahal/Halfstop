/**
 * Revoking Sign in with Apple when an account is closed: the server's half.
 *
 * Apple is a fake `fetch`, so what is under test is what would be sent: a
 * client secret Apple would accept (signed with the key, naming the team and
 * the app), the one-time code exchanged once, the token revoked, and nothing
 * revoked for an Apple ID that is not the closing account's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  APPLE_ID, clientSecret, idTokenSubject, revokeAppleLink, signInKeyFrom,
} from '../supabase/functions/delete-account/apple.mjs';

const { subtle } = globalThis.crypto;
const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pkcs8 = Buffer.from(await subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
const PEM = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
const KEY = { key: PEM, keyId: 'ABC123DEFG', teamId: 'TEAM123456', clientId: 'com.halfstop.app' };
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

const part = (jwt, index) => JSON.parse(Buffer.from(jwt.split('.')[index], 'base64url').toString());
const idToken = (sub) => `x.${Buffer.from(JSON.stringify({ sub, aud: 'com.halfstop.app' })).toString('base64url')}.sig`;

function apple({ exchange = { status: 200, body: { refresh_token: 'r-1', access_token: 'a-1', id_token: idToken('001.apple') } },
  revoke = { status: 200, body: {} } } = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    const fields = Object.fromEntries(new URLSearchParams(options.body));
    calls.push({ url, method: options.method, type: options.headers['Content-Type'], fields });
    const answer = url.endsWith('/auth/token') ? exchange : revoke;
    return { ok: answer.status < 300, status: answer.status, json: async () => answer.body };
  };
  return { calls, fetch };
}

test('apple revoke: the key is read from the .p8 text or base64 of it', () => {
  assert.equal(signInKeyFrom(PEM), PEM);
  assert.equal(signInKeyFrom(Buffer.from(PEM).toString('base64')), PEM);
  assert.equal(signInKeyFrom(PEM.replace(/\n/g, '\\n')), PEM, 'newlines pasted as \\n');
  assert.equal(signInKeyFrom(''), '');
  assert.equal(signInKeyFrom('not a key'), '');
});

test('apple revoke: the client secret is ES256, from the team, for the app, and verifies', async () => {
  const secret = await clientSecret(KEY, { now: NOW });
  assert.deepEqual(part(secret, 0), { alg: 'ES256', kid: 'ABC123DEFG' });
  const claims = part(secret, 1);
  assert.deepEqual(claims, {
    iss: 'TEAM123456', iat: NOW / 1000, exp: NOW / 1000 + 300, aud: APPLE_ID, sub: 'com.halfstop.app',
  });
  const [header, payload, signature] = secret.split('.');
  assert.equal(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey,
    Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${header}.${payload}`)), true);
});

test('apple revoke: the code is exchanged once, and the refresh token revoked', async () => {
  const { calls, fetch } = apple();
  assert.deepEqual(await revokeAppleLink({ ...KEY, code: 'c-1', expectSubject: '001.apple', fetch, now: NOW }),
    { revoked: true });

  assert.equal(calls.length, 2);
  const [exchange, revoke] = calls;
  assert.equal(exchange.url, 'https://appleid.apple.com/auth/token');
  assert.equal(exchange.type, 'application/x-www-form-urlencoded');
  assert.deepEqual({ ...exchange.fields, client_secret: 'jwt' },
    { client_id: 'com.halfstop.app', client_secret: 'jwt', code: 'c-1', grant_type: 'authorization_code' });
  assert.equal(revoke.url, 'https://appleid.apple.com/auth/revoke');
  assert.deepEqual({ ...revoke.fields, client_secret: 'jwt' },
    { client_id: 'com.halfstop.app', client_secret: 'jwt', token: 'r-1', token_type_hint: 'refresh_token' });
  assert.equal(part(revoke.fields.client_secret, 1).sub, 'com.halfstop.app');
});

test('apple revoke: an access token is revoked when Apple gives no refresh token', async () => {
  const { calls, fetch } = apple({ exchange: { status: 200, body: { access_token: 'a-1', id_token: idToken('001.apple') } } });
  assert.equal((await revokeAppleLink({ ...KEY, code: 'c', expectSubject: '001.apple', fetch, now: NOW })).revoked, true);
  assert.deepEqual([calls[1].fields.token, calls[1].fields.token_type_hint], ['a-1', 'access_token']);
});

test('apple revoke: a code for somebody else\'s Apple ID is not revoked', async () => {
  const { calls, fetch } = apple();
  assert.deepEqual(await revokeAppleLink({ ...KEY, code: 'c', expectSubject: '002.someone', fetch, now: NOW }),
    { revoked: false, why: 'the code is for a different Apple ID' });
  assert.equal(calls.length, 1, 'exchanged, and stopped there');
});

test('apple revoke: Apple saying no is an answer, not an exception', async () => {
  const stale = apple({ exchange: { status: 400, body: { error: 'invalid_grant' } } });
  assert.deepEqual(await revokeAppleLink({ ...KEY, code: 'old', expectSubject: '001.apple', fetch: stale.fetch, now: NOW }),
    { revoked: false, why: 'Apple refused the code: 400 invalid_grant' });
  assert.equal(stale.calls.length, 1);

  const refused = apple({ revoke: { status: 400, body: { error: 'invalid_client' } } });
  assert.deepEqual(await revokeAppleLink({ ...KEY, code: 'c', expectSubject: '001.apple', fetch: refused.fetch, now: NOW }),
    { revoked: false, why: 'Apple refused the revocation: 400 invalid_client' });

  assert.deepEqual(await revokeAppleLink({ ...KEY, code: '', fetch: apple().fetch }), { revoked: false, why: 'no authorization code' });
  assert.equal(idTokenSubject('not.a-token'), '');
});

test('apple revoke: the function revokes first, never blocks the deletion on it, and reads no user id from the body', async () => {
  const source = await readFile(new URL('../supabase/functions/delete-account/index.ts', import.meta.url), 'utf8');
  const revoke = source.indexOf('await revokeApple(user, appleCode)');
  const photos = source.indexOf('await removePhotos(admin, user.id)');
  assert.ok(revoke > 0 && revoke < photos, 'the link is revoked before anything is deleted');
  assert.doesNotMatch(source.slice(source.indexOf('async function revokeApple')), /throw /,
    'nothing about Apple can stop the account closing');
  assert.doesNotMatch(source, /body\??\.(user_?id|userId|id)\b/);
});
