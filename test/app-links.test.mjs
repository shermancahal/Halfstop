/**
 * Shared links open in the Android app when it is installed.
 *
 * A view, a pin or a folder is sent as https://app.halfstop.app/map.html...,
 * so that it opens for anybody in any browser. With the app installed it
 * should open there instead: Android does that for a verified App Link - an
 * intent filter on the app's side (tools/app.mjs) and the site vouching for
 * the app in /.well-known/assetlinks.json - and the app opens its own copy of
 * the map with the same query and fragment (lib/native-shell.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { sharedLanding, SHARED_HOST, watchAppLinks } from '../assets/js/lib/native-shell.js';
import { withAppLinks, APP_LINK_HOST, APP_LINK_PATH } from '../tools/app.mjs';
import { SITE } from '../assets/js/config.js';

test('app links: a shared map link opens the same map in the app', () => {
  assert.equal(sharedLanding('https://app.halfstop.app/map.html?f=63d5c6c9b3d64a02a71dc26afa17c1e3'),
    'map.html?f=63d5c6c9b3d64a02a71dc26afa17c1e3');
  assert.equal(sharedLanding('https://app.halfstop.app/map.html?p=44.703598%2C-73.601780&pn=Kent+Falls#view=14/44.70360/-73.60178'),
    'map.html?p=44.703598%2C-73.601780&pn=Kent+Falls#view=14/44.70360/-73.60178');
  assert.equal(sharedLanding('https://app.halfstop.app/map.html#view=8.46/44.3765/-73.85'), 'map.html#view=8.46/44.3765/-73.85');
});

test('app links: nothing else is taken for one', () => {
  for (const url of [
    'https://app.halfstop.app/faq.html#whats-new',
    'https://app.halfstop.app/',
    'http://app.halfstop.app/map.html?f=1',
    'https://example.com/map.html?f=1',
    'https://app.halfstop.app.example.com/map.html',
    'com.halfstop.app://account#access_token=x',
    'content://media/external/file/12',
    'not a url',
  ]) {
    assert.equal(sharedLanding(url), null, url);
  }
});

test('app links: the app follows one when Android hands it over', async () => {
  let handler = null;
  const gone = [];
  const shell = {
    plugin: (name) => (name === 'App'
      ? { addListener: (event, fn) => { if (event === 'appUrlOpen') handler = fn; }, getLaunchUrl: async () => ({}) }
      : null),
  };
  const store = { getItem: () => null, setItem() {}, removeItem() {} };
  assert.equal(watchAppLinks({ shell, store, go: (to) => gone.push(to) }), true);
  handler({ url: 'https://app.halfstop.app/map.html?f=63d5c6c9b3d64a02a71dc26afa17c1e3' });
  assert.deepEqual(gone, ['map.html?f=63d5c6c9b3d64a02a71dc26afa17c1e3']);
});

test('app links: the app asks for the map page of the site it is from, and verifies it', () => {
  const host = new URL(SITE.url).hostname;
  assert.equal(SHARED_HOST, host);
  assert.equal(APP_LINK_HOST, host);
  assert.equal(APP_LINK_PATH, '/map.html');

  const manifest = `<manifest><application><activity android:name=".MainActivity">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity></application></manifest>`;
  const { manifest: linked, added } = withAppLinks(manifest);
  assert.equal(added, true);
  assert.match(linked, /<intent-filter android:autoVerify="true">/, 'unverified, Android asks every time or opens the browser');
  assert.match(linked, /<data android:scheme="https" android:host="app\.halfstop\.app" android:pathPrefix="\/map\.html" \/>/);
  assert.match(linked, /android\.intent\.category\.BROWSABLE/);
  // Idempotent: the next build changes nothing.
  assert.deepEqual(withAppLinks(linked), { manifest: linked, added: false });
});

test('app links: every Android build writes the filter, and the website publishes /.well-known/', async () => {
  const app = await readFile(new URL('../tools/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /const shared = withAppLinks\(files\.manifest\)/);
  assert.match(app, /if \(shared\.manifest !== before\) writeFileSync\(manifestPath, shared\.manifest\)/);

  const dist = await readFile(new URL('../tools/build-dist.mjs', import.meta.url), 'utf8');
  assert.match(dist, /if \(!wantsApp && existsSync\(wellKnown\)\)/, '/.well-known/ is not published with the website');

  const deploy = await readFile(new URL('../.github/workflows/deploy-pages.yml', import.meta.url), 'utf8');
  assert.match(deploy, /Read the app links file back/, 'nothing checks the live file after a deploy');
});

test('app links: the site vouches for the app it means, by its signing key', async () => {
  const file = new URL('../.well-known/assetlinks.json', import.meta.url);
  if (!existsSync(file)) return; // Not published yet: links keep opening in the browser.
  const links = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(Array.isArray(links) && links.length > 0);
  const [entry] = links;
  assert.deepEqual(entry.relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(entry.target.namespace, 'android_app');
  const config = JSON.parse(await readFile(new URL('../capacitor.config.json', import.meta.url), 'utf8'));
  assert.equal(entry.target.package_name, config.appId);
  assert.ok(entry.target.sha256_cert_fingerprints.length > 0);
  for (const print of entry.target.sha256_cert_fingerprints) {
    assert.match(print, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, `${print} is not a SHA-256 certificate fingerprint`);
  }
});
