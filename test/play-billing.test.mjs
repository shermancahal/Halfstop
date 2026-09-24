/**
 * Buying through Google Play, from the phone's side.
 *
 * The plugin is faked here with the shapes @capgo/native-purchases returns.
 * What is pinned is what this file decides: which offer is bought for which
 * button, who it is bought for, that the phone does not acknowledge it, and
 * which failures are said out loud - closing Google's sheet is somebody
 * changing their mind, and an error toast for it would be a lie.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buyOnPlay, playOffer, playPriceLabel, playSaving, purchaseFailure, PLAY_PLUGIN,
} from '../assets/js/lib/play-billing.js';
import { PLAY_PACKAGE } from '../assets/js/lib/manage-plan.js';
import { BILLING } from '../assets/js/config.js';

const OFFERS = [
  // A promotional offer listed first, on the monthly base plan.
  { identifier: 'premium', planIdentifier: 'monthly', offerId: 'launch-discount', offerToken: 'tok-promo', priceString: '$0.99', price: 0.99, currencyCode: 'USD' },
  { identifier: 'premium', planIdentifier: 'monthly', offerId: null, offerToken: 'tok-month', priceString: '$4.99', price: 4.99, currencyCode: 'USD' },
  { identifier: 'premium', planIdentifier: 'yearly', offerId: null, offerToken: 'tok-year', priceString: '$49.00', price: 49, currencyCode: 'USD' },
  { identifier: 'something-else', planIdentifier: 'monthly', offerId: null, offerToken: 'tok-other', priceString: '$1.00', price: 1, currencyCode: 'USD' },
];

test('play: config names a product and a base plan for every plan sold', () => {
  assert.ok(BILLING.play.product);
  assert.deepEqual(Object.keys(BILLING.play.plans).sort(), Object.keys(BILLING.plans).sort());
  // Play Console's rules for the ids, which are permanent once created.
  assert.match(BILLING.play.product, /^[a-z0-9][a-z0-9_.]*$/);
  for (const id of Object.values(BILLING.play.plans)) assert.match(id, /^[a-z0-9][a-z0-9-]*$/);
});

test('play: the base plan\'s own offer is bought, not a discount listed before it', () => {
  assert.equal(playOffer(OFFERS, { planId: 'month' }).offerToken, 'tok-month');
  assert.equal(playOffer(OFFERS, { planId: 'year' }).offerToken, 'tok-year');
});

test('play: a plan Play does not have is refused, not swapped for one it does', () => {
  // The plugin falls back to the first offer it finds, which would sell the
  // monthly plan under a button saying "a year".
  const monthOnly = OFFERS.filter((offer) => offer.planIdentifier === 'monthly');
  assert.equal(playOffer(monthOnly, { planId: 'year' }), null);
  assert.equal(playOffer(OFFERS, { planId: 'week' }), null);
  assert.equal(playOffer(null, { planId: 'month' }), null);
  // And another product's plan with the same name is not ours.
  assert.equal(playOffer([OFFERS[3]], { planId: 'month' }), null);
});

test('play: buttons carry Play\'s price for this country, and the saving is Play\'s too', () => {
  const euros = { month: { price: 5.49, priceString: '5,49 €', currencyCode: 'EUR' }, year: { price: 54.99, priceString: '54,99 €', currencyCode: 'EUR' } };
  assert.equal(playPriceLabel(euros.month, { planId: 'month' }), '5,49 € a month');
  assert.equal(playPriceLabel(euros.year, { planId: 'year' }), '54,99 € a year');
  assert.equal(playPriceLabel(null, { planId: 'month' }), '');

  const saving = playSaving(euros.month, euros.year, { locale: 'en-US' });
  assert.equal(saving.money, '€10.89');
  assert.equal(saving.percent, 17);
  // Two currencies cannot be compared, and a year dearer than twelve months
  // is not a saving.
  assert.equal(playSaving(euros.month, { ...euros.year, currencyCode: 'USD' }), null);
  assert.equal(playSaving(euros.month, { ...euros.year, price: 99 }), null);
});

test('play: closing Google\'s sheet is not an error', () => {
  // The plugin rejects with this for a cancel, the same way as for a failure.
  assert.equal(purchaseFailure({ message: 'Purchase is not purchased', code: 'USER_CANCELED' }), '');
});

test('play: the failures somebody can act on are said in words they can act on', () => {
  assert.match(purchaseFailure({ message: 'Purchase is pending' }), /waiting for that payment/);
  assert.match(purchaseFailure({ message: 'Purchase is not purchased', code: 'ITEM_ALREADY_OWNED' }), /already subscribes/);
  assert.match(purchaseFailure({ message: 'Billing is not available on this device.' }), /cannot take payments on this device/);
  assert.match(purchaseFailure({ message: 'Product not found' }), /does not have that plan/);
  assert.match(purchaseFailure({ message: 'x', code: 'SERVICE_UNAVAILABLE' }), /Could not reach Google Play/);
  assert.match(purchaseFailure(new Error('something new')), /something new/);
});

/** The plugin, as far as buyOnPlay touches it. */
function fakePlugin({ offers = OFFERS, reject = null, token = 'purchase-token-1' } = {}) {
  const calls = [];
  return {
    calls,
    async getProducts(options) { calls.push(['getProducts', options]); return { products: offers }; },
    async purchaseProduct(options) {
      calls.push(['purchaseProduct', options]);
      if (reject) throw reject;
      return { purchaseToken: token, productIdentifier: 'premium' };
    },
  };
}

