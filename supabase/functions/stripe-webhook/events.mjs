/**
 * What a Stripe event means for somebody's entitlement.
 *
 * Pure, and plain JavaScript, for the same reason as signature.mjs next to it:
 * this decides who gets Premium and until when, and reading it carefully is
 * not the same as testing it. The first version of this logic granted
 * permanent Premium on a completed checkout, because a Checkout Session has no
 * `current_period_end`, so the expiry came out null - and null here means
 * never expires. Nothing about that looked wrong on the page.
 */

/**
 * When the paid-for period ends.
 *
 * Stripe moved this. On a Subscription it used to sit at the top level and now
 * lives on each item, so both are read: the old shape first, then the item.
 * Getting this wrong does not throw, it returns null, and null is "never
 * expires" - which is exactly the direction a billing bug should not fail in.
 */
export function periodEnd(subscription) {
  const top = Number(subscription?.current_period_end);
  if (Number.isFinite(top) && top > 0) return new Date(top * 1000).toISOString();

  const item = Number(subscription?.items?.data?.[0]?.current_period_end);
  if (Number.isFinite(item) && item > 0) return new Date(item * 1000).toISOString();

  return null;
}

/**
 * Which Stripe statuses mean "this person may use the thing".
 *
 * `past_due` is deliberately included. A card that failed on Tuesday is
 * somebody Stripe is still retrying and still treats as a customer, and
 * switching their maps off mid-trip over a retry that usually succeeds is the
 * worse mistake.
 */
export const ACTIVE = new Set(['active', 'trialing', 'past_due']);

/** Whose account this is, from the metadata the checkout wrote. */
function whose(object) {
  return String(object?.metadata?.supabase_user_id || object?.client_reference_id || '');
}

/**
 * Read an event into an instruction, or into nothing.
 *
 * @returns {{action: 'grant'|'end'|'ignore', userId?, expiresAt?, externalRef?, status?, why?}}
 */
export function readEvent(event, { now = Date.now() } = {}) {
  const type = String(event?.type || '');
  const object = event?.data?.object || {};
  const userId = whose(object);

  /*
   * A completed checkout grants nothing.
   *
   * It is tempting, because it is the moment the money moves. But the session
   * carries no status and no period end, and its `id` is the session's rather
   * than the subscription's - so granting from it means an entitlement with
   * the wrong reference and no expiry at all. The subscription events carry
   * both and arrive for every subscription checkout, so they are the only
   * thing that writes.
   */
  if (type === 'checkout.session.completed') {
    return { action: 'ignore', why: 'a checkout carries no period; the subscription event decides' };
  }

  if (!type.startsWith('customer.subscription.')) {
    return { action: 'ignore', why: `nothing here acts on ${type || 'an event with no type'}` };
  }

  if (!userId) {
    return { action: 'ignore', why: 'no supabase_user_id on the subscription' };
  }

  const externalRef = String(object.id || '');

  if (type === 'customer.subscription.deleted') {
    return { action: 'end', userId, externalRef, why: 'the subscription was cancelled' };
  }

  const status = String(object.status || '');
  if (!ACTIVE.has(status)) {
    /*
     * A subscription only just created, not active yet, has nothing to end.
     *
     * Stripe sends `created` with status `incomplete` the moment a checkout
     * begins and `updated` with `active` when the card confirms, and the two
     * arrive within the same millisecond, on separate function instances, in
     * whichever order they happen to land. Reading the first as a
     * cancellation means a paid subscription whose events arrive the wrong way
     * round expires itself: the grant writes, the end overwrites it, and
     * somebody who has just paid is on Free.
     *
     * Not hypothetical. It happened on the first real test checkout, and only
     * the order saved it - the end ran first, against a row that did not exist
     * yet, and matched nothing. The other order was equally likely.
     *
     * Ending belongs to a subscription that stopped: `deleted`, or an
     * `updated` that left the active set. A creation that never confirms
     * simply never grants, which needs no event of its own.
     */
    if (type === 'customer.subscription.created') {
      return {
        action: 'ignore',
        status,
        why: `a subscription created as ${status || 'status-less'} has nothing to end`,
      };
    }

    // Ended now rather than nulled: null means never expires, which is the
    // opposite of what an unpaid or cancelled subscription means.
    return {
      action: 'end', userId, externalRef, status, why: `status is ${status || 'missing'}`,
    };
  }

  const expiresAt = periodEnd(object);
  if (!expiresAt) {
    /*
     * Active, and we cannot tell when it ends.
     *
     * Granted anyway, for a short window rather than for ever. Refusing would
     * take Premium from somebody who has just paid because Stripe changed a
     * field name; granting without an end date would hand out permanent
     * access on a malformed event. A week is long enough for the next renewal
     * event to correct it and short enough not to matter if it does not.
     */
    return {
      action: 'grant',
      userId,
      externalRef,
      status,
      expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
      why: 'active with no readable period end; granted a week until the next event',
    };
  }

  return { action: 'grant', userId, externalRef, status, expiresAt };
}
