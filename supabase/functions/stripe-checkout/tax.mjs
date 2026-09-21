/**
 * The tax a Checkout Session is asked to work out, or none at all.
 *
 * WHY THIS IS A SWITCH AND NOT JUST ON
 *
 * Selling a digital subscription to somebody in the EU means VAT at their own
 * country's rate, from the first euro - the threshold that lets small sellers
 * off applies only to businesses established in the EU, and this one is not.
 * Stripe Tax can work that out per customer, but only if the Session asks it
 * to: turning Stripe Tax on in the dashboard changes nothing about a call that
 * does not send `automatic_tax[enabled]`.
 *
 * It cannot simply be sent always, because Stripe refuses a Session whose
 * price has no `tax_behavior` - a setting that lives on the price, is not set
 * by default, and cannot be changed once it is. So there is a window, between
 * this code shipping and the dashboard being finished, in which sending it
 * would turn every checkout into a 502. The switch is that window held open:
 * the code is inert until `STRIPE_AUTOMATIC_TAX` says otherwise, and flipping
 * it is a secret in Supabase rather than a deploy.
 *
 * WHY ALL THREE TOGETHER
 *
 * They are one setting with three names, and any two without the third is a
 * half-configuration that looks like it works:
 *
 *   - `automatic_tax` is the calculation.
 *   - `billing_address_collection` is what the calculation runs on. Stripe
 *     has to place the customer in a country to know the rate, and for a
 *     digital service the address is the evidence that they were placed
 *     correctly. Without it Checkout asks for an address only when the payment
 *     method happens to need one.
 *   - `tax_id_collection` is the business case. An EU company that cannot
 *     enter its VAT number is charged VAT it then has to claim back, when the
 *     reverse charge would have meant not charging it at all.
 *
 * Pure and in its own file for the same reason returns.mjs is: the interesting
 * part is a decision about a handful of strings, and it is testable here
 * rather than through a deployed function that also wants Stripe, Supabase and
 * a signed-in caller.
 */

/**
 * The values that mean yes.
 *
 * A small closed list rather than "anything that is not empty". These arrive
 * from a dashboard field somebody typed into, and `STRIPE_AUTOMATIC_TAX=false`
 * meaning true would be an unpleasant way to find out.
 */
const YES = new Set(['true', '1', 'yes', 'on']);

/**
 * Whether the switch is on.
 *
 * Unset is off, which is what lets this ship before the dashboard is ready.
 * Anything unrecognised is also off: the operator asked for something this
 * does not understand, and guessing at it either under-collects tax or breaks
 * every checkout, neither of which is a guess worth making.
 */
export function taxIsOn(setting) {
  return YES.has(String(setting ?? '').trim().toLowerCase());
}

/**
 * The fields to add to the Checkout Session, as Stripe's form encoding wants
 * them - strings, with the nested keys spelled out.
 *
 * An empty object when the switch is off, so the caller spreads it either way
 * and there is no second shape of request to reason about.
 *
 * @param {string|undefined} setting  the STRIPE_AUTOMATIC_TAX value
 * @returns {Record<string, string>}
 */
export function taxFields(setting) {
  if (!taxIsOn(setting)) return {};
  return {
    'automatic_tax[enabled]': 'true',
    /*
     * Required rather than auto. Auto collects an address only when the
     * payment method demands one, which for a card is often not at all - and
     * an address that was never asked for is not evidence of where somebody
     * lives.
     */
    billing_address_collection: 'required',
    'tax_id_collection[enabled]': 'true',
  };
}
