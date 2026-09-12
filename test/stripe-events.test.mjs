/**
 * What a Stripe event means for somebody's entitlement.
 *
 * Extracted and tested because reading it carefully was not enough: the first
 * version granted permanent Premium on a completed checkout, since a Checkout
 * Session has no period end, the expiry came out null, and null means never
 * expires. Nothing about that looked wrong on the page.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readEvent, periodEnd, ACTIVE } from '../supabase/functions/stripe-webhook/events.mjs';

const NOW = 1_760_000_000_000;
const IN_A_MONTH = Math.floor(NOW / 1000) + 30 * 24 * 60 * 60;

const subscription = (extra = {}) => ({
  type: 'customer.subscription.updated',
  data: {
    object: {
      id: 'sub_123',
      status: 'active',
      current_period_end: IN_A_MONTH,
      metadata: { supabase_user_id: 'u1' },
      ...extra,
    },
  },
});

test('stripe: an active subscription grants until the period it paid for', () => {
  const read = readEvent(subscription(), { now: NOW });
  assert.equal(read.action, 'grant');
  assert.equal(read.userId, 'u1');
  assert.equal(read.externalRef, 'sub_123', 'the subscription id, which the portal looks up');
  assert.equal(read.expiresAt, new Date(IN_A_MONTH * 1000).toISOString());
});

test('stripe: a completed checkout grants nothing at all', () => {
  /*
   * The bug this exists for. A session has no status and no period end, and
   * its id is the session's rather than the subscription's, so granting from
   * it meant an entitlement with the wrong reference and no expiry - which is
   * permanent Premium for anyone who reached the checkout.
   */
  const read = readEvent({
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_abc', client_reference_id: 'u1', subscription: 'sub_123' } },
  }, { now: NOW });
  assert.equal(read.action, 'ignore');
  assert.equal(read.expiresAt, undefined, 'and above all, no null expiry');
});

test('stripe: the period end is read from wherever Stripe puts it now', () => {
  // Stripe moved this from the top level onto each item. Missing it does not
  // throw, it returns null, and null is "never expires" - the one direction a
  // billing bug must not fail in.
  assert.equal(periodEnd({ current_period_end: IN_A_MONTH }), new Date(IN_A_MONTH * 1000).toISOString());
  assert.equal(periodEnd({ items: { data: [{ current_period_end: IN_A_MONTH }] } }),
    new Date(IN_A_MONTH * 1000).toISOString());
  assert.equal(periodEnd({}), null);
  assert.equal(periodEnd(null), null);
});

test('stripe: an active subscription with no readable end is capped, not made permanent', () => {
  // Granted, because somebody has just paid and a renamed field is not their
  // fault. For a week, because the alternative is permanent access from a
  // malformed event.
  const read = readEvent(subscription({ current_period_end: undefined }), { now: NOW });
  assert.equal(read.action, 'grant');
  const days = (Date.parse(read.expiresAt) - NOW) / 86400000;
  assert.equal(Math.round(days), 7);
  assert.match(read.why, /granted a week/);
});

test('stripe: a cancelled subscription ends the entitlement', () => {
  const read = readEvent({
    ...subscription(),
    type: 'customer.subscription.deleted',
  }, { now: NOW });
  assert.equal(read.action, 'end');
  assert.equal(read.userId, 'u1');
});

test('stripe: statuses that are not paid-up end it too', () => {
  for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', '']) {
    assert.equal(readEvent(subscription({ status }), { now: NOW }).action, 'end', `${status} should end it`);
  }
});

test('stripe: a card being retried does not switch the maps off', () => {
  // past_due is somebody Stripe is still retrying and still treats as a
  // customer. Cutting them off mid-trip over a retry that usually succeeds is
  // the worse mistake.
  for (const status of ['active', 'trialing', 'past_due']) {
    assert.equal(readEvent(subscription({ status }), { now: NOW }).action, 'grant', `${status} should hold`);
    assert.equal(ACTIVE.has(status), true);
  }
});

test('stripe: an event about somebody we cannot identify does nothing', () => {
  // Not an error and not a guess. Matching on an email address would attach a
  // stranger's payment to whichever account shared it.
  const read = readEvent(subscription({ metadata: {} }), { now: NOW });
  assert.equal(read.action, 'ignore');
  assert.match(read.why, /no supabase_user_id/);
});

test('stripe: events we do not act on are left alone', () => {
  for (const type of ['invoice.paid', 'payment_intent.succeeded', '', 'customer.created']) {
    assert.equal(readEvent({ type, data: { object: {} } }, { now: NOW }).action, 'ignore');
  }
  assert.equal(readEvent(null, { now: NOW }).action, 'ignore', 'and nothing throws on rubbish');
  assert.equal(readEvent(undefined, { now: NOW }).action, 'ignore');
});
