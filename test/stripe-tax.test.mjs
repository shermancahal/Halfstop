/**
 * Whether a checkout asks Stripe to work out VAT, and what it asks for.
 *
 * The thing being guarded is a half-configuration rather than a crash. Tax
 * that is calculated without an address to calculate it on, or a business
 * that cannot give its VAT number, both produce a checkout that completes and
 * takes money - just the wrong amount, for months, before anybody notices on
 * a return. So the three fields are asserted together, and the switch is
 * asserted to be off unless somebody clearly said otherwise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { taxFields, taxIsOn } from '../supabase/functions/stripe-checkout/tax.mjs';

test('stripe tax: off until it is asked for', async () => {
  /*
   * The default matters more than it looks. Stripe refuses a Session whose
   * price has no tax_behavior, so sending these before the dashboard is
   * finished turns every checkout into a 502 - and this code reaches
   * production before that work is done, by design.
   */
  for (const unset of [undefined, null, '', '   ']) {
    assert.equal(taxIsOn(unset), false, JSON.stringify(unset));
    assert.deepEqual(taxFields(unset), {});
  }
});

test('stripe tax: on when the secret says so, however it was typed', () => {
  // Pasted into a dashboard field by a person, so leading space and a capital
  // are the ordinary case rather than the exotic one.
  for (const yes of ['true', 'TRUE', ' True ', '1', 'yes', 'on']) {
    assert.equal(taxIsOn(yes), true, yes);
  }
});

test('stripe tax: anything else is off, including the word false', () => {
  /*
   * "Not empty" would have been the easy rule and it reads
   * STRIPE_AUTOMATIC_TAX=false as an instruction to collect tax, which is the
   * worst available answer: it is the one somebody types when they mean to
   * turn it off.
   */
  for (const no of ['false', 'FALSE', '0', 'no', 'off', 'enabled', 'disabled', 'maybe']) {
    assert.equal(taxIsOn(no), false, no);
    assert.deepEqual(taxFields(no), {});
  }
});

test('stripe tax: the calculation never ships without something to calculate on', () => {
  /*
   * Stripe has to place the customer in a country to know the rate, and for a
   * digital service the billing address is the evidence they were placed
   * correctly. `auto` collects one only when the payment method demands it,
   * which for a card is frequently never - so tax would be worked out from
   * whatever Stripe could infer, and the record of why would not exist.
   */
  const fields = taxFields('true');
  assert.equal(fields['automatic_tax[enabled]'], 'true');
  assert.equal(fields.billing_address_collection, 'required',
    'tax is being calculated without requiring the address it is calculated from');
});

test('stripe tax: an EU business can give a VAT number', () => {
  // Without this a VAT-registered company is charged VAT it then has to claim
  // back, where the reverse charge would have meant not charging it at all.
  assert.equal(taxFields('true')['tax_id_collection[enabled]'], 'true');
});

test('stripe tax: the fields are the form encoding Stripe reads', () => {
  /*
   * Strings, not booleans, and the nested keys spelled out. The session body
   * is form-encoded by a function typed Record<string, string>; a real `true`
   * would encode to the same four characters today and is the kind of thing
   * that stops being true when the encoder changes.
   */
  for (const [key, value] of Object.entries(taxFields('true'))) {
    assert.equal(typeof value, 'string', key);
  }
  assert.deepEqual(Object.keys(taxFields('true')).sort(), [
    'automatic_tax[enabled]', 'billing_address_collection', 'tax_id_collection[enabled]',
  ]);
});

test('stripe tax: the checkout actually sends them', async () => {
  /*
   * The module can be perfect and unreferenced. This is the join: a source
   * check, because the call it is part of wants Stripe, Supabase and a
   * signed-in caller, and none of those belong in a unit test.
   */
  const source = await readFile(
    new URL('../supabase/functions/stripe-checkout/index.ts', import.meta.url), 'utf8');

  assert.match(source, /import \{ taxFields \} from '\.\/tax\.mjs'/,
    'stripe-checkout does not import the tax fields');
  assert.match(source, /\.\.\.taxFields\(env\('STRIPE_AUTOMATIC_TAX'\)\)/,
    'stripe-checkout does not spread the tax fields into the session body');

  // And inside the body of the Stripe call rather than somewhere harmless.
  const body = source.slice(source.indexOf("body: form({"), source.indexOf('});', source.indexOf("body: form({")));
  assert.ok(body.includes('taxFields'), 'the tax fields are not in the Checkout Session body');
});
