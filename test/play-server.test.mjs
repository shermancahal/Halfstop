/**
 * The server half of Google Play: who gets Premium, until when, and on whose
 * word.
 *
 * The function itself is Deno and calls Google, so it cannot run here. Its
 * two modules are plain JavaScript for exactly that reason. google.mjs signs
 * as the service account and asks the right questions; decide.mjs turns the
 * answers into a row. The cases below are the ones that fail silently in
 * production: a purchase token presented by the wrong account, an old
 * subscription's expiry ending the one that replaced it, a cancelled
 * subscription read as a revoked one, a grace period read as an ending.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  accessToken, acknowledge, getSubscription, serviceAccountFrom, signedAssertion,
} from '../supabase/functions/play-billing/google.mjs';
import {
  claimedBy, decideWrite, readNotification, readSubscription, tokenMatches,
} from '../supabase/functions/play-billing/decide.mjs';

const subtle = webcrypto.subtle;
const NOW = Date.parse('2026-09-24T12:00:00Z');
const USER = '0f8b6c1e-5d2a-4a57-9c3e-2b1d0e9f8a7b';
const TOKEN = 'purchase-token-1';

/* ---------------------------------------------------------- the account */

async function serviceAccount() {
  const pair = await subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const der = Buffer.from(await subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
  // As Google's download has it: one line, newlines escaped inside the string.
  const json = JSON.stringify({
    type: 'service_account',
    client_email: 'play-billing@halfstop.iam.gserviceaccount.com',
    private_key: pem,
    token_uri: 'https://oauth2.googleapis.com/token',
  });
  return { json, publicKey: pair.publicKey };
}

const fromBase64url = (text) => Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

test('play server: the key file is read as Google downloads it, or as base64 of it', async () => {
  const { json } = await serviceAccount();
  const direct = serviceAccountFrom(json);
  assert.equal(direct.email, 'play-billing@halfstop.iam.gserviceaccount.com');
  assert.match(direct.key, /^-----BEGIN PRIVATE KEY-----\n/);
  assert.deepEqual(serviceAccountFrom(Buffer.from(json).toString('base64')), direct);
  // With surrounding whitespace, the way a dashboard paste arrives.
  assert.deepEqual(serviceAccountFrom(`\n  ${json}\n`), direct);
});

test('play server: anything that is not a service account key is refused, not half-read', () => {
  assert.equal(serviceAccountFrom(''), null);
  assert.equal(serviceAccountFrom('not json'), null);
  assert.equal(serviceAccountFrom(JSON.stringify({ client_email: 'x@y' })), null);
  // An OAuth client file is JSON from the same console, and not this.
  assert.equal(serviceAccountFrom(JSON.stringify({ installed: { client_id: 'x' } })), null);
});

test('play server: the assertion is signed by the key and says what Google checks', async () => {
  const { json, publicKey } = await serviceAccount();
  const assertion = await signedAssertion(serviceAccountFrom(json), { now: NOW, subtle });
  const [header, claims, signature] = assertion.split('.');

  const valid = await subtle.verify('RSASSA-PKCS1-v1_5', publicKey, fromBase64url(signature),
    new TextEncoder().encode(`${header}.${claims}`));
  assert.equal(valid, true, 'the signature does not verify against the key that made it');

  assert.deepEqual(JSON.parse(fromBase64url(header)), { alg: 'RS256', typ: 'JWT' });
  const said = JSON.parse(fromBase64url(claims));
  assert.equal(said.iss, 'play-billing@halfstop.iam.gserviceaccount.com');
  assert.equal(said.scope, 'https://www.googleapis.com/auth/androidpublisher');
  assert.equal(said.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(said.iat, NOW / 1000);
  // An hour is the most Google accepts.
  assert.equal(said.exp - said.iat, 3600);
});

function recorder(responses) {
  const sent = [];
  const fetch = async (url, options = {}) => {
    sent.push({ url, ...options });
    const next = responses.shift();
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    };
  };
  return { sent, fetch };
}

test('play server: the assertion is traded for a token at the address in the key file', async () => {
  const { json } = await serviceAccount();
  const { sent, fetch } = recorder([{ status: 200, body: { access_token: 'ya29.token' } }]);
  assert.equal(await accessToken(serviceAccountFrom(json), { fetch, now: NOW, subtle }), 'ya29.token');
  assert.equal(sent[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(sent[0].method, 'POST');
  assert.match(sent[0].body, /^grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=[\w-]+\.[\w-]+\.[\w-]+$/);
});

test('play server: a refused service account says what Google said', async () => {
  const { json } = await serviceAccount();
  const { fetch } = recorder([{ status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } }]);
  await assert.rejects(accessToken(serviceAccountFrom(json), { fetch, now: NOW, subtle }), /400: Invalid JWT Signature/);
});

test('play server: the subscription is asked about by package and token, escaped', async () => {
  const { sent, fetch } = recorder([{ status: 200, body: { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' } }]);
  await getSubscription({ accessToken: 'ya29', packageName: 'com.halfstop.app', purchaseToken: 'a/b+c', fetch });
  assert.equal(sent[0].url,
    'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.halfstop.app/purchases/subscriptionsv2/tokens/a%2Fb%2Bc');
  assert.equal(sent[0].headers.Authorization, 'Bearer ya29');

  const gone = recorder([{ status: 410, body: {} }]);
  assert.equal(await getSubscription({ accessToken: 'ya29', packageName: 'p', purchaseToken: 't', fetch: gone.fetch }), null);
  const broken = recorder([{ status: 401, body: { error: { message: 'The current user has insufficient permissions' } } }]);
  await assert.rejects(getSubscription({ accessToken: 'ya29', packageName: 'p', purchaseToken: 't', fetch: broken.fetch }),
    /insufficient permissions/);
});

test('play server: acknowledging names the product as well as the token', async () => {
  const { sent, fetch } = recorder([{ status: 200, body: {} }]);
  await acknowledge({ accessToken: 'ya29', packageName: 'com.halfstop.app', productId: 'premium', purchaseToken: TOKEN, fetch });
  assert.equal(sent[0].url,
    'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.halfstop.app/purchases/subscriptions/premium/tokens/purchase-token-1:acknowledge');
  assert.equal(sent[0].method, 'POST');
});

/* ------------------------------------------------------------ the answer */

/** A SubscriptionPurchaseV2, the parts of it this reads. */
function subscription({
  state = 'SUBSCRIPTION_STATE_ACTIVE', expiry = '2026-10-24T12:00:00Z', renew = true,
  user = USER, product = 'premium', ack = 'ACKNOWLEDGEMENT_STATE_PENDING', test: isTest = false, plan = 'monthly',
} = {}) {
  return {
    subscriptionState: state,
    acknowledgementState: ack,
    ...(user ? { externalAccountIdentifiers: { obfuscatedExternalAccountId: user } } : {}),
    ...(isTest ? { testPurchase: {} } : {}),
    lineItems: [{
      productId: product,
      expiryTime: expiry,
      autoRenewingPlan: { autoRenewEnabled: renew },
      offerDetails: { basePlanId: plan },
    }],
  };
}

const read = (options, extra = {}) => readSubscription(subscription(options), { productId: 'premium', now: NOW, ...extra });

test('play server: an active subscription is Premium until the period ends, renewing', () => {
  const got = read();
  assert.equal(got.entitled, true);
  assert.equal(got.expiresAt, '2026-10-24T12:00:00.000Z');
  assert.equal(got.renews, true);
  assert.equal(got.userId, USER);
  assert.equal(got.needsAck, true);
  assert.equal(got.basePlan, 'monthly');
});

test('play server: cancelled means runs to the end of the period, not revoked', () => {
  // Google's CANCELED is Stripe's cancel_at_period_end. Reading it as an
  // ending would take away a month somebody has paid for.
  const got = read({ state: 'SUBSCRIPTION_STATE_CANCELED', renew: false });
  assert.equal(got.entitled, true);
  assert.equal(got.renews, false);
  assert.equal(got.expiresAt, '2026-10-24T12:00:00.000Z');
});

test('play server: a grace period keeps access even with the period behind it', () => {
  const got = read({ state: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', expiry: '2026-09-23T12:00:00Z' });
  assert.equal(got.entitled, true);
  assert.ok(Date.parse(got.expiresAt) > NOW, 'a grace period was written as an ending');
});

test('play server: expired, on hold, paused and pending grant nothing, and end now at the latest', () => {
  for (const state of ['SUBSCRIPTION_STATE_EXPIRED', 'SUBSCRIPTION_STATE_ON_HOLD', 'SUBSCRIPTION_STATE_PAUSED', 'SUBSCRIPTION_STATE_PENDING']) {
    const got = read({ state });
    assert.equal(got.entitled, false, state);
    assert.ok(Date.parse(got.expiresAt) <= NOW, `${state} was given a date still to come`);
    assert.equal(got.renews, false, state);
  }
  assert.equal(read({ state: 'SUBSCRIPTION_STATE_PENDING' }).pending, true);
});

test('play server: an active state over a date that has passed is not believed', () => {
  assert.equal(read({ expiry: '2026-09-01T00:00:00Z' }).entitled, false);
});

test('play server: another product in the same app is not Premium', () => {
  const got = read({ product: 'something-else' });
  assert.equal(got.ours, false);
  assert.equal(got.entitled, false);
});

test('play server: a purchase token handed in by another account is not theirs', () => {
  // A token is not a secret to the person who bought it; the account id Google
  // holds for the purchase is what says whose it is.
  assert.equal(claimedBy(read(), USER), true);
  assert.equal(claimedBy(read(), 'a-different-account'), false);
  assert.equal(claimedBy(read({ user: '' }), ''), false);
  assert.equal(claimedBy(read({ user: '' }), USER), false);
});

/* ------------------------------------------------------------- the row */

const decide = (options, held, extra = {}) => decideWrite(read(options), held, { purchaseToken: TOKEN, now: NOW, ...extra });

test('play server: a first purchase writes a Play row for the account it names', () => {
  const got = decide({}, null);
  assert.equal(got.action, 'write');
  assert.equal(got.row.user_id, USER);
  assert.equal(got.row.source, 'play');
  assert.equal(got.row.tier, 'premium');
  assert.equal(got.row.external_ref, TOKEN);
  assert.equal(got.row.expires_at, '2026-10-24T12:00:00.000Z');
  assert.match(got.row.note, /Google Play active, monthly/);
});

test('play server: a licence tester\'s purchase says so on the row', () => {
  assert.match(decide({ test: true }, null).row.note, /test purchase/);
});

test('play server: a purchase naming no account is not guessed at', () => {
  // A promotional code redeemed in the Play Store arrives with no account id.
  assert.equal(decide({ user: '' }, null).action, 'ignore');
});

test('play server: paying replaces a trial or a hand-made grant', () => {
  const trial = { source: 'trial', external_ref: null, expires_at: '2026-10-01T00:00:00Z' };
  assert.equal(decide({}, trial).action, 'write');
  assert.equal(decide({}, { source: 'granted', external_ref: null, expires_at: null }).action, 'write');
});

test('play server: a running Stripe subscription is never written over', () => {
  // One row per account. Writing over it hides a subscription still charging.
  const card = { source: 'stripe', external_ref: 'sub_1', expires_at: '2026-10-10T00:00:00Z' };
  assert.equal(decide({}, card).action, 'conflict');
  // An inactive Play purchase beside it is simply not ours to act on.
  assert.equal(decide({ state: 'SUBSCRIPTION_STATE_EXPIRED' }, card).action, 'ignore');
  // One that has run out is history, and paying through Play replaces it.
  assert.equal(decide({}, { ...card, expires_at: '2026-09-01T00:00:00Z' }).action, 'write');
});

test('play server: the end of the subscription on record ends the row', () => {
  const held = { source: 'play', external_ref: TOKEN, expires_at: '2026-10-24T12:00:00Z' };
  const got = decide({ state: 'SUBSCRIPTION_STATE_EXPIRED', expiry: '2026-09-24T11:00:00Z' }, held);
  assert.equal(got.action, 'write');
  assert.equal(got.row.expires_at, '2026-09-24T11:00:00.000Z');
  assert.equal(got.row.renews, false);
});

test('play server: an old subscription expiring does not end the one that replaced it', () => {
  // Switching monthly to yearly gives the subscriber a new token and expires
  // the old one. Heard in that order, the old expiry would end the new year.
  const held = { source: 'play', external_ref: 'the-new-token', expires_at: '2027-09-24T12:00:00Z' };
  assert.equal(decide({ state: 'SUBSCRIPTION_STATE_EXPIRED' }, held).action, 'ignore');
  // While a new active one does replace the old.
  assert.equal(decide({}, { ...held, external_ref: 'the-old-token' }).action, 'write');
});

test('play server: a refund ends the purchase it refunds, and only that one', () => {
  const held = { source: 'play', external_ref: TOKEN, expires_at: '2026-10-24T12:00:00Z' };
  assert.equal(decide({}, held, { voided: true }).action, 'end');
  assert.equal(decide({}, { ...held, external_ref: 'another' }, { voided: true }).action, 'ignore');
});

test('play server: a pending payment writes nothing yet', () => {
  const got = decide({ state: 'SUBSCRIPTION_STATE_PENDING' }, null);
  assert.equal(got.action, 'ignore');
  assert.match(got.why, /pending/);
});

/* ------------------------------------------------------ notifications */

const envelope = (payload) => ({
  message: { data: Buffer.from(JSON.stringify(payload)).toString('base64'), messageId: '1' },
  subscription: 'projects/halfstop/subscriptions/play-billing',
});

test('play server: a subscription notification names its token', () => {
  const got = readNotification(envelope({
    version: '1.0', packageName: 'com.halfstop.app', eventTimeMillis: '1',
    subscriptionNotification: { version: '1.0', notificationType: 2, purchaseToken: TOKEN, subscriptionId: 'premium' },
  }));
  assert.deepEqual(got, { kind: 'subscription', packageName: 'com.halfstop.app', purchaseToken: TOKEN, type: 2 });
});

test('play server: a voided subscription is read as voided; a voided one-time product is not ours', () => {
  const voided = (productType) => readNotification(envelope({
    packageName: 'com.halfstop.app', voidedPurchaseNotification: { purchaseToken: TOKEN, orderId: 'GPA.1', productType, refundType: 1 },
  }));
  assert.equal(voided(1).kind, 'voided');
  assert.equal(voided(1).purchaseToken, TOKEN);
  assert.equal(voided(2).kind, 'other');
});

test('play server: Play Console\'s test, and anything unreadable, act on nothing', () => {
  assert.equal(readNotification(envelope({ packageName: 'com.halfstop.app', testNotification: { version: '1.0' } })).kind, 'test');
  assert.equal(readNotification({ message: { data: '!!!' } }).kind, 'other');
  assert.equal(readNotification(null).kind, 'other');
});

test('play server: the push secret is compared whole', () => {
  assert.equal(tokenMatches('s3cret-value', 's3cret-value'), true);
  assert.equal(tokenMatches('s3cret-valu', 's3cret-value'), false);
  assert.equal(tokenMatches('s3cret-value-and-more', 's3cret-value'), false);
  assert.equal(tokenMatches('', 's3cret-value'), false);
  assert.equal(tokenMatches(null, 's3cret-value'), false);
  // No secret configured is nobody, not everybody.
  assert.equal(tokenMatches('', ''), false);
  assert.equal(tokenMatches('anything', ''), false);
});
