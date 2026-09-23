/**
 * Landing back on the site with a payment behind you.
 *
 * This used to live in viewer.js, which is why the purchase buttons did too:
 * a checkout is begun somewhere and returned to somewhere, and whoever owned
 * the return owned the offer. That kept the only way to subscribe on the map
 * and left the account page saying "Free" with nothing to press.
 *
 * Nothing in here was ever about a map. It reads a flag off the address bar,
 * asks the account to keep checking, and says which of three things happened.
 * Every page that can start a checkout calls this on load. Why it keeps
 * asking rather than reading once is on the function below; measured against
 * a real test purchase, the gap between landing and the webhook was about
 * five seconds.
 */

import { SITE } from '../config.js';

/**
 * What happens when Stripe sends somebody back after they have paid.
 *
 * Paying and being entitled are not the same instant: the browser comes back
 * the moment the card clears, and the entitlement is written by a webhook that
 * arrives separately. Reading the plan once on landing therefore tells
 * somebody who has just paid that they are on the free tier, which is the
 * worst thing this app could say to them, so it asks again for a while.
 *
 * And it says which of the three things happened - it worked, it has not
 * landed yet, or you are not signed in - because "nothing appears to have
 * changed" is what turns a slow webhook into a support email about a missing
 * charge.
 */
export async function settleCheckoutReturn({ account, toast }) {
  const params = new URLSearchParams(location.search);
  if (params.get('subscribed') !== '1') return false;

  /*
   * Out of the address bar first, before anything can go wrong.
   *
   * It is a one-time flag on a return trip, and a URL is a thing people
   * bookmark and send to each other. Left in place it would congratulate the
   * next person to open the link on a payment they never made, and would do it
   * again on every reload for the person who did.
   */
  params.delete('subscribed');
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);

  /*
   * Signed out on the way back, which happens when the checkout is finished in
   * a different browser from the one it started in. The payment is real and
   * this device simply cannot see whose it is, so say that rather than
   * silently showing a free account.
   */
  if (!account?.user) {
    toast('Your payment went through. Sign in to the account you paid with and Premium will be there.',
      { tone: 'info', timeout: 12000 });
    return false;
  }

  toast('Thank you. Finishing off your subscription…', { tone: 'info', timeout: 6000 });
  /*
   * Waiting for the source rather than the tier. A trial already reads as
   * premium, so waiting on the tier would congratulate every new account on a
   * payment the instant they landed, webhook or no webhook.
   */
  const settled = await account.waitForPlan({ source: 'stripe' });
  if (settled.ok) {
    toast('Premium is active on this account.', { tone: 'ok', timeout: 8000 });
    return true;
  }

  /*
   * The honest ending. A webhook that has not arrived in this many seconds
   * usually still arrives, and occasionally does not - and a person who has
   * been charged needs to be told the second thing is possible and what to do
   * about it, not left refreshing.
   */
  toast(`Your payment went through and this account has not caught up yet. It usually lands `
    + `within a minute — reload then. If it is still not here, write to ${SITE.contactEmail} `
    + `and it will be sorted out by hand.`, { tone: 'error', timeout: 16000 });
  return false;
}
