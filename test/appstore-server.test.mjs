/**
 * App Store purchases, checked with Apple rather than believed.
 *
 * The same questions as test/play-server.test.mjs asks of Google's side: is
 * the token Apple is sent the one it expects, does an answer mean what this
 * reads it to mean, and are the two ways a purchase can be misused - handed
 * in by another account, or written over a subscription paid elsewhere -
 * refused. With fetch stood in for, so nothing here reaches Apple.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  apiKeyFrom, signedApiToken, decodeJWS, getSubscriptionStatuses, API,
} from '../supabase/functions/appstore-billing/apple.mjs';
import {
  readStatus, claimedBy, decideWrite, readNotification, tokenMatches,
} from '../supabase/functions/appstore-billing/decide.mjs';

const subtle = webcrypto.subtle;
const b64url = (text) => Buffer.from(text).toString('base64url');
/** A JWS-shaped string with this payload, signature not a real one - as Apple's would arrive, unverified. */
const jws = (payload) => `${b64url(JSON.stringify({ alg: 'ES256', x5c: ['...'] }))}.${b64url(JSON.stringify(payload))}.sig`;

const NOW = Date.parse('2026-09-28T12:00:00Z');
const DAY = 86400000;
const USER = '41a86f02-3fe8-4ecb-9d67-c2fcbe29b966';
const OPTIONS = { bundleId: 'com.halfstop.app', productIds: ['premium.monthly', 'premium.yearly'], now: NOW };

/** A StatusResponse holding one subscription in the given state. */
function statuses({ status = 1, expires = NOW + 20 * DAY, grace, revoked, token = USER.toUpperCase(), product = 'premium.monthly',
  bundle = 'com.halfstop.app', renew = 1, original = '2000000111111111' } = {}) {
  return {
    environment: 'Sandbox',
    bundleId: bundle,
    data: [{
      subscriptionGroupIdentifier: '21000001',
      lastTransactions: [{
        originalTransactionId: original,
        status,
        signedTransactionInfo: jws({
          transactionId: '2000000222222222', originalTransactionId: original, bundleId: bundle, productId: product,
          expiresDate: expires, appAccountToken: token, environment: 'Sandbox',
          ...(revoked ? { revocationDate: revoked } : {}),
        }),
        signedRenewalInfo: jws({ autoRenewStatus: renew, originalTransactionId: original, ...(grace ? { gracePeriodExpiresDate: grace } : {}) }),
      }],
    }],
  };
}

test('appstore: the key is read from the .p8 text or from base64 of it', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIGT\n-----END PRIVATE KEY-----';
  assert.equal(apiKeyFrom(pem), pem);
  assert.equal(apiKeyFrom(Buffer.from(pem).toString('base64')), pem);
  assert.equal(apiKeyFrom(pem.replace(/\n/g, '\\n')), pem, 'escaped newlines from a one-line paste');
  assert.equal(apiKeyFrom('not a key'), '');
  assert.equal(apiKeyFrom(''), '');
});

