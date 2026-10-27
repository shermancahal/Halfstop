/**
 * Buying Premium through the App Store, from inside the iPhone app.
 *
 * The twin of ./play-billing.js, on the same rule: the phone runs the purchase
 * and the server decides. StoreKit hands back a transaction id, and the
 * appstore-billing function asks Apple's App Store Server API what that
 * transaction is - whose, which product, until when - with a key this app
 * never holds. A modified app that claimed a purchase would be claiming it to
 * a server that checks.
 *
 * WHO IT IS FOR IS WRITTEN INTO THE PURCHASE
 *
 * The account id goes to Apple as the purchase's appAccountToken - it is
 * already a UUID, which is the one shape StoreKit accepts there - and Apple
 * returns it on every answer about the subscription. The server refuses a
 * transaction that names a different account.
 *
 * FINISHED ONCE THE ANSWER IS FINAL
 *
 * StoreKit keeps delivering a transaction until the app finishes it. So it is
 * finished when the server has recorded it, or refused it for a reason asking
 * again would not change, and left alone when the server could not be
 * reached. Apple's own notification to the server records it either way; an
 * unfinished transaction is only one StoreKit offers again later.
 *
 * Same plugin as Google Play: @capgo/native-purchases is StoreKit 2 on iOS.
 */

import { BILLING, SITE } from '../config.js';
import { PLAY_PLUGIN, playPriceLabel, playSaving } from './play-billing.js';

/** The plugin on window.Capacitor.Plugins - the one Google Play uses. */
export const APPSTORE_PLUGIN = PLAY_PLUGIN;

/*
 * Where somebody reads the terms and the privacy policy before subscribing,
 * which Apple asks to be one tap from the purchase. The website's copies, so
 * they open in Safari rather than in the app, and are always the current text.
 */
export const TERMS_URL = new URL('terms.html', SITE.url).href;
export const PRIVACY_URL = new URL('privacy.html', SITE.url).href;

/** The App Store product id for one of our plans, or ''. */
export function appStoreProductId(planId, { billing = BILLING } = {}) {
  return String(billing.appstore?.plans?.[planId] || '');
}

/** The product StoreKit returned for one of our plans, or null. */
export function appStoreProduct(products, { planId, billing = BILLING } = {}) {
  const id = appStoreProductId(planId, { billing });
  if (!id) return null;
  return (Array.isArray(products) ? products : []).find((entry) => entry?.identifier === id) || null;
}

/** Both plans' products, or throws what StoreKit said. */
export async function appStoreProducts(plugin, { billing = BILLING } = {}) {
  const productIdentifiers = Object.values(billing.appstore?.plans || {}).filter(Boolean);
  const answer = await plugin.getProducts({ productIdentifiers });
  return Array.isArray(answer?.products) ? answer.products : [];
}

/*
 * Play's two price helpers read nothing of Play's: a price string, a number
 * and a currency, which StoreKit's products carry under the same names. The
 * App Store sets each country's price and draws it on the sheet somebody
 * agrees to, so the buttons say what it says.
 */
export const appStorePriceLabel = playPriceLabel;
export const appStoreSaving = playSaving;

/**
 * Why a purchase ended without one, as a sentence - or '' for somebody who
 * closed Apple's sheet, which is not an error and gets no message.
 */
export function appStoreFailure(error) {
  const message = String(error?.message || error || '');
  if (/user cancel/i.test(message)) return '';
  if (/pending/i.test(message)) {
    return 'The App Store is waiting for that purchase to be approved. Premium turns on by itself when it is.';
  }
  if (/Cannot find product|Product not found/i.test(message)) {
    return 'The App Store does not have that plan to sell yet.';
  }
  if (/network|internet|offline|connection/i.test(message)) {
    return 'Could not reach the App Store. Check the connection and try again.';
  }
  return `The App Store did not complete that: ${message || 'no reason given'}.`;
}

/**
 * The subscription to restore, out of what StoreKit holds for this Apple
 * Account: ours, current, and the newest if there are two.
 */
