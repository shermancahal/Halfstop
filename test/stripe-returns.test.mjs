/**
 * Where a checkout is allowed to send somebody back to.
 *
 * The thing being guarded against is specific: `success_url` is whatever the
 * request asked for, and an unchecked one turns this project's own checkout
 * into a redirect onto somebody else's page, arriving with our domain in the
 * referrer and a payment just behind it.
 *
 * The loopback exception exists so a checkout begun on `npm start` ends on the
 * origin it began on. Different origin, different session: without it the
 * person who just paid lands on the production site, where they are probably
 * not signed in, and the app has to tell them so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { allowedReturn, withFlag } from '../supabase/functions/stripe-checkout/returns.mjs';

const SITE = 'https://app.halfstop.app/';

test('our own pages come back unchanged', () => {
  assert.equal(allowedReturn(`${SITE}map.html`, SITE), `${SITE}map.html`);
  assert.equal(allowedReturn(`${SITE}map.html?m=byways&b=topo`, SITE), `${SITE}map.html?m=byways&b=topo`);
  assert.equal(allowedReturn(SITE, SITE), SITE);
});

test('anywhere else falls back to the site rather than being honoured', () => {
  /*
   * Falls back rather than refusing, on purpose. The payment is what somebody
   * came to do; landing on the front page afterwards is a small confusion next
   * to being told the purchase could not be started because of a query string.
   */
  for (const hostile of [
    'https://evil.example/',
    'https://evil.example/?next=https://app.halfstop.app/',
    // The one a `startsWith` on the bare host would wave through, which is why
    // the site constant ends in a slash and the check is against the whole of it.
    'https://app.halfstop.app.evil.example/',
    'javascript:alert(1)',
    '//evil.example/',
    '',
  ]) {
    assert.equal(allowedReturn(hostile, SITE), SITE, `${hostile} should not be honoured`);
  }
});

test('a development server is allowed back, and only in test mode', () => {
  const dev = 'http://localhost:8080/map.html';
  assert.equal(allowedReturn(dev, SITE, true), dev);
  assert.equal(allowedReturn('http://127.0.0.1:3000/', SITE, true), 'http://127.0.0.1:3000/');
  // Live keys mean real money, and nothing about a real purchase should end on
  // somebody's laptop. The exception disappears with the test key.
  assert.equal(allowedReturn(dev, SITE, false), SITE);
});

test('a hostname that merely begins with localhost is not loopback', () => {
  /*
   * `localhost.evil.example` resolves through DNS to whatever its owner
   * likes. Loopback means the machine the browser is on, so the pattern has to
   * end at a port, a path, or the end of the string.
   */
  for (const pretender of [
    'http://localhost.evil.example/',
    'http://127.0.0.1.evil.example/',
    'http://localhostile/',
    'http://evil.example/#localhost',
  ]) {
    assert.equal(allowedReturn(pretender, SITE, true), SITE, `${pretender} is not loopback`);
  }
});

test('a missing site is not papered over with a guess', () => {
  // Better an empty success_url that Stripe refuses than a hardcoded domain
  // appearing here as a default that nobody configured.
  assert.equal(allowedReturn(`${SITE}map.html`, ''), '');
});

test('the landing flag is added without trampling the query string', () => {
  assert.equal(withFlag(SITE), `${SITE}?subscribed=1`);
  assert.equal(withFlag(`${SITE}map.html?m=byways`), `${SITE}map.html?m=byways&subscribed=1`);
  // The flag the app reads on landing, spelled the same in both places. If
  // this ever changes, the viewer's settleCheckoutReturn changes with it.
  assert.equal(withFlag(SITE).endsWith('subscribed=1'), true);
});

test('the app reads the flag this function writes', async () => {
  /*
   * Two files, one string. The function builds `?subscribed=1` and the viewer
   * looks for it on load; a rename in either place would break the thank-you
   * silently, because a checkout that returns with an unrecognised flag looks
   * exactly like a checkout that was abandoned.
   */
  const { readFile } = await import('node:fs/promises');
  const viewer = await readFile(new URL('../assets/js/viewer.js', import.meta.url), 'utf8');
  assert.equal(viewer.includes("params.get('subscribed')"), true,
    'the viewer no longer reads the flag the checkout sends it back with');
});
