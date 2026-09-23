/**
 * The account, on a page of its own.
 *
 * It used to live entirely inside the gear, which is a dropdown about three
 * hundred and forty pixels wide holding three settings rows. Everything about
 * an account had to fit in there beside them: the profile, the password, the
 * plan, the way out of a subscription. It did not. "Edit profile" was cut to
 * "Edit" because the longer label clipped, and closing an account was moved
 * out to the help page.
 *
 * WHY A PAGE AND NOT A BIGGER MENU
 *
 * Because of the address. Four things this app sends by email come back as a
 * link - a signup confirmation, a magic link, a password reset, an email
 * change - and they used to return to whatever page was open when the button
 * was pressed. That is a destination nobody chose: the reset link asked for on
 * the homepage came back to the homepage, which forwards auth fragments to the
 * map, which is how a working reset link ended up looking broken. A page has
 * one address, it is in the allow list, and it is built to do this.
 *
 * The gear keeps signing in, because signing in on the map is what starts the
 * folder sync and sending somebody away from the map to do the most common
 * thing would be a worse menu, not a better one.
 */

import { el } from './ui.js';
import { planSummary } from './tiers.js';
import { Account } from './account.js';
import { NO_FOLDERS } from './page-settings.js';
import { createAccountPanel } from './account-panel.js';
import { upgradePlanBlock } from './upgrade-plan.js';

/**
 * @param {object}   options
 * @param {Node}     options.container where the page keeps it
 * @param {Function} options.toast     how this page says things out loud
 * @param {object}   [options.account] an existing Account, if the page has one
 * @returns {{account: object, panel: object, render: Function}}
 */
export function mountAccountPage({ container, toast, account = null }) {
  const ours = !account;
  const who = account || new Account(NO_FOLDERS, { syncs: false });

  const heading = el('h2', { text: 'Sign in' });
  const panel = createAccountPanel({
    /*
     * No id on this one. The gear's panel is #account-panel on every page,
     * this page included, and two of them would be a duplicate id - which is
     * invalid, and resolves to whichever comes first in the document. That is
     * the header, so every selector meant for this page silently read the
     * compact card in the menu above it instead.
     */
    container: el('div', { class: 'account-full', role: 'group', 'aria-label': 'Account' }),
    account: who,
    // No folder store on this page: hydrating one would pull IndexedDB, the
    // photo vault and the sync loop onto a page that shows a form. The map
    // syncs, and it does it whether or not anybody is looking at this.
    folders: null,
    toast,
  });

  const plan = el('section', { class: 'legal-section account-plan' });
  const closing = el('section', { class: 'legal-section' });

  container.replaceChildren(
    el('section', { class: 'legal-section' }, [heading, panel.element]),
    plan,
    closing,
  );

  /** The plan, and the way out of it - which is a redirect, not a checkout. */
  function paintPlan() {
    /*
     * Nothing but the form while a recovery is in hand.
     *
     * Somebody who followed a reset link came for one thing, and the panel
     * already puts every other control away for the same reason. A plan name
     * and a way to close the account under the password field would be the
     * page undoing that decision one section lower.
     */
    const signedIn = Boolean(who.user) && !who.recovering;
    heading.textContent = who.recovering ? 'Choose a new password' : (who.user ? 'You' : 'Sign in');
    plan.hidden = !signedIn;
    closing.hidden = !signedIn;
    if (!signedIn) {
      plan.replaceChildren();
      closing.replaceChildren();
      return;
    }

    const summary = planSummary(who);
    plan.replaceChildren(...[
      el('h2', { text: 'Plan' }),
      el('div', { class: 'plan-name', text: summary.name }),
      /*
       * Buying as well as managing, which it did not used to do.
       *
       * This said "Plan / Free" and stopped, on the page called Your account,
       * under a heading that says Plan. The way to subscribe was in the gear
       * on the map and nowhere else, so the answer to "where do I upgrade"
       * was a menu on a different page. Asked exactly that way.
       *
       * The old reason was that a checkout is begun and returned to on the
       * map. It is not any more - lib/checkout-return.js finishes one
       * wherever it lands, and account.js calls it on this page too.
       *
       * upgradePlanBlock falls back to the manage button by itself for
       * somebody who already subscribes, so there is one control here rather
       * than a branch about which to draw.
       */
      upgradePlanBlock(summary, { account: who, toast }),
    ].filter(Boolean));

    /*
     * Closing the account is a link, not a button, and that is deliberate.
     *
     * It sits behind the help page because it is the one thing in this app
     * that cannot be undone and it does not belong a tap away from Sign out.
     * Moving the rest of the account onto a page did not change that, so what
     * is here is a signpost - which Apple's requirement is satisfied by, since
     * the button itself is two taps away and inside the app.
     */
    closing.replaceChildren(
      el('h2', { text: 'Closing your account' }),
      el('p', { class: 'hint' }, [
        document.createTextNode('This cannot be undone, so it is kept behind an explanation. '),
        el('a', { href: 'faq.html#close-account', text: 'Read what it removes and close the account' }),
        document.createTextNode('.'),
      ]),
    );
  }

  /*
   * Redraw on every account change.
   *
   * No menu to open here and nothing to unfold: the panel is the page, so a
   * recovery link that lands on this address puts the new-password form in
   * front of somebody by simply rendering. That is the point of the page.
   */
  who.addEventListener('change', () => {
    panel.render();
    paintPlan();
    /*
     * A link that did not work still has to be said out loud. The explanation
     * renders inside the panel, which is visible here - but somebody who has
     * just followed a link from an inbox is looking at the top of a page, and
     * the sentence that matters can be below the fold on a phone.
     */
    if (who.linkFailed) {
      who.linkFailed = false;
      if (who.message) toast(who.message, { tone: 'error', timeout: 20000 });
    }
  });

  panel.render();
  paintPlan();

  // Nothing above works until this runs: init() restores the session, reads
  // the plan, decides the provider buttons and subscribes to auth changes.
  if (ours) {
    who.init().catch((error) => {
      toast?.(error?.message || 'The account service did not start.', { tone: 'error' });
    });
  }

  return { account: who, panel, render: paintPlan };
}
