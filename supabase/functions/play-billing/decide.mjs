/**
 * What Google's answer about a purchase means for somebody's entitlement.
 *
 * Pure, for the reason stripe-webhook/events.mjs gives: this decides who gets
 * Premium and until when, and the ways it can be wrong do not throw. They
 * write a row. The Stripe version once granted Premium for ever because a
 * missing date came out as null; the Play version's equivalents are a
 * superseded subscription ending the one that replaced it, and one account's
 * purchase token being handed in by another. Both are tested beside this.
 */

/**
 * Subscription states in which the buyer may use what they paid for.
 *
 * CANCELED is here on purpose, and it is the one that reads wrong. In Google's
 * vocabulary it means auto-renew is off and the paid period has not ended -
 * Stripe's `cancel_at_period_end`, not a revocation. Revoked and refunded
 * subscriptions come back EXPIRED.
 *
 * IN_GRACE_PERIOD is a card that failed and is being retried with access
 * kept, which Google asks developers to honour. ON_HOLD is after the grace
 * period, with access withdrawn until the payment is fixed. PAUSED is the
 * buyer's own choice to stop for a while.
 */
export const ENTITLED = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
  'SUBSCRIPTION_STATE_CANCELED',
]);

/** A payment that has not gone through yet - cash at a shop, say - so nothing to grant until it does. */
export const PENDING = new Set(['SUBSCRIPTION_STATE_PENDING']);

/**
 * How long a grace period is assumed to run when Google gives no later date.
 *
 * During grace the line item's expiry can sit in the past - the period ended,
 * the renewal has not been paid - and writing that date would end access that
 * Google says to keep. Three days is Google's shortest grace period; the
 * notification that ends it, or the renewal that rescues it, rewrites the row.
 */
const GRACE_FLOOR_MS = 3 * 86400000;

/**
 * The parts of a SubscriptionPurchaseV2 this project acts on.
 *
 * @param {object} subscription  Google's subscriptionsv2 answer
 * @param {object} options
 * @param {string} options.productId  the one product Halfstop sells
 * @param {number} options.now
 */
export function readSubscription(subscription, { productId, now = Date.now() } = {}) {
  const items = (Array.isArray(subscription?.lineItems) ? subscription.lineItems : [])
    .filter((item) => item?.productId === productId);
  const state = String(subscription?.subscriptionState || '');

  // Seeded with -Infinity and not NaN: Math.max(NaN, anything) is NaN, which
  // is how the first version of this read every expiry as none at all.
  const dates = items.map((item) => Date.parse(item?.expiryTime || '')).filter(Number.isFinite);
  const latest = dates.length ? dates.reduce((most, when) => Math.max(most, when), -Infinity) : NaN;

  let entitled = items.length > 0 && ENTITLED.has(state);
  let ends = latest;
  if (entitled && state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD') {
    ends = Math.max(Number.isFinite(latest) ? latest : 0, now + GRACE_FLOOR_MS);
  }
  // A state that says entitled over a date that has passed is a period that
  // ran out between Google writing the two. The date wins: access that ended
  // is not extended by a word.
  if (entitled && !(ends > now)) entitled = false;
  // Not entitled ends now, never later - a future date on an expired or
  // revoked subscription would read as access still to come.
  if (!entitled) ends = Number.isFinite(latest) ? Math.min(latest, now) : now;

  const renewing = items.some((item) => item?.autoRenewingPlan?.autoRenewEnabled === true);

  return {
    state,
    ours: items.length > 0,
    userId: String(subscription?.externalAccountIdentifiers?.obfuscatedExternalAccountId || ''),
    entitled,
    pending: PENDING.has(state),
    expiresAt: new Date(ends).toISOString(),
    renews: entitled && renewing && state !== 'SUBSCRIPTION_STATE_CANCELED',
    basePlan: String(items[0]?.offerDetails?.basePlanId || ''),
    needsAck: subscription?.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING',
    test: Boolean(subscription?.testPurchase),
  };
}

/**
 * Whether the account asking is the one the purchase was made for.
 *
 * A purchase token is not a secret to the person who bought it. Without this,
 * handing the same token in from a second account would move the purchase -
 * or, with both accounts asking in turn, give Premium to each for one payment.
 * The account id went to Google with the purchase, so Google's answer is what
 * says whose it is. A purchase naming nobody belongs to nobody.
 */
export function claimedBy(read, userId) {
  return Boolean(read?.userId) && read.userId === String(userId || '');
}

/** Sources that charge somebody, and so must never be written over by another. */
const BILLS_ELSEWHERE = new Set(['stripe', 'appstore']);

/**
 * What to do with somebody's entitlement row, given what Google said.
 *
 * @param {object} read      from readSubscription
 * @param {object|null} held the row as it stands: { source, external_ref, expires_at }
 * @param {object} options
 * @param {string} options.purchaseToken  the token Google was asked about
 * @param {boolean} [options.voided]      Google says this purchase was refunded or charged back
 * @returns {{ action: 'write'|'end'|'ignore'|'conflict', why: string, row?: object }}
 */
