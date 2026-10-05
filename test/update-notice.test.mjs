/**
 * A new version is offered, and afterwards said, with a link to what changed.
 *
 * The map announced a new build in one line at the foot of its side panel,
 * and the other pages took it up silently, so updates happened to people and
 * the release notes went unread. lib/update-notice.js puts the offer in a box
 * and the "updated" note on the first page opened on a new build - but only
 * when that page is current, since a page from a stale cache is older, not
 * newer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  WHATS_NEW, SEEN_BUILD_KEY, RECHECK_MS, arrivedOnNewBuild, publishedBuild, noteIfUpdated, watchForUpdates,
} from '../assets/js/lib/update-notice.js';

function fakeStore(seed = {}) {
  const held = new Map(Object.entries(seed));
  return {
    held,
    getItem: (key) => (held.has(key) ? held.get(key) : null),
    setItem: (key, value) => { held.set(key, String(value)); },
  };
}

test('update notice: the release notes are the What’s new section of the help page', async () => {
  assert.equal(WHATS_NEW, 'faq.html#whats-new');
  const faq = await readFile(new URL('../faq.html', import.meta.url), 'utf8');
  assert.match(faq, /<section class="faq-section" id="whats-new">/);
});

test('update notice: only the first load on a build this device had not run is an update', () => {
  const store = fakeStore();
  assert.equal(arrivedOnNewBuild('aaaa1111', store), false, 'a first visit is not an update');
  assert.equal(store.getItem(SEEN_BUILD_KEY), 'aaaa1111');
  assert.equal(arrivedOnNewBuild('aaaa1111', store), false, 'the same build again is not one');
  assert.equal(arrivedOnNewBuild('bbbb2222', store), true);
  assert.equal(arrivedOnNewBuild('bbbb2222', store), false, 'said once, not on every page after');

  assert.equal(arrivedOnNewBuild('', store), false, 'a source checkout has no build');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(arrivedOnNewBuild('cccc3333', broken), false);
  assert.equal(arrivedOnNewBuild('cccc3333', null), false);
});

test('update notice: a page from a stale cache is not called an update', async () => {
  const store = fakeStore({ [SEEN_BUILD_KEY]: 'new22222' });
  let shown = 0;
  const show = () => { shown += 1; };

  // The page runs an older build than the one this device last saw, and the
  // server is publishing the newer one: stale, not updated.
  assert.equal(await noteIfUpdated({ build: 'old11111', latest: async () => 'new22222', store, show }), false);
  assert.equal(shown, 0);
  assert.equal(store.getItem(SEEN_BUILD_KEY), 'new22222', 'a stale page overwrote what was seen');

  // A real update: current, and new to the device.
  assert.equal(await noteIfUpdated({ build: 'new33333', latest: async () => 'new33333', store, show }), true);
  assert.equal(shown, 1);
  // Said once.
  assert.equal(await noteIfUpdated({ build: 'new33333', latest: async () => 'new33333', store, show }), false);
  // Offline: the server cannot confirm it, so nothing is said.
  store.setItem(SEEN_BUILD_KEY, 'earlier1');
  assert.equal(await noteIfUpdated({ build: 'new44444', latest: async () => '', store, show }), false);
});

test('update notice: the published build is read past every cache', async () => {
  const asked = [];
  const fetch = async (url, options) => {
    asked.push([url, options]);
    return { ok: true, json: async () => ({ build: 'abc12345', built: '2026-10-05T20:00:00Z' }) };
  };
  assert.equal(await publishedBuild({ fetch }), 'abc12345');
  assert.deepEqual(asked, [['build.json', { cache: 'no-store' }]]);
  assert.equal(await publishedBuild({ fetch: async () => ({ ok: false }) }), '');
  assert.equal(await publishedBuild({ fetch: async () => { throw new TypeError('Failed to fetch'); } }), '');
});

test('update notice: coming back to the app asks again, but not every time', () => {
  const listeners = {};
  const target = () => ({
    addEventListener: (name, handler) => { listeners[name] = handler; },
    removeEventListener: (name) => { delete listeners[name]; },
  });
  const doc = { ...target(), visibilityState: 'visible' };
  const win = target();
  let clock = 0;
  let updated = 0;
  let checked = 0;
  const stop = watchForUpdates({
    registration: { update: async () => { updated += 1; } },
    check: () => { checked += 1; },
    doc, win, now: () => clock,
  });

  listeners.visibilitychange();
  assert.equal(checked, 0, 'asked again straight after load');
  clock += RECHECK_MS + 1;
  doc.visibilityState = 'hidden';
  listeners.visibilitychange();
  assert.equal(checked, 0, 'asked while the app was in the background');
  doc.visibilityState = 'visible';
  listeners.visibilitychange();
  assert.equal(checked, 1);
  assert.equal(updated, 1, 'the service worker was not asked to look for a new sw.js');
  listeners.online();
  assert.equal(checked, 1, 'asked twice inside the interval');
  clock += RECHECK_MS + 1;
  listeners.online();
  assert.equal(checked, 2, 'getting a signal back did not ask');

  stop();
  assert.equal(listeners.visibilitychange, undefined);
  assert.equal(listeners.online, undefined);
});

test('update notice: the map offers it in a box, and the other pages say it afterwards', async () => {
  const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  const viewer = await read('assets/js/viewer.js');
  const offer = viewer.slice(viewer.indexOf('function offerNewerBuild()'));
  assert.match(offer.slice(0, 400), /offerUpdate\(\{ update: takeNewerBuild/);
  assert.match(viewer, /watchForUpdates\(\{ registration, check: checkForNewerBuild \}\)/);
  assert.match(viewer, /if \(arrivedOnNewBuild\(running\)\) noteUpdated\(/);
  for (const page of ['assets/js/home.js', 'assets/js/faq.js', 'assets/js/account.js']) {
    assert.match(await read(page), /^noteIfUpdated\(\);$/m, `${page} takes an update without saying so`);
  }
});
