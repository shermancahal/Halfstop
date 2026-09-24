/**
 * The way out of a subscription, on every page rather than only the map.
 *
 * The help page has always said "Manage subscription in the account menu".
 * That was true on the map and nowhere else, so somebody who opened the gear
 * on the help page - having been sent there by the help page - found a plan
 * name and no button. Reported as exactly that.
 *
 * WHY THIS IS SHARED AND STARTING A SUBSCRIPTION IS NOT
 *
 * page-settings.js declines to offer a checkout off the map, and that reasoning
 * still holds: a checkout is begun and returned to, and the return path - re-
 * reading the plan until the webhook lands - lives in viewer.js. None of that
 * applies here. Managing is one redirect out to Stripe's own pages and back,
 * and the plan is re-read on load by Account.init(), which now runs on every
 * page. There is nothing left for the map to own.
 *
 * It is also not gated on whether billing is live or on the tester preview,
 * unlike the purchase panel. Those gates are about whether we are selling.
 * Somebody who is already paying must be able to stop, and a cancel button
 * that appears only for the right build flag is a cancel button that will one
 * day not appear.
 */

import { el } from './ui.js';
import { BILLING } from '../config.js';

/** The Android app, as Google Play knows it: appId in capacitor.config.json. */
export const PLAY_PACKAGE = 'com.halfstop.app';

/**
 * @param {object}   summary        from planSummary()
 * @param {object}   options
 * @param {object}   options.account an Account
 * @param {Function} options.toast   how this page says things out loud
 * @returns {Node|null} null when there is no subscription to manage
 */
export function managePlanBlock(summary, { account, toast }) {
  if (summary?.source === 'stripe') {
    const button = el('button', {
      class: 'button button-secondary button-small', type: 'button', text: 'Manage subscription',
      onclick: async (event) => {
        const target = event.currentTarget;
        const said = target.textContent;
        // Said on the button rather than only in a toast: this leaves the site,
        // and a button that looks unpressed while a function is answering gets
        // pressed again.
        target.disabled = true;
        target.textContent = 'Opening…';
        const result = await account.openBilling();
        target.disabled = false;
        target.textContent = said;
        if (!result.ok) {
          toast(result.reason, { tone: 'error', timeout: 10000 });
          return;
        }
        window.location.assign(result.url);
      },
    });
    /*
     * The button and nothing else.
     *
     * It used to carry a paragraph explaining that Stripe's pages are where
     * you cancel, switch between monthly and yearly, or change the card - four
     * lines of prose under a button, in a menu somebody opened to change their
     * units. The button says where it goes and Stripe's own page says the
     * rest; the help page carries the long version, under "Cancelling a
     * subscription", which is where somebody reading about it has gone.
     */
    return el('div', { class: 'plan-upgrade' }, [button]);
  }

  /*
   * Apple's, and only Apple's. Said here rather than left blank because the
   * absence of a button reads as "there is no way to cancel", and the actual
   * answer is that the way out is somewhere this app cannot reach.
   */
  if (summary?.source === 'appstore') {
    /*
     * The same button, pointed at Apple.
     *
     * This was a sentence - "Cancel it in Settings, your name, Subscriptions" -
     * written that way because only Apple can end an App Store subscription and
     * there seemed to be nothing for a button to open. There is: Apple
     * publishes a direct link to the subscriptions screen, which opens it on an
     * iPhone or iPad and the account page everywhere else. Three hops of
     * navigation somebody has to follow correctly is worse than one link, and a
     * plan managed one way on the web and another in the app should not look
     * like two different kinds of thing.
     *
     * An anchor rather than a button: this leaves the app, and a link is what
     * the browser, the wrapper and a long-press all already know how to handle.
     */
    return el('div', { class: 'plan-upgrade' }, [
      el('a', {
        class: 'button button-secondary button-small',
        href: 'https://apps.apple.com/account/subscriptions',
        target: '_blank', rel: 'noopener',
        text: 'Manage subscription',
      }),
    ]);
  }

  /*
   * Google Play's, which only Google can end, and which Google gives a direct
   * address for: the subscriptions screen of the Play Store app on Android,
   * and the same list in a browser anywhere else. Named down to the product
   * so it opens on Halfstop rather than on every subscription somebody has.
   */
  if (summary?.source === 'play') {
    const where = new URL('https://play.google.com/store/account/subscriptions');
    where.searchParams.set('sku', BILLING.play.product);
    where.searchParams.set('package', PLAY_PACKAGE);
    return el('div', { class: 'plan-upgrade' }, [
      el('a', {
        class: 'button button-secondary button-small',
        href: where.href,
        target: '_blank', rel: 'noopener',
        text: 'Manage subscription',
      }),
    ]);
  }

  return null;
}
