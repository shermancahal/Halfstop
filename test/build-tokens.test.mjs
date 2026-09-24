import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseToken, appTokenFile, webTokenFile, appPreflight } from '../tools/build-dist.mjs';
import {
  preflight as appMachinePreflight, withAndroidPermissions, ANDROID_PERMISSIONS,
  CAPACITOR_INSTALL, afterOpening, agpMajor, agpDrift, AGP_SUPPORTED_MAJOR,
  withSupportedProguard, withDeepLink, APP_PLUGINS,
} from '../tools/app.mjs';
import { APP_SCHEME } from '../assets/js/lib/native-shell.js';

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
  // --no-save: the repository keeps Capacitor out of package.json on purpose.
  assert.match(problems[0].fix, /npm install --no-save @capacitor\/cli/);
});

test('app: an unknown platform is refused by name', () => {
  const problems = appMachinePreflight({ platform: 'windows', os: 'darwin', hasCapacitor: true });
  assert.match(problems[0].what, /"windows" is not a platform/);
});

test('app: a Mac with Capacitor has nothing in the way', () => {
  assert.deepEqual(appMachinePreflight({ platform: 'ios', os: 'darwin', hasCapacitor: true }), []);
});

/* ------------------------------------------------------ the store build */

const tokenFile = (...lines) => ["window.ABMAP_MAPBOX_TOKEN = 'pk.web';", ...lines].join('\n');

/*
 * The store build used to warn about ABMAP_BILLING_STORE = 'stripe', because
 * `--app` keeps token.js as it is and that line turned the website's test
 * checkout into a card form inside the app. The app no longer reads it - the
 * platform decides (see the purchaseRoute tests) - so there is nothing left to
 * warn about, and a warning about nothing is how real ones stop being read.
 */
test('app build: the website\'s store setting is not a warning in the app', () => {
  for (const line of ["window.ABMAP_BILLING_STORE = 'stripe';", "window.ABMAP_BILLING_STORE = 'appstore';", '']) {
    const { warnings } = appPreflight(tokenFile(line));
    assert.equal(warnings.filter((w) => /checkout|BILLING_STORE/.test(w)).length, 0, line || '(nothing)');
  }
});

test('app build: billing live says where the app sells, once', () => {
  const { notes } = appPreflight(tokenFile("window.ABMAP_BILLING_LIVE = 'true';"));
  const said = notes.filter((line) => /Google Play/.test(line));
  assert.equal(said.length, 1);
  assert.match(said[0], /docs\/payments\.md/);
  assert.match(said[0], /iPhone app has no way to buy/);
  // And nothing about selling when nothing is for sale.
  assert.equal(appPreflight(tokenFile('')).notes.filter((line) => /Google Play/.test(line)).length, 0);
});

/* ------------------------------------------------- Android permissions */

/*
 * What `npx cap add android` wrote, as of Capacitor 8.5.2 - taken from a real
 * run rather than written from memory, so the edit is tested against the file
 * it will actually meet.
 */
