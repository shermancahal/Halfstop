/**
 * What Premium is, what it costs, and the buttons that start one.
 *
 * WHY THIS IS NO LONGER ONLY ON THE MAP
 *
 * It lived in viewer.js, and page-settings.js said why: "a checkout is begun
 * and returned to on the map, and the return path - reading the plan again
 * until the webhook lands - lives there." That was true, and it meant the
 * account page - the page called "Your account", with a heading that says
 * "Plan" - showed the word "Free" and no way to stop being on it. Reported as
 * exactly that: "where does one go to upgrade?"
 *
 * The return path moved out too, into ./checkout-return.js, so the reason has
 * gone with it. This is the same move manage-plan.js made for the cancel
 * button, for the same reason: the help page had always pointed at a control
 * that existed on one page out of eight.
 *
 * WHAT IS STILL NOT HERE
 *
 * Any decision about who may buy. `canPreviewBilling` decides whether a button
 * is drawn before billing is live, and it runs on the reader's computer where
 * they can change it. What actually refuses a checkout is BILLING_TESTERS in
 * the stripe-checkout function, read against the address on a verified token.
 */

import { el } from './ui.js';
import { mayEdit } from './editors.js';
import { managePlanBlock } from './manage-plan.js';
import { appShell } from './native-shell.js';
import { PLAY_PLUGIN, buyOnPlay, playOffer, playOffers, playPriceLabel, playSaving } from './play-billing.js';
import { BILLING } from '../config.js';
import {
  offersUpgrade, purchaseRoute, annualSaving, plansOffered, describePrice,
  premiumAdds, isBillingTester, TRIAL_DAYS,
} from './tiers.js';

/**
 * Whether this account reaches a checkout before billing is live.
 *
 * One function because two copies of this went wrong immediately: the panel
 * knew about the preview and the button's handler did not, so a tester was
 * shown two prices and told "There is nothing to subscribe to yet" when they
 * pressed one. A drawn control that refuses itself is worse than no control.
 *
 * Presentation, and only that. The checkout function refuses anybody not named
 * on its own list while the Stripe key is a test key, and that is the control -
 * this runs on the reader's computer, where they can change it.
 */
export function canPreviewBilling(user) {
  return !BILLING.live && (isBillingTester(user) || mayEdit(user));
}

/**
 * Begin a subscription: open a Stripe Checkout and hand the browser over.
 *
 * This is the one seam where a purchase plugs in, and it stayed empty for a
 * while on purpose - the last time this app grew a button whose handler had
 * not been written, the handler was simply missing and every press threw a
 * ReferenceError that no test caught, because the tests covered the module
 * around it and nothing ever pressed the button. An honest refusal was better
 * than that.
 *
 * It is Stripe now, and when StoreKit arrives it becomes a second branch on
 * `route.where` rather than a rewrite: the panel already asks where a purchase
 * can be completed instead of assuming, because a browser cannot finish an App
 * Store one. Nothing about a card is ever typed into this app.
 */
async function startSubscription(account, toast, button = null, plan = 'month') {
  const route = purchaseRoute({ preview: canPreviewBilling(account?.user) });
  if (!route.available) {
    toast('There is nothing to subscribe to yet.', { tone: 'info', timeout: 7000 });
    return false;
  }

  if (route.where === 'play') return startPlaySubscription(account, toast, button, plan);

  if (route.where !== 'stripe') {
    // Only reachable if another route is added and this is not taught about
    // it. Said out loud rather than falling through to a silent return.
    toast('This build does not know how to open that checkout.', { tone: 'error', timeout: 9000 });
    return false;
  }

  /*
   * Disabled while the round trip is in flight.
   *
   * Creating a checkout is a network call that takes a moment, and a payment
   * button that looks idle is a payment button somebody presses twice. The
   * function is idempotent within the hour for the same person, so a second
   * press cannot make a second subscription - this is so it does not look
   * broken in the meantime.
   */
  const said = button?.textContent || 'Subscribe';
  if (button) { button.disabled = true; button.textContent = 'Opening…'; }
  const result = await account.startCheckout({ plan });
  if (button) { button.disabled = false; button.textContent = said; }

  if (!result.ok) {
    toast(result.reason, { tone: 'error', timeout: 9000 });
    return false;
  }

  // Stripe's own page, on Stripe's domain. Nothing about a card is typed into
  // this app, which is the whole reason for sending people there.
  window.location.assign(result.url);
  return true;
}

/**
 * The same, through Google Play, in the Android app.
 *
 * Google draws the purchase sheet and takes the payment; the server asks
 * Google what was bought before anything is recorded. See ./play-billing.js.
 * Closing the sheet is somebody changing their mind, and gets no message.
 */
