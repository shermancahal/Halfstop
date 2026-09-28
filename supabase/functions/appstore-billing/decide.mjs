/**
 * What Apple's answer about a subscription means for somebody's entitlement.
 *
 * Pure, for the reason play-billing/decide.mjs gives: this decides who gets
 * Premium and until when, and the ways it can be wrong do not throw. They
 * write a row. The ones this guards against are the same as Google's - a
 * purchase handed in by an account it does not belong to, and a subscription
 * paid elsewhere written over - and tested beside this.
 */

import { decodeJWS } from './apple.mjs';

/**
 * Apple's subscription statuses, by number.
 *
 * 1 active, 2 expired, 3 in billing retry (the card failed and Apple is still
 * trying, with access withdrawn), 4 in the billing grace period (the card
 * failed, and access is kept while Apple retries - which Apple asks
 * developers to honour), 5 revoked (refunded, or family sharing withdrawn).
 */
export const STATUS = { 1: 'active', 2: 'expired', 3: 'billing retry', 4: 'grace period', 5: 'revoked' };
const ENTITLED = new Set([1, 4]);

/**
 * The parts of a StatusResponse this project acts on.
 *
 * A customer can hold more than one subscription in a group over time; the
 * one read is ours by bundle and product, preferring one that grants, then
 * the one that runs latest.
 *
 * @param {object} response  getSubscriptionStatuses' answer
 * @param {object} options
 * @param {string} options.bundleId
 * @param {string[]} options.productIds  the products Halfstop sells
 */
export function readStatus(response, { bundleId, productIds = [], now = Date.now() } = {}) {
  const sold = new Set(productIds);
  const candidates = [];
  for (const group of Array.isArray(response?.data) ? response.data : []) {
    for (const entry of Array.isArray(group?.lastTransactions) ? group.lastTransactions : []) {
      const transaction = decodeJWS(entry?.signedTransactionInfo) || {};
      const renewal = decodeJWS(entry?.signedRenewalInfo) || {};
      if (transaction.bundleId !== bundleId || !sold.has(transaction.productId)) continue;
      candidates.push({ status: Number(entry.status), transaction, renewal });
    }
  }
  if (!candidates.length) {
    return { ours: false, entitled: false, userId: '', originalTransactionId: '', status: 0 };
  }

  const expiry = (candidate) => {
    const dates = [Number(candidate.transaction.expiresDate), Number(candidate.renewal.gracePeriodExpiresDate)]
      .filter(Number.isFinite);
    return dates.length ? Math.max(...dates) : NaN;
  };
  candidates.sort((a, b) => (Number(ENTITLED.has(b.status)) - Number(ENTITLED.has(a.status)))
    || ((expiry(b) || 0) - (expiry(a) || 0)));
  const { status, transaction, renewal } = candidates[0];

  const revoked = status === 5 || Number.isFinite(Number(transaction.revocationDate));
  const expires = Number(transaction.expiresDate);
  // In the grace period the paid period may already have ended; Apple's own
  // grace date is how long access is kept while it retries the card.
  const grace = Number(renewal.gracePeriodExpiresDate);
  let ends = status === 4 && Number.isFinite(grace) ? Math.max(grace, Number.isFinite(expires) ? expires : 0) : expires;

  let entitled = ENTITLED.has(status) && !revoked && Number.isFinite(ends) && ends > now;
  // Not entitled ends now, never later: a future date on a revoked
  // subscription would read as access still to come.
  if (!entitled) ends = Number.isFinite(ends) ? Math.min(ends, now) : now;

  return {
    ours: true,
    status,
    statusName: STATUS[status] || `status ${status}`,
    entitled,
    revoked,
    userId: String(transaction.appAccountToken || '').toLowerCase(),
    originalTransactionId: String(transaction.originalTransactionId || ''),
    transactionId: String(transaction.transactionId || ''),
    productId: String(transaction.productId || ''),
    expiresAt: new Date(ends).toISOString(),
    renews: entitled && Number(renewal.autoRenewStatus) === 1,
    sandbox: String(transaction.environment || response?.environment || '') === 'Sandbox',
  };
}

