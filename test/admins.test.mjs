/**
 * Who the browser will draw an administrator's furniture for.
 *
 * Presentation, not permission - lib/admins.js says so at length and it is
 * worth repeating here, because a test called "who may administer" reads like
 * a security check and is not one. What is checked below is that the answer is
 * the one config gives, and that the ways an address can be almost-right do
 * not get past it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mayAdminister } from '../assets/js/lib/admins.js';
import { mayEdit } from '../assets/js/lib/editors.js';
import { SITE } from '../assets/js/config.js';

const admin = SITE.admins[0];

test('admins: the configured address is an administrator', () => {
  assert.equal(mayAdminister({ email: admin }), true);
});

test('admins: an address is matched however it was typed', () => {
  // Supabase hands back whatever the user signed up with, and a stray space
  // survives a copy and paste out of a password manager.
  assert.equal(mayAdminister({ email: admin.toUpperCase() }), true);
  assert.equal(mayAdminister({ email: `  ${admin}  ` }), true);
});

test('admins: nobody else is', () => {
  for (const email of ['someone@example.com', `x${admin}`, `${admin}.uk`, admin.replace('@', '+admin@')]) {
    assert.equal(mayAdminister({ email }), false, email);
  }
});

test('admins: signed out is not an administrator', () => {
  /*
   * The one that matters. `user` is null until the session comes back, and an
   * empty address matching an empty entry in the list - or a missing list
   * matching anything - would put the admin link in front of every reader for
   * the moment before the account resolves.
   */
  for (const user of [null, undefined, {}, { email: '' }, { email: '   ' }, { email: null }]) {
    assert.equal(mayAdminister(user), false, JSON.stringify(user));
  }
});

test('admins: administering and editing are asked separately', () => {
  /*
   * They hold the same address today, so the check is that two questions are
   * being asked rather than one answer being reused. admin.html gated on
   * mayEdit for a while, which meant granting somebody an editor's basemaps
   * would have handed them the support queue as well.
   */
  assert.notEqual(mayAdminister, mayEdit, 'the admin gate is the editor gate again');
  assert.ok(Array.isArray(SITE.admins) && SITE.admins.length, 'SITE.admins is not a list');
  assert.notEqual(SITE.admins, SITE.editors, 'admins and editors are the same array object');
});

test('admins: the admin page gates on the admin list', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../assets/js/admin.js', import.meta.url), 'utf8');
  assert.match(source, /mayAdminister\(user\)/, 'admin.js does not gate on mayAdminister');
  assert.doesNotMatch(source, /mayEdit/, 'admin.js still reaches for the editor list');
});
