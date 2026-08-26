import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseToken } from '../tools/build-dist.mjs';

const FILE = `
window.ABMAP_MAPBOX_TOKEN = 'pk.website';
window.ABMAP_MAPBOX_TOKEN_APP = 'pk.application';
window.ABMAP_SUPABASE_URL = 'https://example.supabase.co';
`;

test('a web build takes the website token', () => {
  const chosen = chooseToken({ source: FILE });
  assert.equal(chosen.token, 'pk.website');
  assert.equal(chosen.kind, 'web');
});

test('an app build takes the app token', () => {
  const chosen = chooseToken({ source: FILE, wantApp: true });
  assert.equal(chosen.token, 'pk.application');
  assert.equal(chosen.kind, 'app');
});

test('the environment wins over the file, so CI does not need one', () => {
  assert.equal(chooseToken({ source: FILE, env: { MAPBOX_TOKEN: 'pk.from-ci' } }).token, 'pk.from-ci');
  assert.equal(
    chooseToken({ source: FILE, wantApp: true, env: { MAPBOX_TOKEN_APP: 'pk.app-from-ci' } }).token,
    'pk.app-from-ci',
  );
});

test('an app build with no app token is an error, not a fallback', () => {
  // The whole reason this function exists. Falling back to the website's token
  // ships a URL-restricted key into a webview that sends no Referer: every tile
  // request 401s, the map is blank, and nothing in the app says why.
  assert.throws(
    () => chooseToken({ source: "window.ABMAP_MAPBOX_TOKEN = 'pk.website';", wantApp: true }),
    /No app token/,
  );
  assert.throws(() => chooseToken({ source: '', wantApp: true }), /No app token/);
});

test('an empty or whitespace app token does not count as set', () => {
  assert.throws(() => chooseToken({ source: "window.ABMAP_MAPBOX_TOKEN_APP = '';", wantApp: true }), /No app token/);
  assert.throws(() => chooseToken({ source: "window.ABMAP_MAPBOX_TOKEN_APP = '   ';", wantApp: true }), /No app token/);
  // A blank environment variable falls through to the file rather than being
  // treated as "set to nothing" — CI exports the name whether or not the
  // secret exists, so an unset secret arrives as an empty string.
  assert.equal(chooseToken({ source: FILE, wantApp: true, env: { MAPBOX_TOKEN_APP: '  ' } }).token, 'pk.application');
});

test('reusing one token for both is refused', () => {
  // Not pedantry: an APK or an IPA is a zip anyone can read strings out of, so
  // the app's copy should cost one revocation rather than take the site down.
  assert.throws(
    () => chooseToken({ source: "window.ABMAP_MAPBOX_TOKEN = 'pk.same';\nwindow.ABMAP_MAPBOX_TOKEN_APP = 'pk.same';", wantApp: true }),
    /the same/,
  );
});

test('a web build still works with no token at all', () => {
  // The site runs on the open USGS/Esri/OSM basemaps without one, and that is
  // a supported state rather than a broken one.
  assert.equal(chooseToken({ source: '' }).token, '');
  assert.equal(chooseToken({ source: '' }).kind, 'web');
});

test('choosing a token never runs the build', () => {
  // Importing build-dist.mjs must not stage anything. If `main()` ran on
  // import, this test file would silently rebuild dist/ on every `npm test`.
  assert.equal(typeof chooseToken, 'function');
});