async function startPlaySubscription(account, toast, button, plan) {
  const said = button?.textContent || 'Subscribe';
  if (button) { button.disabled = true; button.textContent = 'Opening Google Play…'; }
  const result = await buyOnPlay({ account, planId: plan, plugin: appShell().plugin(PLAY_PLUGIN) });
  if (button?.isConnected) { button.disabled = false; button.textContent = said; }

  if (result.cancelled) return false;
  if (!result.ok) {
    toast(result.reason, { tone: result.pending ? 'info' : 'error', timeout: 12000 });
    return false;
  }
  toast('Premium is active on this account.', { tone: 'ok', timeout: 8000 });
  return true;
}

/**
 * Put Google Play's prices on the buttons, once it says what they are.
 *
 * The buttons are drawn at once with the prices in config, so the panel is
 * never empty while Play is asked; then relabelled with Play's own figure for
 * this country, which is the one on the sheet somebody agrees to. If Play
 * does not answer, the buttons keep the list price and the sheet still shows
 * the real one before anybody pays.
 */
async function showPlayPrices(buttons, saving) {
  const plugin = appShell().plugin(PLAY_PLUGIN);
  if (!plugin?.getProducts) return;
  let offers;
  try {
    offers = await playOffers(plugin);
  } catch {
    return;
  }
  const found = {};
  for (const button of buttons) {
    const planId = button.dataset.plan;
    if (!planId) continue;
    found[planId] = playOffer(offers, { planId });
    const label = playPriceLabel(found[planId], { planId });
    if (label) button.textContent = label;
  }
  const saved = playSaving(found.month, found.year);
  if (saving && saved) {
    saving.textContent = `Paying by the year saves ${saved.money}, about ${saved.percent}%.`;
    saving.hidden = false;
  }
}

/**
 * Take the free month.
 *
 * Nothing about the length or the dates is sent: public.start_trial() decides
 * those, because a browser that could name its own expiry would name one a
 * long way off. This only presses the button and says what came back.
 */
async function startTrial(account, toast, button = null) {
  const said = button?.textContent || 'Start the free trial';
  if (button) { button.disabled = true; button.textContent = 'Starting…'; }
  const result = await account.startTrial();

  if (!result.ok) {
    // Put the button back, because nothing else will: a refusal changes no
    // plan, so the panel it is sitting in is not redrawn.
    if (button) { button.disabled = false; button.textContent = said; }
    toast(result.reason, { tone: 'error', timeout: 9000 });
    return false;
  }

  /*
   * Nothing puts the button back on the way out, and that is right: the plan
   * changed, so the account's change listener has already repainted the menu
   * and this button is no longer in the document. What replaced it is the
   * panel for somebody who now has Premium.
   */
  toast(`Premium is on for the next ${TRIAL_DAYS} days. Nothing to cancel — it simply runs out.`,
    { tone: 'ok', timeout: 9000 });
  return true;
}

/**
 * What Premium is and how to get it, for somebody who has not got it.
 *
 * Nothing at all while BILLING.live is false, which is today: every account
 * has everything, so a panel offering to sell it would be describing a
 * restriction that does not exist.
 *
 * When it is live, this says what changes and what it costs, and then tells
 * the truth about whether it can be bought from here. A subscription lives in
 * the App Store and the App Store only exists inside a shipped app, so the
 * browser has nothing to sell and should say so rather than showing a button
 * that cannot work. That is a state to draw, not a state to hide.
 */