export function decideWrite(read, held, { purchaseToken, voided = false, now = Date.now() } = {}) {
  if (!read.ours) return { action: 'ignore', why: 'not a purchase of the product Halfstop sells' };
  if (!read.userId) {
    // Bought without an account id - a promotional code redeemed in the Play
    // Store, say. Nothing here can say whose it is, and guessing is how one
    // person's purchase becomes another's Premium.
    return { action: 'ignore', why: 'the purchase names no Halfstop account' };
  }

  const heldRunning = held && (!held.expires_at || Date.parse(held.expires_at) > now);
  const sameToken = held?.source === 'play' && held?.external_ref === purchaseToken;

  if (voided) {
    // Only the row this token wrote. A refund of an old subscription must not
    // end the one that replaced it.
    return sameToken
      ? { action: 'end', why: 'Google voided the purchase' }
      : { action: 'ignore', why: 'a voided purchase that is not the one on record' };
  }

  if (heldRunning && BILLS_ELSEWHERE.has(held.source)) {
    // One row per account, and this one is being paid for somewhere else.
    // Writing over it hides a subscription that is still charging; see the
    // same refusal in stripe-checkout.
    return read.entitled
      ? { action: 'conflict', why: `already subscribed through ${held.source}` }
      : { action: 'ignore', why: `an inactive Play purchase beside a ${held.source} subscription` };
  }

  if (!read.entitled && !sameToken) {
    /*
     * Nothing on record from this token, and nothing to grant. A payment still
     * pending arrives here, and so does a lapsed purchase heard of for the
     * first time - and so does the case this rule exists for. Google moves a
     * subscriber to a new token when they switch between monthly and yearly,
     * and the old token then expires. Heard after the new one, that expiry
     * would end the subscription that replaced it. Only the token on record
     * may end the row.
     */
    let why = `nothing to grant (${read.state || 'no state'})`;
    if (read.pending) why = 'the payment is still pending';
    else if (held?.source === 'play') why = 'a superseded Play purchase';
    return { action: 'ignore', why };
  }

  return {
    action: 'write',
    why: read.entitled ? 'entitled' : `ended (${read.state})`,
    row: {
      user_id: read.userId,
      tier: 'premium',
      source: 'play',
      expires_at: read.expiresAt,
      external_ref: purchaseToken,
      renews: read.renews,
      note: `Google Play ${read.state.replace('SUBSCRIPTION_STATE_', '').toLowerCase()}`
        + `${read.basePlan ? `, ${read.basePlan}` : ''}${read.test ? ', test purchase' : ''}`,
      updated_at: new Date(now).toISOString(),
    },
  };
}

/**
 * The purchase token a Real-time Developer Notification is about.
 *
 * Pub/Sub wraps the notification in an envelope with the payload base64
 * encoded under `message.data`. Three kinds matter: a subscription changed, a
 * purchase was voided, and the test Google sends from Play Console, which is
 * answered and otherwise ignored.
 *
 * @returns {{ kind: 'subscription'|'voided'|'test'|'other', packageName: string, purchaseToken: string, type?: number }}
 */
export function readNotification(envelope) {
  let payload = {};
  try {
    payload = JSON.parse(atob(String(envelope?.message?.data || '')));
  } catch {
    return { kind: 'other', packageName: '', purchaseToken: '' };
  }
  const packageName = String(payload?.packageName || '');
  if (payload?.testNotification) return { kind: 'test', packageName, purchaseToken: '' };
  if (payload?.subscriptionNotification?.purchaseToken) {
    return {
      kind: 'subscription',
      packageName,
      purchaseToken: String(payload.subscriptionNotification.purchaseToken),
      type: Number(payload.subscriptionNotification.notificationType),
    };
  }
  // productType 1 is a subscription; one-time products are not sold here.
  if (payload?.voidedPurchaseNotification?.purchaseToken && Number(payload.voidedPurchaseNotification.productType) === 1) {
    return { kind: 'voided', packageName, purchaseToken: String(payload.voidedPurchaseNotification.purchaseToken) };
  }
  return { kind: 'other', packageName, purchaseToken: '' };
}

/**
 * Whether the push carried the shared secret, compared in constant time.
 *
 * The notification endpoint is reachable by anybody, because Pub/Sub has no
 * Supabase session. The secret in its URL keeps strangers from making it
 * call Google on their behalf - but it is not what keeps entitlements honest.
 * Every notification only names a token, and the answer about that token is
 * Google's. A forged one can make this ask Google, and nothing more.
 */
export function tokenMatches(given, expected) {
  const a = new TextEncoder().encode(String(given || ''));
  const b = new TextEncoder().encode(String(expected || ''));
  if (!b.length) return false;
  let difference = a.length ^ b.length;
  for (let index = 0; index < b.length; index += 1) difference |= (a[index] ?? 0) ^ b[index];
  return difference === 0;
}