const GENERATED_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:label="@string/app_name">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>

    <!-- Permissions -->

    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`;

/*
 * The step the docs said to do by hand, done by the tool that makes the file.
 *
 * android/ is gitignored and regenerated, so "add these by hand" meant every
 * fresh project, and forgetting is silent: the map loads, Locate is pressed,
 * and nothing happens - no prompt, no error.
 */
test('android: a fresh manifest gets the location permissions', () => {
  const { manifest, added } = withAndroidPermissions(GENERATED_MANIFEST);
  assert.deepEqual(added, ANDROID_PERMISSIONS);
  for (const name of ANDROID_PERMISSIONS) {
    assert.ok(manifest.includes(`<uses-permission android:name="${name}" />`), name);
  }
  // And INTERNET, which cap add wrote, is still there exactly once.
  assert.equal(manifest.split('android.permission.INTERNET').length - 1, 1);
});

test('android: they land inside the manifest, not after it', () => {
  // A line after </manifest> is a file Gradle refuses to merge.
  const { manifest } = withAndroidPermissions(GENERATED_MANIFEST);
  const end = manifest.lastIndexOf('</manifest>');
  for (const name of ANDROID_PERMISSIONS) {
    assert.ok(manifest.indexOf(name) < end, `${name} is outside <manifest>`);
  }
  assert.ok(manifest.trimEnd().endsWith('</manifest>'));
});

test('android: running it again changes nothing', () => {
  // It runs on every build, so the second run is the common case.
  const once = withAndroidPermissions(GENERATED_MANIFEST).manifest;
  const twice = withAndroidPermissions(once);
  assert.deepEqual(twice.added, []);
  assert.equal(twice.manifest, once);
});

test('android: one already declared by hand is not declared twice', () => {
  // Somebody who followed the old instructions has a manifest with these in
  // it already. A duplicate is a Gradle merge warning at best.
  const halfway = GENERATED_MANIFEST.replace('</manifest>',
    '    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />\n</manifest>');
  const { manifest, added } = withAndroidPermissions(halfway);
  assert.deepEqual(added, ['android.permission.ACCESS_COARSE_LOCATION']);
  assert.equal(manifest.split('ACCESS_FINE_LOCATION').length - 1, 1);
});

test('android: a file that is not a manifest is refused, not guessed at', () => {
  assert.throws(() => withAndroidPermissions('<resources></resources>'), /no <\/manifest>/);
});

/* ------------------------------------------- installing, and after opening */

/*
 * The repository says Capacitor is deliberately not a dependency, and every
 * install instruction used to say --save-dev - which writes it into two
 * tracked files. The first real run on a Mac left both modified, and the next
 * `git pull` touching either would have refused.
 */
test('app tool: the install it recommends does not touch tracked files', () => {
  assert.match(CAPACITOR_INSTALL, /--no-save/);
  assert.doesNotMatch(CAPACITOR_INSTALL, /--save-dev|--save\b|-D\b/);
  for (const name of ['@capacitor/cli', '@capacitor/core', '@capacitor/ios', '@capacitor/android']) {
    assert.ok(CAPACITOR_INSTALL.includes(name), `the install line leaves out ${name}`);
  }
});

test('app tool: a machine without Capacitor is told that line, not another', () => {
  const problems = appMachinePreflight({ platform: 'android', os: 'darwin', hasCapacitor: false });
  assert.ok(problems.some((problem) => problem.fix === CAPACITOR_INSTALL),
    'the preflight recommends a different install from the one the tool stands behind');
});

test('app tool: the docs agree with the tool about how to install', async () => {
  // Four places in the docs said --save-dev. A doc that disagrees with the
  // tool is the one somebody copies from.
  const { readFile } = await import('node:fs/promises');
  const docs = await readFile(new URL('../docs/mobile-app.md', import.meta.url), 'utf8');
  assert.doesNotMatch(docs, /npm install --save-dev @capacitor/,
    'docs/mobile-app.md still installs Capacitor into package.json');
});

/*
 * The first Android run ended on Xcode's instructions: "pick your team under
 * Signing", and a pointer to the iPhone checklist. Android Studio has no team
 * to pick for a debug build.
 */
test('app tool: Android is told what Android Studio wants', () => {
  const lines = afterOpening('android').join('\n');
  assert.match(lines, /section 6c/);
  assert.doesNotMatch(lines, /team|Signing|6a/, 'Android was given the Xcode instructions');
});

test('app tool: iOS keeps its own', () => {
  const lines = afterOpening('ios').join('\n');
  assert.match(lines, /Signing/);
  assert.match(lines, /section 6a/);
});

/* ------------------------------------------ Android Gradle Plugin drift */

/*
 * The top of the build.gradle Capacitor 8.5.2 actually writes, from a real
 * `cap add android` - including the google-services line, which also says
 * "classpath ... gradle" and is not the plugin being asked about.
 */
const GENERATED_ROOT_GRADLE = `buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath 'com.android.tools.build:gradle:8.13.0'
        classpath 'com.google.gms:google-services:4.4.4'
    }
}
`;

test('android: the plugin version is read from the plugin line', () => {
  assert.equal(agpMajor(GENERATED_ROOT_GRADLE), 8);
  assert.equal(agpMajor(GENERATED_ROOT_GRADLE.replace('gradle:8.13.0', 'gradle:9.1.2')), 9);
  // google-services 4.4.4 is not an Android Gradle Plugin at major version 4.
  assert.equal(agpMajor("classpath 'com.google.gms:google-services:4.4.4'"), null);
  assert.equal(agpMajor(''), null);
});

test('android: a freshly generated project is not flagged', () => {
  assert.equal(agpDrift(GENERATED_ROOT_GRADLE), null);
});

/*
 * The first real build failed in Android Studio on a proguard line, and the
 * cause was two steps back: the IDE had upgraded the plugin to 9, which
 * refuses a line Capacitor's template writes. Reported as "are we sure
 * Halfstop is even loaded?" - which is the question a red proguard error
 * with no mention of an upgrade makes a person ask.
 */
test('android: a project moved past the supported plugin says so, and how to undo it', () => {
  const warning = agpDrift(GENERATED_ROOT_GRADLE.replace('gradle:8.13.0', 'gradle:9.0.0'));
  assert.ok(warning, 'an upgraded project was not flagged');
  assert.match(warning, /Android Gradle Plugin 9/);
  assert.match(warning, /rm -rf android/);
  assert.match(warning, new RegExp(`AGP ${AGP_SUPPORTED_MAJOR}`));
});

test('android: a missing build file is no answer rather than a wrong one', () => {
  assert.equal(agpDrift(undefined), null);
  assert.equal(agpDrift('not gradle at all'), null);
});

/* --------------------------------------------------- the proguard line */

// The release block Capacitor 8.5.2 writes into app/build.gradle, verbatim.
const TEMPLATE_RELEASE = `    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }`;

/*
 * The line AGP 9 refuses. Declining Android Studio's upgrade was the first
 * answer and it did not hold: the first real build came back from a fresh
 * project still on AGP 9, failing on exactly this. So the tool rewrites it to
 * the name both plugins accept - inert, because minifyEnabled is false.
 */
test('android: the template proguard line is rewritten to one AGP 9 accepts', () => {
  const { text, changed } = withSupportedProguard(TEMPLATE_RELEASE);
  assert.equal(changed, true);
  assert.match(text, /getDefaultProguardFile\('proguard-android-optimize\.txt'\)/);
  assert.doesNotMatch(text, /'proguard-android\.txt'/);
});

test('android: nothing else in the file is touched', () => {
  /*
   * Compared whole, not by spot checks. Checking that proguard-rules.pro and
   * minifyEnabled survived passed a version that also slipped an extra
   * argument into the line - both strings were still there. The only
   * acceptable difference is the one file name.
   */
  const { text } = withSupportedProguard(TEMPLATE_RELEASE);
  assert.equal(text, TEMPLATE_RELEASE.replace("'proguard-android.txt'", "'proguard-android-optimize.txt'"));
});

test('android: double quotes are rewritten too', () => {
  // Groovy takes either, and a hand edit or a later template may use these.
  const { text, changed } = withSupportedProguard('getDefaultProguardFile("proguard-android.txt")');
  assert.equal(changed, true);
  assert.equal(text, 'getDefaultProguardFile("proguard-android-optimize.txt")');
});

test('android: a file already fixed is left exactly as it is', () => {
  const once = withSupportedProguard(TEMPLATE_RELEASE).text;
  const twice = withSupportedProguard(once);
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once);
});


/* ------------------------------------------------ links back into the app */

/*
 * Without the filter, com.halfstop.app://account is an address nothing
 * answers to: the confirmation email, the reset and the return from Google
 * all end on a browser page that cannot open it, with the link already spent.
 */
test('android: the launching activity learns to open the app\'s own links', () => {
  const { manifest, added } = withDeepLink(GENERATED_MANIFEST, 'com.halfstop.app');
  assert.equal(added, true);
  assert.ok(manifest.includes('<data android:scheme="com.halfstop.app" />'));
  for (const line of ['android.intent.action.VIEW', 'android.intent.category.DEFAULT', 'android.intent.category.BROWSABLE']) {
    assert.ok(manifest.includes(line), line);
  }
  // Inside the activity, after the launcher filter - an intent filter
  // anywhere else is ignored, or refused by the merger.
  const scheme = manifest.indexOf('android:scheme');
  assert.ok(scheme > manifest.indexOf('category.LAUNCHER'));
  assert.ok(scheme < manifest.indexOf('</activity>'));
  // And the launcher filter is still whole: the app must still have an icon.
  assert.match(manifest, /<action android:name="android.intent.action.MAIN" \/>\s*<category android:name="android.intent.category.LAUNCHER" \/>\s*<\/intent-filter>/);
});

test('android: the link filter is added once, however often the tool runs', () => {
  const once = withDeepLink(GENERATED_MANIFEST, 'com.halfstop.app').manifest;
  const twice = withDeepLink(once, 'com.halfstop.app');
  assert.equal(twice.added, false);
  assert.equal(twice.manifest, once);
});

test('android: links and permissions together leave nothing else changed', () => {
  // The two edits run back to back on the same file. Taking both out again
  // must give back exactly what cap add wrote.
  const permitted = withAndroidPermissions(GENERATED_MANIFEST).manifest;
  const both = withDeepLink(permitted, 'com.halfstop.app').manifest;
  const unlinked = both.replace(/\n\n\s*<intent-filter>\s*<action android:name="android.intent.action.VIEW" \/>[\s\S]*?<\/intent-filter>/, '');
  const unpermitted = unlinked.replace(/ {4}<uses-permission android:name="android.permission.ACCESS_(FINE|COARSE)_LOCATION" \/>\n/g, '');
  assert.equal(unpermitted, GENERATED_MANIFEST);
});

test('android: a manifest with no launcher, or no scheme to register, is refused', () => {
  assert.throws(() => withDeepLink('<manifest></manifest>', 'com.halfstop.app'), /no launcher intent filter/);
  assert.throws(() => withDeepLink(GENERATED_MANIFEST, ''), /no appId/);
});

test('app: the scheme the page returns to is the one Android is told to open', async () => {
  // The manifest is written from capacitor.config.json; the return address
  // from native-shell.js. Two names for one thing drift, and when they do
  // every sign-in link opens nothing.
  const { readFile } = await import('node:fs/promises');
  const config = JSON.parse(await readFile(new URL('../capacitor.config.json', import.meta.url), 'utf8'));
  assert.equal(config.appId, APP_SCHEME);
});

/*
 * `cap sync` finds plugins by reading package.json, and --no-save keeps them
 * out of it. includePlugins is what makes sync see them at all.
 */
test('app: every plugin installed is one the config tells cap sync to include', async () => {
  const { readFile } = await import('node:fs/promises');
  const config = JSON.parse(await readFile(new URL('../capacitor.config.json', import.meta.url), 'utf8'));
  assert.deepEqual([...config.includePlugins].sort(), [...APP_PLUGINS].sort());
  for (const name of APP_PLUGINS) {
    assert.ok(CAPACITOR_INSTALL.split(/\s+/).includes(name), `the install line leaves out ${name}`);
  }
});

test('app tool: a missing plugin stops the build, with the whole install line', () => {
  // cap sync skips a listed plugin it cannot find, silently. The build that
  // follows works, and has no way back from Google and no way to pay.
  const problems = appMachinePreflight({
    platform: 'android', os: 'darwin', hasCapacitor: true, missingPlugins: ['@capgo/native-purchases'],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0].what, /@capgo\/native-purchases/);
  assert.equal(problems[0].fix, CAPACITOR_INSTALL);

  assert.deepEqual(appMachinePreflight({ platform: 'android', os: 'darwin', hasCapacitor: true, missingPlugins: [] }), []);
});

test('app tool: the docs carry the install line the tool asks for, whole', async () => {
  // Somebody who installed from the docs before the plugins existed has the
  // four packages and not the three. The docs are what they will copy again.
  const { readFile } = await import('node:fs/promises');
  const docs = await readFile(new URL('../docs/mobile-app.md', import.meta.url), 'utf8');
  assert.ok(docs.includes(CAPACITOR_INSTALL), 'docs/mobile-app.md does not give the current install line');
});
