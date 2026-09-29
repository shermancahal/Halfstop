/**
 * The invitation to test the Android app.
 *
 * Two ways it could go wrong without anything failing: drawn inside the app
 * itself, or on an iPhone, where a Google Play link is a dead end; and a link
 * written into the pages that has drifted from the one in config.js, so the
 * banner and the roadmap send people to different places.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SITE } from '../assets/js/config.js';
import { inviteWanted } from '../assets/js/lib/app-invite.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = { url: 'https://play.google.com/store/apps/details?id=com.halfstop.app', testing: true };
const PIXEL = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';

test('app invite: shown in a browser on Android and on a computer', () => {
  assert.equal(inviteWanted({ app, userAgent: PIXEL }), true);
  assert.equal(inviteWanted({ app, userAgent: MAC }), true);
});

test('app invite: never inside the app, never on an iPhone, and not once closed', () => {
  assert.equal(inviteWanted({ app, native: true, userAgent: PIXEL }), false);
  assert.equal(inviteWanted({ app, userAgent: IPHONE }), false);
  assert.equal(inviteWanted({ app, userAgent: PIXEL, dismissed: true }), false);
});

test('app invite: stands down when the app is public, or has no link', () => {
  assert.equal(inviteWanted({ app: { ...app, testing: false }, userAgent: PIXEL }), false);
  assert.equal(inviteWanted({ app: { url: '', testing: true }, userAgent: PIXEL }), false);
  assert.equal(inviteWanted({ userAgent: PIXEL }), false);
});

test('app invite: every Google Play link on the pages is the one in config.js', async () => {
  assert.match(SITE.androidApp.url, /^https:\/\/play\.google\.com\/store\/apps\/details\?id=com\.halfstop\.app$/);
  let found = 0;
  for (const page of ['index.html', 'faq.html', 'about.html']) {
    const html = await readFile(path.join(ROOT, page), 'utf8');
    for (const [, href] of html.matchAll(/href="(https:\/\/play\.google\.com\/[^"]*)"/g)) {
      found += 1;
      assert.equal(href, SITE.androidApp.url, `${page} links to ${href}`);
    }
  }
  assert.ok(found >= 3, `expected the roadmap, the costs and the FAQ to link to Play; found ${found}`);
});