export function upgradePlanBlock(plan, { account, toast }) {
  /*
   * Whoever runs this can see the purchase panel before billing is live, so a
   * checkout can be tested with a card that is not a card.
   *
   * Presentation only, and worth being clear about: the checkout function
   * refuses anybody not named as a tester while the Stripe key is a test key.
   * That is the control. This just means the button is there to press.
   */
  /*
   * Somebody who already subscribes gets the way out, not another offer - and
   * gets it before any gate, because the gates below are about whether we are
   * selling. Cancelling has to be as easy as subscribing and must not depend
   * on a build flag.
   *
   * Shared with every other page now: the help page has always said "Manage
   * subscription in the account menu", which was true here and nowhere else.
   */
  if (!offersUpgrade({ ...plan, live: true })) {
    return managePlanBlock(plan, { account, toast });
  }

  const preview = canPreviewBilling(account?.user);
  if (!plan.live && !preview) return null;

  const route = purchaseRoute({ preview });
  const saving = annualSaving();

  /*
   * The free month, offered rather than assumed.
   *
   * Everybody who signed up used to be inside a trial whether they wanted one
   * or not, because it was worked out from the day the account was made. That
   * gave Premium to people who had come to look at a map, put a clock on their
   * account that they had never started, and - the part that actually broke -
   * left nothing to opt into. Now it is a row, and this button is what writes
   * it.
   *
   * Drawn only when the server says this account may still have one. The
   * client does not work that out: `trialAvailable` comes from my_plan(),
   * which holds the record of whether the month has already been spent. A
   * button drawn on a guess is a button whose only outcome is an error.
   */
  const offerTrial = plan.trialAvailable && route.available;

  /*
   * Somebody on a trial is being asked to keep what they already have, not
   * sold something new, and the sentence has to say which.
   */
  const trialing = plan.source === 'trial';
  const heading = trialing && plan.line
    ? `${plan.line.replace(/\.$/, '')}. Keeping it:`
    : 'Premium adds';

  /*
   * A button per plan rather than a toggle and one button.
   *
   * Two buttons say both prices at once, which is the question somebody
   * actually has. A toggle hides one of the two numbers behind an interaction
   * and makes the reader work to compare them, in a menu that is already
   * small.
   */
  const buttons = plansOffered().map((plan) => el('button', {
    /*
     * The month is the primary button, unless there is a trial to take -
     * then that is, and both prices step back to being the other option.
     * Two primary buttons side by side is two things claiming to be the
     * obvious one, which is the same as neither being it.
     */
    class: `button button-small ${!offerTrial && plan.id === 'month' ? 'button-primary' : 'button-secondary'}`,
    type: 'button',
    'data-plan': plan.id,
    text: describePrice({ plan: plan.id }),
    onclick: (event) => startSubscription(account, toast, event.currentTarget, plan.id),
  }));

  if (offerTrial) {
    buttons.unshift(el('button', {
      class: 'button button-small button-primary',
      type: 'button',
      text: `Try it free for ${TRIAL_DAYS} days`,
      onclick: (event) => startTrial(account, toast, event.currentTarget),
    }));
  }

  /*
   * The saving, worked out from the prices on the buttons. In a browser those
   * are ours, in dollars. Through Google Play they are Play's, in whatever
   * currency it charges here, and not known until it answers - so the line
   * waits for them rather than stating a dollar saving over euro prices.
   */
  const playing = route.where === 'play';
  const savingLine = route.available && saving
    ? el('p', {
      class: 'hint', style: 'margin:8px 0 0',
      text: playing ? '' : `Paying by the year saves ${saving.money}, about ${saving.percent}%.`,
    })
    : null;
  if (savingLine && playing) savingLine.hidden = true;
  if (playing) showPlayPrices(buttons, savingLine);

  return el('div', { class: 'plan-upgrade' }, [
    el('p', { class: 'plan-upgrade-head', text: heading }),
    // The list is what a trial is holding open, so it is worth repeating for
    // somebody deciding whether to keep it.
    el('ul', { class: 'plan-upgrade-list' }, premiumAdds().map((what) => el('li', { text: what }))),
    route.available
      ? el('div', { class: 'plan-upgrade-buttons' }, buttons)
      : el('p', {
        class: 'hint', style: 'margin:8px 0 0',
        text: route.why === 'in-app-only'
          ? 'Subscriptions are handled by the App Store, so this is in the '
            + 'iPhone and iPad app rather than here.'
          : 'There is no way to subscribe yet.',
      }),
    /*
     * The three things somebody weighing up a free trial wants to know, before
     * they press it rather than after.
     *
     * No card is the one that matters: the commonest reason not to start a
     * free trial is the suspicion that it is a subscription with a delay on
     * it. This one is not - there is nothing to cancel, because nothing was
     * started that continues.
     */
    offerTrial
      ? el('p', {
        class: 'hint', style: 'margin:8px 0 0',
        text: 'No card, nothing to cancel, and it stops on its own. One to an account.',
      })
      : null,
    // Worked out from the two prices rather than written down, so it cannot
    // overstate the discount or go stale when one of them moves.
    savingLine,
    // Said plainly, because a preview that looks like the real thing is how
    // somebody ends up wondering whether they were charged.
    route.preview
      ? el('p', {
        class: 'hint plan-preview', style: 'margin:8px 0 0',
        /*
         * Not the same promise in both places. A Stripe preview runs against
         * test keys, where no card is real. Google Play has no test keys:
         * whether a card is charged depends on whether this Google account is
         * a licence tester in Play Console, which nothing here can see - so
         * it says where to check rather than promising.
         */
        text: playing
          ? 'Test mode. Billing is not live: this is here because you run Halfstop. Google Play charges '
            + 'nothing only for accounts listed as licence testers in Play Console.'
          : 'Test mode. Billing is not live: this is here because you run '
            + 'Halfstop, and no real card is charged.',
      })
      : null,
  ].filter(Boolean));
}