/**
 * Whether the account asking is the one the purchase was made for.
 *
 * The app passes the account id to StoreKit as the purchase's
 * appAccountToken, and Apple hands it back on every answer about it. A
 * purchase naming nobody - an offer code redeemed in the App Store, say -
 * belongs to nobody here.
 */
export function claimedBy(read, userId) {
  return Boolean(read?.userId) && read.userId === String(userId || '').toLowerCase();
}

/** Sources that charge somebody, and so must never be written over by another. */
const BILLS_ELSEWHERE = new Set(['stripe', 'play']);

/**
 * What to do with somebody's entitlement row, given what Apple said.
 *
 * @param {object} read      from readStatus
 * @param {object|null} held the row as it stands: { source, external_ref, expires_at }
 * @returns {{ action: 'write'|'ignore'|'conflict', why: string, row?: object }}
 */
export function decideWrite(read, held, { now = Date.now() } = {}) {
  if (!read.ours) return { action: 'ignore', why: 'not a purchase of the product Halfstop sells' };
  if (!read.userId) return { action: 'ignore', why: 'the purchase names no Halfstop account' };

  const heldRunning = held && (!held.expires_at || Date.parse(held.expires_at) > now);
  // The original transaction id is the subscription's: it stays the same
  // through renewals and through a change between monthly and yearly.
  const sameSubscription = held?.source === 'appstore' && held?.external_ref === read.originalTransactionId;

  if (heldRunning && BILLS_ELSEWHERE.has(held.source)) {
    return read.entitled
      ? { action: 'conflict', why: `already subscribes through ${held.source}` }
      : { action: 'ignore', why: `an inactive App Store purchase beside a ${held.source} subscription` };
  }

  if (!read.entitled && !sameSubscription) {
    return { action: 'ignore', why: `nothing to grant (${read.statusName})` };
  }

  return {
    action: 'write',
    why: read.entitled ? 'entitled' : `ended (${read.statusName})`,
    row: {
      user_id: read.userId,
      tier: 'premium',
      source: 'appstore',
      expires_at: read.expiresAt,
      external_ref: read.originalTransactionId,
      renews: read.renews,
      note: `App Store ${read.statusName}, ${read.productId}${read.sandbox ? ', sandbox' : ''}`,
      updated_at: new Date(now).toISOString(),
    },
  };
}

/**
 * The transaction an App Store Server Notification is about.
 *
 * The body is { signedPayload }, a JWS whose payload carries the type and,
 * inside `data`, the transaction as another JWS. Both are decoded without
 * being verified: all that is taken from them is which transaction to ask
 * Apple about. TEST is what App Store Connect sends from its "Request a Test
 * Notification" button, and is answered and otherwise ignored.
 *
 * @returns {{ kind: 'test'|'subscription'|'other', bundleId: string, transactionId: string, type: string }}
 */
export function readNotification(body) {
  const payload = decodeJWS(body?.signedPayload);
  if (!payload) return { kind: 'other', bundleId: '', transactionId: '', type: '' };
  const type = String(payload.notificationType || '');
  const bundleId = String(payload.data?.bundleId || '');
  if (type === 'TEST') return { kind: 'test', bundleId, transactionId: '', type };
  const transaction = decodeJWS(payload.data?.signedTransactionInfo);
  const transactionId = String(transaction?.transactionId || transaction?.originalTransactionId || '');
  if (!transactionId) return { kind: 'other', bundleId, transactionId: '', type };
  return { kind: 'subscription', bundleId, transactionId, type };
}

/**
 * Whether the notification carried the shared secret, compared in constant
 * time. The same rule as Google's endpoint: it keeps strangers from making
 * this call Apple on their behalf, and is not what keeps entitlements honest.
 */
export function tokenMatches(given, expected) {
  const a = new TextEncoder().encode(String(given || ''));
  const b = new TextEncoder().encode(String(expected || ''));
  if (!b.length) return false;
  let difference = a.length ^ b.length;
  for (let index = 0; index < b.length; index += 1) difference |= (a[index] ?? 0) ^ b[index];
  return difference === 0;
}
