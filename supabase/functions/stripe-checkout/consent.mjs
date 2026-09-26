/**
 * The sentence above the pay button, for the EU's right of withdrawal.
 *
 * Somebody in the EU, the EEA or the UK buying at a distance has fourteen days
 * to withdraw. A digital service is an exception only where they asked for it
 * to start straight away *and* acknowledged that doing so ends the right - and
 * that has to happen before they pay, not in terms read afterwards. terms.html
 * says subscribing is that request; this says it where the decision is made.
 *
 * Shown to everybody rather than only to EU addresses: Checkout does not know
 * where somebody is until they type an address, and the sentence is true and
 * harmless anywhere else.
 *
 * Plain JavaScript and its own file so the wording is tested, like tax.mjs.
 * Stripe caps the message at 1200 characters and refuses the whole Session
 * over one more, which would be every checkout failing over a sentence.
 */

export const CONSENT_MESSAGE = 'Premium starts as soon as you subscribe. By subscribing you ask for it to '
  + 'start straight away, and accept that this ends the 14-day right to withdraw that EU, EEA and UK '
  + 'law otherwise gives. You can cancel at any time, and it runs to the end of the period you paid for.';

/** Stripe's limit for custom_text messages. */
export const STRIPE_CUSTOM_TEXT_LIMIT = 1200;

/** The fields to add to a Checkout Session, in Stripe's form encoding. */
export function consentFields(message = CONSENT_MESSAGE) {
  const text = String(message || '').trim();
  if (!text || text.length > STRIPE_CUSTOM_TEXT_LIMIT) return {};
  return { 'custom_text[submit][message]': text };
}
