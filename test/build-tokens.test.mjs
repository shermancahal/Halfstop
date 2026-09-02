import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseToken, appTokenFile, webTokenFile, appPreflight } from '../tools/build-dist.mjs';
import { preflight as appMachinePreflight } from '../tools/app.mjs';

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

/* ---------------------------------------------------------- the app bundle */

test('an app build writes the app token under the name the page reads', () => {
  const out = appTokenFile(FILE, 'pk.application');
  assert.match(out, /window\.ABMAP_MAPBOX_TOKEN = 'pk\.application'/);
});

test('and carries only one token, not both', () => {
  // An APK is a zip. Shipping the website's key alongside the app's would
  // hand away in the bundle exactly what having two tokens is meant to protect.
  const out = appTokenFile(FILE, 'pk.application');
  assert.equal(out.includes('pk.website'), false);
  assert.match(out, /ABMAP_MAPBOX_TOKEN_APP = ''/);
});

test('the rest of the file survives, so accounts still work in the app', () => {
  assert.match(appTokenFile(FILE, 'pk.application'), /ABMAP_SUPABASE_URL = 'https:\/\/example\.supabase\.co'/);
});

test('a hand-written file with only the app line still gets a usable one', () => {
  // The likely shape when someone writes token.js themselves rather than
  // copying the example: no plain ABMAP_MAPBOX_TOKEN line to replace. The
  // first version of this dropped everything else in the file on that path.
  const minimal = "window.ABMAP_MAPBOX_TOKEN_APP = 'pk.application';\nwindow.ABMAP_SUPABASE_KEY = 'sb_publishable_x';\n";
  const out = appTokenFile(minimal, 'pk.application');
  assert.match(out, /window\.ABMAP_MAPBOX_TOKEN = 'pk\.application';/);
  assert.match(out, /ABMAP_SUPABASE_KEY = 'sb_publishable_x'/);
  assert.match(out, /ABMAP_MAPBOX_TOKEN_APP = ''/);
});

test('an empty website token is not a reason to refuse an app build', () => {
  // Running `npm start` locally needs no Mapbox token at all, so plenty of
  // checkouts will have only the app one filled in.
  const onlyApp = "window.ABMAP_MAPBOX_TOKEN = '';\nwindow.ABMAP_MAPBOX_TOKEN_APP = 'pk.application';\n";
  assert.equal(chooseToken({ source: onlyApp, wantApp: true }).token, 'pk.application');
  assert.match(appTokenFile(onlyApp, 'pk.application'), /window\.ABMAP_MAPBOX_TOKEN = 'pk\.application'/);
});

test('a web build strips the app token instead of publishing it', () => {
  // The app token cannot be URL-restricted — a Capacitor webview sends no
  // Referer — so putting it in the website's page source publishes an
  // unrestricted key to anyone who views source. CI writes a fresh token.js
  // from secrets and never sees this, but a local `npm run dist` reads the
  // file on disk, which is where the app token lives.
  const out = webTokenFile(FILE);
  assert.equal(out.includes('pk.application'), false);
  assert.match(out, /ABMAP_MAPBOX_TOKEN_APP = ''/);
  assert.match(out, /window\.ABMAP_MAPBOX_TOKEN = 'pk\.website'/, 'the website token still ships');
  assert.match(out, /ABMAP_SUPABASE_URL = 'https:\/\/example\.supabase\.co'/, 'and everything else survives');
});

test('stripping is a no-op when no app token is configured', () => {
  const plain = "window.ABMAP_MAPBOX_TOKEN = 'pk.website';\n";
  assert.equal(webTokenFile(plain), plain);
});

/* ------------------------------------------------------------------ preflight */

/*
 * What a local app build ships is whatever token.js happens to hold, and the
 * first one built here held only the two Mapbox lines: accounts silently off,
 * the house basemap billing Mapbox per tile instead of reading the archive.
 * Nothing errored. These pin the warnings that would have said so.
 */
const FULL = `
window.ABMAP_MAPBOX_TOKEN = 'pk.website';
window.ABMAP_MAPBOX_TOKEN_APP = 'pk.application';
window.ABMAP_SUPABASE_URL = 'https://x.supabase.co';
window.ABMAP_SUPABASE_KEY = 'sb_publishable_x';
window.ABMAP_PROTOMAPS_ARCHIVE = 'https://pub-x.r2.dev/byways.pmtiles';
window.ABMAP_PROTOMAPS_MAXZOOM = '14';
window.ABMAP_ROUTING_URL = '';
`;

test('a complete token.js gets no warnings, only the routing note', () => {
  const flight = appPreflight(FULL);
  assert.deepEqual(flight.warnings, []);
  assert.equal(flight.notes.length, 1);
  assert.match(flight.notes[0], /FOSSGIS/);
});

test('a bare token.js is warned about by name, for each thing it will silently lack', () => {
  const flight = appPreflight("window.ABMAP_MAPBOX_TOKEN_APP = 'pk.application';");
  assert.equal(flight.warnings.length, 2);
  assert.match(flight.warnings[0], /accounts and folder sync will be OFF/);
  assert.match(flight.warnings[1], /billed per tile/);
});

test('an archive with no maxzoom is its own warning, because 15 over a 14 draws blank ground', () => {
  const flight = appPreflight(FULL.replace("window.ABMAP_PROTOMAPS_MAXZOOM = '14';", ''));
  assert.equal(flight.warnings.length, 1);
  assert.match(flight.warnings[0], /assume 15/);
});

test('half a Supabase config counts as none', () => {
  const flight = appPreflight(FULL.replace("window.ABMAP_SUPABASE_KEY = 'sb_publishable_x';", ''));
  assert.ok(flight.warnings.some((line) => /accounts and folder sync will be OFF/.test(line)));
});

test('a routing URL of your own switches the note off', () => {
  const flight = appPreflight(FULL.replace("ABMAP_ROUTING_URL = ''", "ABMAP_ROUTING_URL = 'https://valhalla.example'"));
  assert.deepEqual(flight.notes, []);
});

/*
 * The machine check, asked about machines this suite is not running on. Each
 * problem has to carry its fix, because the reader is at a terminal wanting the
 * next command.
 */
test('app: iOS on anything but a Mac is refused before anything is built', () => {
  const problems = appMachinePreflight({ platform: 'ios', os: 'linux', hasCapacitor: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0].what, /only be built on a Mac/);
  assert.match(problems[0].fix, /Xcode/);
});

test('app: android does not need a Mac', () => {
  assert.deepEqual(appMachinePreflight({ platform: 'android', os: 'linux', hasCapacitor: true }), []);
});

test('app: a missing Capacitor names the install command', () => {
  const problems = appMachinePreflight({ platform: 'ios', os: 'darwin', hasCapacitor: false });
  assert.equal(problems.length, 1);
  assert.match(problems[0].fix, /npm install --save-dev @capacitor\/cli/);
});

test('app: an unknown platform is refused by name', () => {
  const problems = appMachinePreflight({ platform: 'windows', os: 'darwin', hasCapacitor: true });
  assert.match(problems[0].what, /"windows" is not a platform/);
});

test('app: a Mac with Capacitor has nothing in the way', () => {
  assert.deepEqual(appMachinePreflight({ platform: 'ios', os: 'darwin', hasCapacitor: true }), []);
});
