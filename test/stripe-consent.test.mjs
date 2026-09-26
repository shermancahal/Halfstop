/**
 * The sentence Stripe Checkout shows above the pay button.
 *
 * It is what makes "digital services are exempt from the fourteen-day right
 * of withdrawal" true for somebody in the EU: the exemption needs them to ask
 * for the service to start now and to acknowledge losing the right, before
 * they pay. And it is a string sent to Stripe on every checkout, where one
 * character past Stripe's limit fails the whole Session.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CONSENT_MESSAGE, STRIPE_CUSTOM_TEXT_LIMIT, consentFields,
} from '../supabase/functions/stripe-checkout/consent.mjs';

test('consent: it asks to start now, acknowledges losing the right, and says how to leave', () => {
  assert.match(CONSENT_MESSAGE, /start straight away/);
  assert.match(CONSENT_MESSAGE, /ends the 14-day right to withdraw/);
  assert.match(CONSENT_MESSAGE, /cancel at any time/);
});

test('consent: it fits Stripe\'s limit, and a message that would not is not sent at all', () => {
  assert.ok(CONSENT_MESSAGE.length <= STRIPE_CUSTOM_TEXT_LIMIT);
  assert.deepEqual(consentFields(), { 'custom_text[submit][message]': CONSENT_MESSAGE });
  // Too long fails every checkout; leaving it off fails none.
  assert.deepEqual(consentFields('x'.repeat(STRIPE_CUSTOM_TEXT_LIMIT + 1)), {});
  assert.deepEqual(consentFields(''), {});
});

test('consent: the checkout sends it, and the terms say the same thing', async () => {
  const source = await readFile(new URL('../supabase/functions/stripe-checkout/index.ts', import.meta.url), 'utf8');
  assert.match(source, /\.\.\.consentFields\(\)/);
  const terms = (await readFile(new URL('../terms.html', import.meta.url), 'utf8')).replace(/\s+/g, ' ');
  assert.match(terms, /asking us to start immediately, and accepting that this ends the fourteen-day right/);
});
