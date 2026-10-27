/**
 * Buying Premium through the App Store, the phone's half.
 *
 * StoreKit is a fake plugin and the server a stub, so what is under test is
 * what this code asks for and when it lets go: the purchase names the
 * account, nothing about it is believed on the phone, and a transaction is
 * finished only once the server's answer is final. The server's half -
 * asking Apple, refusing somebody else's purchase - is test/appstore-server.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appStoreFailure, appStoreProduct, appStoreProductId, buyOnAppStore, currentSubscription, restoreOnAppStore,
} from '../assets/js/lib/appstore-billing.js';
import { Account } from '../assets/js/lib/account.js';
import { BILLING } from '../assets/js/config.js';

const ME = '4190718c-9134-4af3-bfcb-0f857938cd05';

function storeKit({ bought = { transactionId: '2000001043762129' }, refuse = null, purchases = [] } = {}) {
  const calls = [];
  return {
    calls,
    async purchaseProduct(options) {
      calls.push(['purchaseProduct', options]);
      if (refuse) throw new Error(refuse);
      return bought;
    },
    async finishTransaction(options) { calls.push(['finishTransaction', options]); },
    async restorePurchases() { calls.push(['restorePurchases']); },
    async getPurchases(options) { calls.push(['getPurchases', options]); return { purchases }; },
  };
}

function accountAnswering(result) {
  const sent = [];
  return {
    sent,
    user: { id: ME },
    async confirmAppStorePurchase(body) { sent.push(body); return result; },
  };
}

test('appstore: the product ids are App Store Connect\'s, and the same ones the server checks', async () => {
  assert.equal(appStoreProductId('month'), 'premium.monthly');
  assert.equal(appStoreProductId('year'), 'premium.yearly');
  assert.equal(appStoreProductId('decade'), '');
  const server = await import('node:fs/promises').then((fs) => fs.readFile(
    new URL('../supabase/functions/appstore-billing/index.ts', import.meta.url), 'utf8'));
  assert.ok(server.includes(`'${Object.values(BILLING.appstore.plans).join(',')}'`),
    'appstore-billing defaults to a different pair of product ids');

  const products = [{ identifier: 'premium.yearly', priceString: '$49.00' }, { identifier: 'premium.monthly' }];
  assert.equal(appStoreProduct(products, { planId: 'year' }).priceString, '$49.00');
  assert.equal(appStoreProduct(products, { planId: 'decade' }), null);
});

test('appstore: a purchase names the account, and is finished once the server has it', async () => {
  const plugin = storeKit();
  const account = accountAnswering({ ok: true });
  assert.deepEqual(await buyOnAppStore({ account, planId: 'year', plugin }), { ok: true });

  assert.deepEqual(plugin.calls[0], ['purchaseProduct', {
    productIdentifier: 'premium.yearly',
    appAccountToken: ME,
    autoAcknowledgePurchases: false,
  }]);
  assert.deepEqual(account.sent, [{ transactionId: '2000001043762129' }]);
  assert.deepEqual(plugin.calls[1], ['finishTransaction', { transactionId: '2000001043762129' }]);
});

test('appstore: a server that could not be reached leaves the transaction for StoreKit to offer again', async () => {
  const plugin = storeKit();
  const result = await buyOnAppStore({
    account: accountAnswering({ ok: false, reason: 'The App Store could not be asked just now.', settled: false }),
    planId: 'month', plugin,
  });
  assert.equal(result.ok, false);
  assert.equal(plugin.calls.some(([name]) => name === 'finishTransaction'), false);

  // A final refusal - somebody else's purchase, or one already paid for on
  // the website - is finished: asking again would get the same answer.
  const settled = storeKit();
  const refused = await buyOnAppStore({
    account: accountAnswering({ ok: false, reason: 'belongs to a different Halfstop account', settled: true }),
    planId: 'month', plugin: settled,
  });
  assert.match(refused.reason, /different Halfstop account/);
  assert.equal(settled.calls.some(([name]) => name === 'finishTransaction'), true);
});

test('appstore: closing the sheet is not an error, and nothing is sent', async () => {
  const account = accountAnswering({ ok: true });
  assert.deepEqual(await buyOnAppStore({ account, planId: 'month', plugin: storeKit({ refuse: 'User cancelled' }) }),
    { ok: false, cancelled: true });
  assert.equal(account.sent.length, 0);

  const pending = await buyOnAppStore({ account, planId: 'month', plugin: storeKit({ refuse: 'Transaction pending' }) });
  assert.equal(pending.pending, true);
  assert.match(pending.reason, /turns on by itself/);
});

test('appstore: no account, an old app or no such plan is said, not attempted', async () => {
  assert.match((await buyOnAppStore({ account: { user: null }, planId: 'month', plugin: storeKit() })).reason, /Sign in first/);
  assert.match((await buyOnAppStore({ account: accountAnswering({}), planId: 'month', plugin: {} })).reason, /Update it/);
  const plugin = storeKit();
  assert.equal((await buyOnAppStore({ account: accountAnswering({}), planId: 'decade', plugin })).ok, false);
  assert.equal(plugin.calls.length, 0);
});

test('appstore: what StoreKit says, as a sentence', () => {
  assert.equal(appStoreFailure(new Error('User cancelled')), '');
  assert.match(appStoreFailure(new Error('Cannot find product for id premium.monthly')), /does not have that plan/);
  assert.match(appStoreFailure(new Error('The Internet connection appears to be offline.')), /Could not reach/);
  assert.equal(appStoreFailure(new Error('Unknown error')), 'The App Store did not complete that: Unknown error.');
});

test('appstore: restoring finds this Apple Account\'s current subscription and records it', async () => {
  const purchases = [
    { transactionId: '1', productIdentifier: 'premium.monthly', purchaseDate: '2026-01-01T00:00:00Z', isActive: false },
    { transactionId: '2', productIdentifier: 'premium.yearly', purchaseDate: '2026-06-01T00:00:00Z', isActive: true },
    { transactionId: '3', productIdentifier: 'premium.monthly', purchaseDate: '2026-07-01T00:00:00Z', isActive: true,
      revocationDate: '2026-07-02T00:00:00Z' },
    { transactionId: '4', productIdentifier: 'some.other.app', purchaseDate: '2026-09-01T00:00:00Z', isActive: true },
  ];
  assert.equal(currentSubscription(purchases).transactionId, '2');

  const plugin = storeKit({ purchases });
  const account = accountAnswering({ ok: true });
  assert.deepEqual(await restoreOnAppStore({ account, plugin }), { ok: true });
  assert.deepEqual(plugin.calls.slice(0, 2), [['restorePurchases'], ['getPurchases', { onlyCurrentEntitlements: true }]]);
  assert.deepEqual(account.sent, [{ transactionId: '2' }]);

  const none = await restoreOnAppStore({ account, plugin: storeKit({ purchases: [] }) });
  assert.match(none.reason, /no Halfstop Premium subscription/);
});

test('appstore: the account sends only the transaction id, and reads a refusal as final or not', async () => {
  const invoked = [];
  const answer = { data: { ok: true }, error: null };
  const client = {
    functions: { async invoke(name, options) { invoked.push([name, options]); return answer; } },
    rpc: async () => ({ data: null, error: null }),
  };
  const account = new Account({ list: () => [] }, { client: async () => client, configured: () => true });
  account.user = { id: ME };
  account.refreshPlan = async () => null;

  assert.deepEqual(await account.confirmAppStorePurchase({ transactionId: 2000001043762129 }), { ok: true });
  assert.deepEqual(invoked[0], ['appstore-billing', { body: { transactionId: '2000001043762129' } }]);

  const refusal = (status, error) => Object.assign(new Error('Edge Function returned a non-2xx status code'), {
    context: { status, json: async () => ({ error }) },
  });
  Object.assign(answer, { data: null, error: refusal(409, 'This account already subscribes through the website') });
  assert.deepEqual(await account.confirmAppStorePurchase({ transactionId: '1' }),
    { ok: false, reason: 'This account already subscribes through the website', settled: true });

  Object.assign(answer, { error: refusal(502, 'The App Store could not be asked about that purchase just now.') });
  assert.equal((await account.confirmAppStorePurchase({ transactionId: '1' })).settled, false);
});