function fakeAccount() {
  const confirmed = [];
  return {
    confirmed,
    user: { id: '0f8b6c1e-5d2a-4a57-9c3e-2b1d0e9f8a7b', email: 'a@example.com' },
    async confirmPlayPurchase(options) { confirmed.push(options); return { ok: true }; },
  };
}

test('play: a purchase is bought for the signed-in account, and left for the server to acknowledge', async () => {
  const plugin = fakePlugin();
  const account = fakeAccount();
  const result = await buyOnPlay({ account, planId: 'year', plugin });

  assert.deepEqual(result, { ok: true });
  const [, bought] = plugin.calls.find(([name]) => name === 'purchaseProduct');
  assert.equal(bought.productIdentifier, BILLING.play.product);
  assert.equal(bought.productType, 'subs');
  assert.equal(bought.planIdentifier, 'yearly');
  assert.equal(bought.offerToken, 'tok-year');
  // Who it is for, written into the purchase where the server reads it back.
  assert.equal(bought.appAccountToken, account.user.id);
  // Google refunds what nobody acknowledges. The server acknowledges after it
  // has recorded the purchase, so a purchase it failed to record is refunded.
  assert.equal(bought.autoAcknowledgePurchases, false);
  // And only the token goes to the server; it asks Google for the rest.
  assert.deepEqual(account.confirmed, [{ purchaseToken: 'purchase-token-1' }]);
});

test('play: changing your mind at Google\'s sheet records nothing and says nothing', async () => {
  const account = fakeAccount();
  const plugin = fakePlugin({ reject: Object.assign(new Error('Purchase is not purchased'), { code: 'USER_CANCELED' }) });
  assert.deepEqual(await buyOnPlay({ account, planId: 'month', plugin }), { ok: false, cancelled: true });
  assert.deepEqual(account.confirmed, []);
});

test('play: a pending payment is reported as waiting, not as a failure', async () => {
  const account = fakeAccount();
  const plugin = fakePlugin({ reject: new Error('Purchase is pending') });
  const result = await buyOnPlay({ account, planId: 'month', plugin });
  assert.equal(result.ok, false);
  assert.equal(result.pending, true);
  assert.match(result.reason, /turns on by itself/);
});

test('play: nothing is bought for a plan Play does not have, or for nobody', async () => {
  const monthOnly = fakePlugin({ offers: OFFERS.filter((offer) => offer.planIdentifier === 'monthly') });
  const refused = await buyOnPlay({ account: fakeAccount(), planId: 'year', plugin: monthOnly });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /yearly plan/);
  assert.equal(monthOnly.calls.some(([name]) => name === 'purchaseProduct'), false);

  const anyone = fakePlugin();
  const signedOut = await buyOnPlay({ account: { user: null }, planId: 'month', plugin: anyone });
  assert.match(signedOut.reason, /Sign in/);
  assert.deepEqual(anyone.calls, []);
});

test('play: an app built without the plugin says to update, not that Play failed', async () => {
  const result = await buyOnPlay({ account: fakeAccount(), planId: 'month', plugin: null });
  assert.match(result.reason, /Update it/);
});

test('play: the plugin name and package are the ones the app is built with', async () => {
  // The plugin registers itself under this name on window.Capacitor.Plugins;
  // a different spelling is a plugin that is never found.
  assert.equal(PLAY_PLUGIN, 'NativePurchases');
  const config = JSON.parse(await readFile(new URL('../capacitor.config.json', import.meta.url), 'utf8'));
  assert.equal(PLAY_PACKAGE, config.appId);
});