test('appstore: the API token is ES256, names the issuer, key and app, and verifies', async () => {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = Buffer.from(await subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const key = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;

  const token = await signedApiToken({ key, keyId: 'ABC123DEFG', issuerId: 'issuer-uuid', bundleId: 'com.halfstop.app' },
    { now: NOW, subtle });
  const [header, claims, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'ABC123DEFG', typ: 'JWT' });
  const read = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.deepEqual(read, {
    iss: 'issuer-uuid', iat: NOW / 1000, exp: NOW / 1000 + 1200, aud: 'appstoreconnect-v1', bid: 'com.halfstop.app',
  });
  const valid = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey,
    Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${header}.${claims}`));
  assert.equal(valid, true, 'the signature is the r||s JWS expects');
});

test('appstore: production is asked first, then the sandbox, and a 404 in both is nobody', async () => {
  const asked = [];
  const answers = [{ status: 404 }, { status: 200, body: { data: [] } }];
  const fetch = async (url, options) => {
    asked.push([url, options.headers.Authorization]);
    const answer = answers.shift();
    return { ok: answer.status === 200, status: answer.status, json: async () => answer.body || {} };
  };
  const found = await getSubscriptionStatuses({ token: 'T', transactionId: '2000000222222222', fetch });
  assert.deepEqual(asked, [
    [`${API.Production}/inApps/v1/subscriptions/2000000222222222`, 'Bearer T'],
    [`${API.Sandbox}/inApps/v1/subscriptions/2000000222222222`, 'Bearer T'],
  ]);
  assert.equal(found.environment, 'Sandbox');

  const none = await getSubscriptionStatuses({ token: 'T', transactionId: '1', fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  assert.equal(none, null);

  await assert.rejects(
    getSubscriptionStatuses({ token: 'T', transactionId: '1', fetch: async () => ({ ok: false, status: 401, json: async () => ({ errorMessage: 'Unauthenticated' }) }) }),
    (error) => error.status === 401 && /Unauthenticated/.test(error.message),
  );
});

test('appstore: an active subscription grants until its date, to the account it names', () => {
  const read = readStatus(statuses(), OPTIONS);
  assert.equal(read.entitled, true);
  assert.equal(read.userId, USER, 'Apple may upper-case the UUID; the account id is lower case');
  assert.equal(read.expiresAt, new Date(NOW + 20 * DAY).toISOString());
  assert.equal(read.renews, true);
  assert.equal(read.sandbox, true);
  assert.equal(read.originalTransactionId, '2000000111111111');
  assert.equal(claimedBy(read, USER), true);
  assert.equal(claimedBy(read, 'someone-else'), false);
  assert.equal(readStatus(statuses({ renew: 0 }), OPTIONS).renews, false, 'cancelled, running to its end');
});

test('appstore: the grace period keeps access, billing retry does not, and revoked ends now', () => {
  const grace = readStatus(statuses({ status: 4, expires: NOW - DAY, grace: NOW + 6 * DAY }), OPTIONS);
  assert.equal(grace.entitled, true);
  assert.equal(grace.expiresAt, new Date(NOW + 6 * DAY).toISOString());

  const retry = readStatus(statuses({ status: 3, expires: NOW - DAY }), OPTIONS);
  assert.equal(retry.entitled, false);

  for (const revoked of [readStatus(statuses({ status: 5 }), OPTIONS), readStatus(statuses({ status: 1, revoked: NOW - 1000 }), OPTIONS)]) {
    assert.equal(revoked.entitled, false);
    assert.equal(revoked.expiresAt, new Date(NOW).toISOString(), 'a refunded subscription ends now, not on its old date');
    assert.equal(revoked.renews, false);
  }

  // A status that says active over a date that has passed: the date wins.
  assert.equal(readStatus(statuses({ status: 1, expires: NOW - 1 }), OPTIONS).entitled, false);
});

test('appstore: another app’s or another product’s purchase is not ours', () => {
  assert.equal(readStatus(statuses({ bundle: 'com.example.other' }), OPTIONS).ours, false);
  assert.equal(readStatus(statuses({ product: 'coins.100' }), OPTIONS).ours, false);
  assert.equal(readStatus({}, OPTIONS).ours, false);
});

test('appstore: a purchase naming no account, or another subscription’s ending, writes nothing', () => {
  assert.equal(decideWrite(readStatus(statuses({ token: '' }), OPTIONS), null, { now: NOW }).action, 'ignore');
  // Expired, and not the subscription on record: nothing to end.
  const expired = readStatus(statuses({ status: 2, expires: NOW - DAY, original: '999' }), OPTIONS);
  const held = { source: 'appstore', external_ref: '2000000111111111', expires_at: new Date(NOW + DAY).toISOString() };
  assert.equal(decideWrite(expired, held, { now: NOW }).action, 'ignore');
  // The same subscription ending does end the row.
  const ended = decideWrite(readStatus(statuses({ status: 5 }), OPTIONS), held, { now: NOW });
  assert.equal(ended.action, 'write');
  assert.equal(ended.row.expires_at, new Date(NOW).toISOString());
});

test('appstore: never written over a subscription still charging on the website or Google Play', () => {
  const active = readStatus(statuses(), OPTIONS);
  for (const source of ['stripe', 'play']) {
    const held = { source, external_ref: 'x', expires_at: new Date(NOW + 10 * DAY).toISOString() };
    const decided = decideWrite(active, held, { now: NOW });
    assert.equal(decided.action, 'conflict', `written over ${source}`);
    assert.match(decided.why, new RegExp(source));
  }
  // A lapsed row from elsewhere is not in the way.
  const lapsed = { source: 'stripe', external_ref: 'x', expires_at: new Date(NOW - DAY).toISOString() };
  assert.equal(decideWrite(active, lapsed, { now: NOW }).action, 'write');
  // A grant or a trial is replaced by a purchase.
  assert.equal(decideWrite(active, { source: 'trial', expires_at: new Date(NOW + DAY).toISOString() }, { now: NOW }).action, 'write');
});

test('appstore: the row written says what, whose, until when, and which subscription', () => {
  const decided = decideWrite(readStatus(statuses({ product: 'premium.yearly' }), OPTIONS), null, { now: NOW });
  assert.deepEqual(decided.row, {
    user_id: USER, tier: 'premium', source: 'appstore',
    expires_at: new Date(NOW + 20 * DAY).toISOString(),
    external_ref: '2000000111111111', renews: true,
    note: 'App Store active, premium.yearly, sandbox',
    updated_at: new Date(NOW).toISOString(),
  });
});

test('appstore: a notification only names a transaction, and a test is a test', () => {
  const signed = (payload) => ({ signedPayload: jws(payload) });
  assert.deepEqual(readNotification(signed({ notificationType: 'TEST', data: { bundleId: 'com.halfstop.app' } })),
    { kind: 'test', bundleId: 'com.halfstop.app', transactionId: '', type: 'TEST' });
  assert.deepEqual(readNotification(signed({
    notificationType: 'DID_RENEW',
    data: { bundleId: 'com.halfstop.app', signedTransactionInfo: jws({ transactionId: '2000000333333333' }) },
  })), { kind: 'subscription', bundleId: 'com.halfstop.app', transactionId: '2000000333333333', type: 'DID_RENEW' });
  assert.equal(readNotification({ signedPayload: 'nonsense' }).kind, 'other');
  assert.equal(readNotification(null).kind, 'other');
  assert.equal(decodeJWS('a.b'), null);
});

test('appstore: the notification secret is compared exactly, and none set accepts nothing', () => {
  assert.equal(tokenMatches('s3cret-long-token', 's3cret-long-token'), true);
  assert.equal(tokenMatches('s3cret-long-toke', 's3cret-long-token'), false);
  assert.equal(tokenMatches('', ''), false);
  assert.equal(tokenMatches('anything', ''), false);
});
