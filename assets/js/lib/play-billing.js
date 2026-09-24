/**
 * Buying Premium through Google Play, from inside the Android app.
 *
 * WHAT THE APP IS TRUSTED WITH: NOTHING
 *
 * The phone runs the purchase and gets back a purchase token. It does not
 * decide that anybody is Premium - it hands the token to the play-billing
 * function, which asks Google directly, with a service account this app never
 * sees, what that token bought, for whom, and until when. A modified app that
 * claimed a purchase would be claiming it to a server that checks.
 *
 * WHO IT IS FOR IS WRITTEN INTO THE PURCHASE
 *
 * The signed-in account's id goes to Google as the purchase's obfuscated
 * account id, and comes back on the subscription when the server asks about
 * it. That is what stops a purchase token - which is not a secret to the
 * person who bought it - being presented by a second account to get Premium
 * twice for one payment. It is an opaque UUID, not an address, which is what
 * Google asks for there.
 *
 * NOT ACKNOWLEDGED HERE
 *
 * Google refunds a purchase nobody acknowledges within three days. Letting the
 * plugin acknowledge on the phone would make that true only of purchases the
 * phone never finished, where the useful version is purchases the server never
 * recorded - so the server acknowledges, after it has written the row, and a
 * payment Halfstop failed to honour is returned by Google without anybody
 * having to notice.
 */

import { BILLING } from '../config.js';
import { annualSaving } from './tiers.js';

/** What Capacitor calls @capgo/native-purchases on window.Capacitor.Plugins. */
export const PLAY_PLUGIN = 'NativePurchases';

/**
 * The offer to buy for one of our plans, out of what Play returned.
 *
 * Play answers with one entry per offer, and a base plan can carry
 * promotional offers beside its own. The base plan's own offer is the one
 * with no offer id, and it is preferred: nothing here has decided to give a
 * discount, and one appearing because it happened to be listed first would be
 * a price nobody chose.
 *
 * Checked here rather than left to the plugin, which falls back to the first
 * offer it finds when the named plan is missing - so a yearly plan not yet
 * created in Play Console would have sold the monthly one under a button
 * saying "a year".
 */
export function playOffer(products, { planId, billing = BILLING } = {}) {
  const product = billing.play?.product;
  const basePlan = billing.play?.plans?.[planId];
  if (!product || !basePlan) return null;
  const matching = (Array.isArray(products) ? products : [])
    .filter((entry) => entry?.identifier === product && entry?.planIdentifier === basePlan);
  return matching.find((entry) => !entry.offerId) || matching[0] || null;
}

/** Every offer Play has for the product, or throws what Play said. */
export async function playOffers(plugin, { billing = BILLING } = {}) {
  const answer = await plugin.getProducts({ productIdentifiers: [billing.play.product], productType: 'subs' });
  return Array.isArray(answer?.products) ? answer.products : [];
}

/**
 * The price to put on a button, in Play's words.
 *
 * Play sets the price in every country and draws it on the purchase sheet,
 * and that sheet is what somebody agrees to. A button saying $4.99 over a
 * sheet saying 5,49 EUR is a small untruth at the moment money changes hands,
 * so once Play has answered the buttons say what it says.
 */
export function playPriceLabel(offer, { planId, billing = BILLING } = {}) {
  const price = String(offer?.priceString || '').trim();
  if (!price) return '';
  const period = billing.plans?.[planId]?.period || planId;
  return `${price} a ${period}`;
}

/**
 * What paying by the year saves, in the currency Play is charging.
 *
 * Worked out the same way the website does it, from the two prices rather
 * than asserted - but from Play's prices, because in most of the world they
 * are not ours converted: Play rounds each country to a local price point, and
 * the saving somebody sees has to be the one they get.
 */
