/**
 * Sharing, at the level where the rules actually live.
 *
 * The dangerous part of showing one person another person's folder is not the
 * drawing of it - it is everything that afterwards treats it as the reader's
 * own. So these check the two halves that decide that: the marker, and what
 * the merge does with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normaliseEmail, looksLikeEmail, markShared, isShared, splitOwned,
  invitationLine, describeShares,
} from '../assets/js/lib/shares.js';
import { mergeFolders } from '../assets/js/lib/sync.js';

test('shares: an address is matched the way the policy matches it', () => {
  // The row-level policy lower-cases both sides. Anything that compares them
  // differently here would show a folder to nobody, or to the wrong person.
  assert.equal(normaliseEmail('  Sherm@Example.COM '), 'sherm@example.com');
  assert.equal(looksLikeEmail('sherm@example.com'), true);
  assert.equal(looksLikeEmail('sherm@example'), false);
  assert.equal(looksLikeEmail(''), false);
});

test('shares: a shared folder is marked once and read everywhere', () => {
  const folder = { id: 'f1', name: 'Blue Ridge', items: [] };
  assert.equal(isShared(folder), false);
  const shared = markShared(folder, { ownerId: 'u9', ownerName: 'Sherman Cahal' });
  assert.equal(isShared(shared), true);
  assert.equal(shared.sharedFrom.ownerName, 'Sherman Cahal');
  // The original is untouched, so marking cannot leak into somebody's own copy.
  assert.equal(isShared(folder), false);

  const { owned, shared: theirs } = splitOwned([folder, shared]);
  assert.deepEqual(owned.map((f) => f.id), ['f1']);
  assert.equal(theirs.length, 1);
});

test('shares: a shared folder is never offered back to the server', () => {
  /*
   * The one that matters. A shared folder reaches the merge looking exactly
   * like a local folder the server has never heard of, and the merge's whole
   * job is to push those. Pushed, it would be sent under the reader's own user
   * id - which the policy refuses, so every sync afterwards would report a
   * failure for as long as the reader kept looking at it.
   */
  const mine = { id: 'mine', name: 'My places', items: [], updatedAt: 2 };
  const theirs = markShared(
    { id: 'theirs', name: 'Blue Ridge', items: [], updatedAt: 2 },
    { ownerId: 'u9', ownerName: 'Sherman' },
  );

  const result = mergeFolders([mine, theirs], []);
  assert.deepEqual(result.toPush.map((f) => f.id), ['mine'],
    'a folder belonging to somebody else was queued to push');
  // And it is still there afterwards, or looking at it once would lose it.
  assert.deepEqual(result.merged.map((f) => f.id).sort(), ['mine', 'theirs']);
});

test('shares: the invitation says who, what and what it will cost', () => {
  const line = invitationLine({
    from: 'Sherman Cahal',
    folder: 'Blue Ridge',
    what: 'a field atlas for photographers',
  });
  assert.match(line, /^Sherman Cahal has invited you to view Blue Ridge on Halfstop/);
  assert.match(line, /free account/);
});

test('shares: who can see it, counted rather than listed', () => {
  assert.equal(describeShares([]), 'Not shared with anybody.');
  assert.equal(describeShares([{ invited_email: 'a@b.com' }]), 'Shared with a@b.com.');
  assert.equal(describeShares([{ invited_email: 'a@b.com' }, { invited_email: 'c@d.com' }]),
    'Shared with 2 people.');
  // A withdrawn invitation is not a person who can see it.
  assert.equal(describeShares([{ invited_email: 'a@b.com', revoked: true }]),
    'Not shared with anybody.');
});