export function currentSubscription(purchases, { billing = BILLING } = {}) {
  const ours = new Set(Object.values(billing.appstore?.plans || {}).filter(Boolean));
  return (Array.isArray(purchases) ? purchases : [])
    .filter((entry) => entry?.transactionId && ours.has(entry.productIdentifier)
      && entry.isActive !== false && !entry.revocationDate)
    .sort((a, b) => (Date.parse(b.purchaseDate) || 0) - (Date.parse(a.purchaseDate) || 0))[0] || null;
}

/** Record a transaction, and finish it once the answer will not change. */
async function record(account, plugin, transactionId) {
  const result = await account.confirmAppStorePurchase({ transactionId });
  if (result.ok || result.settled) {
    try {
      await plugin.finishTransaction?.({ transactionId: String(transactionId) });
    } catch (error) {
      // Recorded is what matters; StoreKit offers it again and it is finished then.
      console.warn('[appstore] could not finish a transaction:', error?.message || error);
    }
  }
  return result;
}

/**
 * Buy one of our plans through the App Store, and have the server record it.
 *
 * @param {object} options
 * @param {object} options.account  an Account, signed in
 * @param {string} options.planId   'month' or 'year'
 * @param {object} options.plugin   window.Capacitor.Plugins.NativePurchases
 * @returns {Promise<{ok: boolean, reason?: string, cancelled?: boolean, pending?: boolean}>}
 */
export async function buyOnAppStore({ account, planId, plugin, billing = BILLING } = {}) {
  if (!account?.user?.id) return { ok: false, reason: 'Sign in first, so the subscription is on your account.' };
  if (!plugin?.purchaseProduct) {
    return { ok: false, reason: 'This version of the app cannot take payments. Update it from the App Store.' };
  }
  const productIdentifier = appStoreProductId(planId, { billing });
  if (!productIdentifier) return { ok: false, reason: 'There is no such plan to buy.' };

  let bought;
  try {
    bought = await plugin.purchaseProduct({
      productIdentifier,
      appAccountToken: account.user.id,
      autoAcknowledgePurchases: false,
    });
  } catch (error) {
    const reason = appStoreFailure(error);
    if (!reason) return { ok: false, cancelled: true };
    return { ok: false, reason, pending: /pending/i.test(String(error?.message || error)) };
  }

  if (!bought?.transactionId) {
    return {
      ok: false,
      reason: 'The App Store finished without a purchase to record. If you were charged, Premium turns on by itself shortly.',
    };
  }
  return record(account, plugin, bought.transactionId);
}

/**
 * Restore Purchases: find this Apple Account's subscription and record it on
 * the signed-in Halfstop account.
 *
 * Apple asks every app that sells a subscription for this button. It matters
 * here mostly after a reinstall or on a new iPhone, where the subscription is
 * Apple's to know about and the account's to be told.
 */
export async function restoreOnAppStore({ account, plugin, billing = BILLING } = {}) {
  if (!account?.user?.id) return { ok: false, reason: 'Sign in first, so the subscription is restored to your account.' };
  if (!plugin?.restorePurchases || !plugin?.getPurchases) {
    return { ok: false, reason: 'This version of the app cannot restore purchases. Update it from the App Store.' };
  }

  let purchases;
  try {
    await plugin.restorePurchases();
    // Scoped to the Apple Account signed in on this phone, not every
    // transaction this device has ever seen.
    purchases = (await plugin.getPurchases({ onlyCurrentEntitlements: true }))?.purchases;
  } catch (error) {
    const reason = appStoreFailure(error);
    if (!reason) return { ok: false, cancelled: true };
    return { ok: false, reason };
  }

  const subscription = currentSubscription(purchases, { billing });
  if (!subscription) {
    return { ok: false, reason: 'This Apple Account has no Halfstop Premium subscription to restore.' };
  }
  return record(account, plugin, subscription.transactionId);
}
