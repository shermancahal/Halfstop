/**
 * The whole of the Stripe webhook's security, tested here rather than in
 * production.
 *
 * The endpoint cannot sit behind a session, because Stripe has none. So the
 * only thing between the open internet and a row saying somebody has paid is
 * this signature check, and a permissive bug in it is not a bug that shows up
 * as a failure - it shows up as strangers with subscriptions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  verify, sign, matches, parseSignatureHeader, DEFAULT_TOLERANCE,
} from '../supabase/functions/stripe-webhook/signature.mjs';

const SECRET = 'whsec_test_secret_value';
const BODY = '{"id":"evt_1","type":"checkout.session.completed"}';
const NOW = 1_760_000_000_000;
const AT = Math.floor(NOW / 1000);

const headerFor = async (payload = BODY, secret = SECRET, timestamp = AT) =>
  `t=${timestamp},v1=${await sign(payload, secret, timestamp)}`;

test('stripe: a request Stripe really signed is accepted', async () => {
  const result = await verify(BODY, await headerFor(), SECRET, { now: NOW });
  assert.deepEqual(result, { ok: true });
});

test('stripe: a body changed in transit is refused', async () => {
  // The signature is over the characters, not the meaning. One flipped digit
  // in an amount has to fail.
  const header = await headerFor();
  const tampered = BODY.replace('evt_1', 'evt_2');
  assert.equal((await verify(tampered, header, SECRET, { now: NOW })).ok, false);
});

test('stripe: a signature from the wrong secret is refused', async () => {
  const header = `t=${AT},v1=${await sign(BODY, 'whsec_someone_elses', AT)}`;
  assert.equal((await verify(BODY, header, SECRET, { now: NOW })).ok, false);
});

test('stripe: a replay of a real request is refused once it is old', async () => {
  /*
   * The one that matters most. A signature does not expire by itself, so a
   * captured request could otherwise be replayed for ever - and "subscription
   * active", replayed after a cancellation, is exactly the one somebody would
   * pick.
   */
  const header = await headerFor();
  const later = NOW + (DEFAULT_TOLERANCE + 5) * 1000;
  const result = await verify(BODY, header, SECRET, { now: later });
  assert.equal(result.ok, false);
  assert.match(result.reason, /tolerance/);

  // And still fine a moment after it was sent.
  assert.equal((await verify(BODY, header, SECRET, { now: NOW + 30_000 })).ok, true);
});

test('stripe: a timestamp from the future is refused too', async () => {
  // Clock skew cuts both ways, so the window is absolute rather than "not
  // older than". A far-future timestamp would otherwise never expire.
  const ahead = AT + DEFAULT_TOLERANCE + 60;
  const header = `t=${ahead},v1=${await sign(BODY, SECRET, ahead)}`;
  assert.equal((await verify(BODY, header, SECRET, { now: NOW })).ok, false);
});

test('stripe: with no secret configured, nothing is believed', async () => {
  // Not "allow everything while it is being set up". An endpoint that writes
  // subscriptions has to refuse rather than fall open.
  const result = await verify(BODY, await headerFor(), '', { now: NOW });
  assert.deepEqual(result, { ok: false, reason: 'no signing secret is configured' });
});

test('stripe: a missing or unreadable header is refused', async () => {
  for (const header of ['', undefined, 'nonsense', 't=,v1=', `t=${AT}`, 'v1=abc']) {
    assert.equal((await verify(BODY, header, SECRET, { now: NOW })).ok, false, `accepted ${header}`);
  }
});

test('stripe: the test-mode v0 scheme is not accepted as a signature', async () => {
  // v0 signs a different payload and exists for the CLI. Treating the two
  // alike is how a scheme meant for a laptop ends up trusted in production.
  const header = `t=${AT},v0=${await sign(BODY, SECRET, AT)}`;
  assert.equal((await verify(BODY, header, SECRET, { now: NOW })).ok, false);
});

test('stripe: a second signature is accepted while a secret rotates', async () => {
  // Stripe sends more than one v1 during rotation, and any of them matching
  // is a pass - otherwise rotating the secret drops every event mid-flight.
  const header = `t=${AT},v1=${'0'.repeat(64)},v1=${await sign(BODY, SECRET, AT)}`;
  assert.equal((await verify(BODY, header, SECRET, { now: NOW })).ok, true);
});

test('stripe: the header parser does not throw on rubbish', () => {
  assert.deepEqual(parseSignatureHeader(null), { timestamp: 0, signatures: [] });
  assert.deepEqual(parseSignatureHeader('t=abc'), { timestamp: 0, signatures: [] });
  assert.equal(parseSignatureHeader(`t=${AT},v1=aa,v1=bb`).signatures.length, 2);
});

test('stripe: the comparison does not leak length or content', () => {
  assert.equal(matches('abc', 'abc'), true);
  assert.equal(matches('abc', 'abd'), false);
  assert.equal(matches('ab', 'abc'), false);
  assert.equal(matches('', ''), false, 'empty is never a match');
});