export function playSaving(month, year, { locale } = {}) {
  const monthly = Number(month?.price);
  const yearly = Number(year?.price);
  const currency = String(month?.currencyCode || '');
  if (!currency || currency !== String(year?.currencyCode || '')) return null;
  const saving = annualSaving({
    billing: { plans: { month: { price: Math.round(monthly * 100) }, year: { price: Math.round(yearly * 100) } } },
  });
  if (!saving) return null;
  let money;
  try {
    money = new Intl.NumberFormat(locale, { style: 'currency', currency }).format(saving.cents / 100);
  } catch {
    return null;
  }
  return { money, percent: saving.percent };
}

/**
 * Why a purchase ended without one, as a sentence - or '' for somebody who
 * simply changed their mind.
 *
 * Closing Google's sheet is not an error and must not be answered with one.
 * The plugin reports it as a rejection like any other, with USER_CANCELED as
 * the code, so it is picked out before anything is said.
 */
export function purchaseFailure(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || error || '');
  const said = `${code} ${message}`;
  if (/USER_CANCEL/i.test(said)) return '';
  if (/pending/i.test(said)) {
    return 'Google Play is waiting for that payment to go through. Premium turns on by itself when it does.';
  }
  if (/ITEM_ALREADY_OWNED/i.test(said)) {
    return 'This Google account already subscribes to Halfstop Premium. If this Halfstop account does not show it, '
      + 'sign in with the account you subscribed from.';
  }
  if (/BILLING_UNAVAILABLE|not available on this device|FEATURE_NOT_SUPPORTED/i.test(said)) {
    return 'Google Play cannot take payments on this device. Check the Play Store is installed and signed in.';
  }
  if (/Product not found|ITEM_UNAVAILABLE|No subscription offers/i.test(said)) {
    return 'Google Play does not have that plan to sell yet.';
  }
  if (/SERVICE_|NETWORK_ERROR|disconnected/i.test(said)) {
    return 'Could not reach Google Play. Check the connection and try again.';
  }
  return `Google Play did not complete that: ${message || code || 'no reason given'}.`;
}

/**
 * Buy one of our plans through Google Play, and have the server record it.
 *
 * @param {object} options
 * @param {object} options.account  an Account, signed in
 * @param {string} options.planId   'month' or 'year'
 * @param {object} options.plugin   window.Capacitor.Plugins.NativePurchases
 * @returns {Promise<{ok: boolean, reason?: string, cancelled?: boolean, pending?: boolean}>}
 */
export async function buyOnPlay({ account, planId, plugin, billing = BILLING } = {}) {
  if (!account?.user?.id) return { ok: false, reason: 'Sign in first, so the subscription is on your account.' };
  if (!plugin?.purchaseProduct || !plugin?.getProducts) {
    return { ok: false, reason: 'This version of the app cannot take payments. Update it from Google Play.' };
  }

  let offer;
  try {
    offer = playOffer(await playOffers(plugin, { billing }), { planId, billing });
  } catch (error) {
    return { ok: false, reason: purchaseFailure(error) || 'Google Play did not answer. Try again.' };
  }
  if (!offer) {
    const period = billing.plans?.[planId]?.period || planId;
    return { ok: false, reason: `Google Play does not have the ${period}ly plan to sell yet.` };
  }

  let bought;
  try {
    bought = await plugin.purchaseProduct({
      productIdentifier: billing.play.product,
      productType: 'subs',
      planIdentifier: offer.planIdentifier,
      ...(offer.offerToken ? { offerToken: offer.offerToken } : {}),
      appAccountToken: account.user.id,
      autoAcknowledgePurchases: false,
    });
  } catch (error) {
    const reason = purchaseFailure(error);
    if (!reason) return { ok: false, cancelled: true };
    return { ok: false, reason, pending: /pending/i.test(String(error?.message || error)) };
  }

  if (!bought?.purchaseToken) {
    return {
      ok: false,
      reason: 'Google Play finished without a purchase to record. If you were charged, Premium turns on by itself shortly.',
    };
  }
  return account.confirmPlayPurchase({ purchaseToken: bought.purchaseToken });
}
