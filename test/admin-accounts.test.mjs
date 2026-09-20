/**
 * What the account tool will and will not do.
 *
 * This is the one endpoint in the project that can delete somebody's account
 * and hand out Premium, so the parts that decide are pure and tested here
 * rather than read carefully and deployed. A permissive bug in this file does
 * not look like a failure; it looks like a stranger with the service key's
 * reach.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  administrators, mayAdminister, readRequest, mayChange, whyNot, describeAccount, ACTIONS,
} from '../supabase/functions/admin-accounts/actions.mjs';

const ADMIN = 'shermancahal@gmail.com';

test('admin: an unset list is nobody, not everybody', () => {
  /*
   * The direction a missing variable fails in. A function that let the whole
   * internet manage accounts because ADMIN_EMAILS was never set would be
   * indistinguishable from a working one until somebody found it.
   */
  assert.equal(mayAdminister(ADMIN, undefined), false);
  assert.equal(mayAdminister(ADMIN, ''), false);
  assert.equal(mayAdminister(ADMIN, '   '), false);
  assert.equal(mayAdminister(ADMIN, ','), false);
  assert.equal(mayAdminister('', ADMIN), false, 'and no address is not a match either');
});

test('admin: the list is read the way addresses are actually typed', () => {
  assert.equal(mayAdminister(ADMIN, ADMIN), true);
  assert.equal(mayAdminister('ShermanCahal@Gmail.com', ADMIN), true, 'case is not identity');
  assert.equal(mayAdminister(ADMIN, ` ${ADMIN} , someone@else.test `), true);
  assert.equal(mayAdminister('someone@else.test', ADMIN), false);
  // A near miss is a miss: no prefix, suffix or substring match.
  assert.equal(mayAdminister('shermancahal@gmail.com.evil.test', ADMIN), false);
  assert.equal(mayAdminister('xshermancahal@gmail.com', ADMIN), false);
  assert.deepEqual(administrators(`${ADMIN},,  second@test.example `), [ADMIN, 'second@test.example']);
});

test('admin: only the actions this function has are answered', () => {
  for (const action of ACTIONS) {
    const read = readRequest({ action, userId: 'u1', email: 'a@b.test', confirm: 'a@b.test' });
    assert.equal(read.ok, true, `${action} should be readable`);
  }
  for (const action of ['', 'drop', 'list; drop', 'LIST', undefined]) {
    const read = readRequest({ action });
    assert.equal(read.ok, false);
    assert.equal(read.status, 400);
  }
});

test('admin: deleting needs the address typed, and the server is what checks', () => {
  /*
   * The page asks for the address before it enables the button. That guard
   * lives in the browser, which means it can be skipped by calling the
   * endpoint directly - and this is the one request here that cannot be taken
   * back. So the check is in both places, and this is the one that counts.
   */
  const target = { action: 'delete', userId: 'u2', email: 'friend@test.example' };

  assert.equal(readRequest({ ...target }).ok, false, 'nothing typed');
  assert.equal(readRequest({ ...target, confirm: 'friend' }).ok, false, 'half typed');
  assert.equal(readRequest({ ...target, confirm: 'someone@else.test' }).ok, false, 'the wrong account');
  assert.equal(readRequest({ ...target, confirm: '' }).ok, false);

  const good = readRequest({ ...target, confirm: 'friend@test.example' });
  assert.equal(good.ok, true);
  assert.equal(good.userId, 'u2');

  // Typed with the capitals somebody's mail client shows them.
  assert.equal(readRequest({ ...target, confirm: 'Friend@Test.Example' }).ok, true);
});

test('admin: the administrator cannot delete themselves from here', () => {
  // It would lock the tool, and closing your own account is a real thing to
  // want that has its own path where the consequences are the subject.
  const read = readRequest(
    { action: 'delete', userId: 'u1', email: ADMIN, confirm: ADMIN },
    { caller: ADMIN },
  );
  assert.equal(read.ok, false);
  assert.match(read.error, /account page/);

  // And somebody else's account is still deletable by that same caller.
  assert.equal(readRequest(
    { action: 'delete', userId: 'u2', email: 'friend@test.example', confirm: 'friend@test.example' },
    { caller: ADMIN },
  ).ok, true);
});

