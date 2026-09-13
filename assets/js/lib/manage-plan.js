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
    return el('div', { class: 'plan-upgrade' }, [
      button,
      el('p', {
        class: 'hint', style: 'margin:8px 0 0',
        text: 'Cancel, switch between monthly and yearly, or change the card. '
          + 'Cancelling keeps Premium until the period you have paid for runs out.',
      }),
    ]);
  }

  /*
   * Apple's, and only Apple's. Said here rather than left blank because the
   * absence of a button reads as "there is no way to cancel", and the actual
   * answer is that the way out is somewhere this app cannot reach.
   */
  if (summary?.source === 'appstore') {
    return el('p', {
      class: 'hint', style: 'margin:10px 0 0',
      text: 'This subscription is through the App Store. Cancel it in Settings, '
        + 'your name, Subscriptions. It stays active until the period you have paid for runs out.',
    });
  }

  return null;
}