test('admin: a bought subscription is not this tool’s to change', () => {
  /*
   * Revoking a Stripe row takes access from somebody who is still paying;
   * granting over one is overwritten by the next webhook. Neither is a thing
   * to do quietly, so the function refuses and says where to go instead.
   */
  assert.equal(mayChange('granted'), true);
  assert.equal(mayChange('comp'), true);
  assert.equal(mayChange(undefined), true, 'an account with no entitlement is grantable');
  assert.equal(mayChange('stripe'), false);
  assert.equal(mayChange('appstore'), false);

  assert.match(whyNot('stripe'), /Stripe/);
  assert.match(whyNot('appstore'), /Apple/);
});

test('admin: an invitation needs something that could be an address', () => {
  assert.equal(readRequest({ action: 'invite', email: 'friend@test.example' }).ok, true);
  assert.equal(readRequest({ action: 'invite', email: 'FRIEND@TEST.EXAMPLE' }).email, 'friend@test.example');
  for (const email of ['', 'friend', 'friend at test', 'a b@test.example', undefined]) {
    assert.equal(readRequest({ action: 'invite', email }).ok, false, `${email} should be refused`);
  }
});

test('admin: a grant may carry an expiry, and only a real one', () => {
  assert.equal(readRequest({ action: 'grant', userId: 'u1' }).until, null, 'no date means no end');
  assert.equal(readRequest({ action: 'grant', userId: 'u1', until: '2027-01-01T00:00:00Z' }).ok, true);
  assert.equal(readRequest({ action: 'grant', userId: 'u1', until: 'next tuesday' }).ok, false);
  assert.equal(readRequest({ action: 'grant' }).ok, false, 'and it has to name an account');
});

/* ------------------------------------------------------------ the list row */

const NOW = Date.parse('2026-09-20T12:00:00Z');
const user = (extra = {}) => ({
  id: 'u1',
  email: 'friend@test.example',
  created_at: '2026-09-01T00:00:00Z',
  email_confirmed_at: '2026-09-01T00:05:00Z',
  app_metadata: { provider: 'email' },
  ...extra,
});

test('admin: the list says what somebody has and where it came from', () => {
  const granted = describeAccount(
    user(), { tier: 'premium', source: 'granted', expires_at: null, renews: false }, 4, { now: NOW },
  );
  assert.equal(granted.plan, 'premium');
  assert.equal(granted.source, 'granted');
  assert.equal(granted.until, null);
  assert.equal(granted.folders, 4);
  assert.equal(granted.changeable, true);

  const bought = describeAccount(
    user(), { tier: 'premium', source: 'stripe', expires_at: '2026-10-13T00:00:00Z', renews: true }, 0, { now: NOW },
  );
  assert.equal(bought.plan, 'premium');
  assert.equal(bought.source, 'stripe');
  assert.equal(bought.changeable, false, 'so the interface can refuse before the function does');
  assert.equal(bought.renews, true);
});

test('admin: a trial is reported as a trial, not as Premium', () => {
  /*
   * It is the one state with a clock on it, and this list is where somebody
   * decides whether to grant anything - "Premium" against an account that is
   * simply new would be the wrong basis for that decision.
   */
  const fresh = describeAccount(user(), null, 0, { now: NOW });
  assert.equal(fresh.plan, 'trial');
  assert.equal(fresh.source, 'trial');
  assert.equal(Date.parse(fresh.until), Date.parse('2026-10-01T00:00:00Z'));

  const old = describeAccount(user({ created_at: '2026-01-01T00:00:00Z' }), null, 0, { now: NOW });
  assert.equal(old.plan, 'free');
  assert.equal(old.until, null);
});

test('admin: an expired grant is not a plan', () => {
  // my_plan() ignores a row whose date has passed, and this list has to agree
  // with it or the interface reports access somebody does not have.
  const lapsed = describeAccount(
    user({ created_at: '2026-01-01T00:00:00Z' }),
    { tier: 'premium', source: 'granted', expires_at: '2026-09-01T00:00:00Z' },
    0,
    { now: NOW },
  );
  assert.equal(lapsed.plan, 'free');
  assert.equal(lapsed.changeable, true, 'and it can be granted again');
});

test('admin: an unconfirmed account is visible as one', () => {
  // There is one in the live project that has never confirmed. It is the
  // difference between somebody who could not find the email and somebody who
  // never existed, and the list should not flatten the two.
  const pending = describeAccount(user({ email_confirmed_at: null }), null, 0, { now: NOW });
  assert.equal(pending.confirmed, false);
  assert.equal(describeAccount(user(), null, 0, { now: NOW }).confirmed, true);
});
