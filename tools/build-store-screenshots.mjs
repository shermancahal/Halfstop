#!/usr/bin/env node
/**
 * Phone screenshots for the Google Play store listing.
 *
 * Usage:  node tools/build-store-screenshots.mjs [site]
 *
 *   site   where to photograph, default https://app.halfstop.app/ - the
 *          website is the app, so the live site is what the app shows
 *
 * Play asks for 9:16 exactly, each side between 320 and 3840 pixels. A phone's
 * own screenshots are taller than that (20:9 and up) and would need cropping
 * by hand, so these are taken in a phone-sized Chromium instead: 360 x 640 at
 * three device pixels to the CSS pixel, which is 1080 x 1920 - the size of a
 * Pixel-class screen, and 9:16 to the pixel.
 *
 * Run it on a machine that can reach the map tiles - the Mac, not a sandbox
 * that cannot - because a screenshot of a map whose tiles failed is an empty
 * beige rectangle with buttons on it, and nothing here can tell the
 * difference. Look at every one before uploading.
 *
 * Each scene is a link, not a sequence of taps, so one that comes out wrong
 * can be changed on its own: the view is the `#view=zoom/lat/lon` the map
 * writes into the address bar, and the rest is what writeURL() in viewer.js
 * writes - `b` the basemap, `o` the visible overlays, `p` and `pn` a shared
 * pin.
 */

import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { OVERLAYS } from '../assets/js/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Under docs/, like the feature graphic: for Play Console, not for visitors.
const OUT = path.join(ROOT, 'docs', 'store', 'screenshots');

export const VIEWPORT = { width: 360, height: 640 };
export const SCALE = 3;
// Play's limit is 8 MB; a satellite scene as PNG can come close.
const MAX_BYTES = 7.5 * 1024 * 1024;
// Where "From here" measures from on the pin: Jackson, Wyoming, down the
// valley from the pin, so the distance and bearing read as a real drive.
const STANDING = { latitude: 43.4799, longitude: -110.7624 };

/** The overlays that are on by default, plus `extra`, as the `o` parameter. */
function overlaysWith(extra = []) {
  const on = OVERLAYS.filter((overlay) => overlay.enabled).map((overlay) => overlay.id);
  return [...new Set([...on, ...extra])].join(',');
}

/**
 * The scenes, in the order the listing shows them. Play shows the first two
 * or three before anybody scrolls, so they carry the pitch: the map, the
 * light, the land.
 */
export const SCENES = [
  {
    file: '1-map.png',
    what: 'The map: the Tetons on the house topographic basemap',
    params: {},
    hash: '#view=11.5/43.7600/-110.7300',
  },
  {
    file: '2-light.png',
    what: 'A pin: sunrise, sunset, golden and blue hour, the moon, from here',
    params: { p: '43.854700,-110.588300', pn: 'Oxbow Bend' },
    hash: '#view=13/43.85470/-110.58830',
    // The details open over the map on a phone, with the sections folded;
    // unfold the one with the sun and moon in it.
    expand: ['Photography'],
    ready: 'text=Sunrise',
  },
  {
    file: '3-public-land.png',
    what: 'Public land: BLM, national park and state trust land around Moab',
    params: { b: 'usgs-topo', o: overlaysWith(['public-lands']) },
    hash: '#view=10/38.6200/-109.6000',
  },
  {
    file: '4-night-sky.png',
    what: 'Sky brightness: where the dark skies are',
    params: { o: overlaysWith(['sky-brightness']) },
    hash: '#view=5.6/39.2000/-111.2000',
  },
  {
    file: '5-satellite.png',
    what: 'Satellite imagery: Horseshoe Bend',
    params: { b: 'esri-imagery' },
    hash: '#view=15.2/36.8790/-111.5105',
  },
  {
    file: '6-layers.png',
    what: 'The layers: basemaps and overlays',
    params: {},
    hash: '#view=9/38.5700/-109.5500',
    open: 'layers',
  },
];

/** The address of one scene on `site`. */
export function sceneURL(site, scene) {
  const url = new URL('map.html', site);
  url.search = new URLSearchParams(scene.params).toString();
  url.hash = scene.hash;
  return url.href;
}

async function settle(page, scene) {
  // Tiles stream in for a while after load; wait for the network to go
  // quiet, but not forever - a server that keeps a request open would hold
  // this to its timeout on every scene.
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  // Fades, label placement, the last raster tiles decoding.
  await page.waitForTimeout(2500);
}

async function main() {
  const site = process.argv[2] || 'https://app.halfstop.app/';
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      isMobile: true,
      hasTouch: true,
      colorScheme: 'light',
      locale: 'en-US',
      timezoneId: 'America/Denver',
      geolocation: STANDING,
      permissions: ['geolocation'],
    });

    for (const scene of SCENES) {
      const page = await context.newPage();
      const url = sceneURL(site, scene);
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await settle(page, scene);

      if (scene.open) {
        await page.locator('#panel-toggle').click();
        await page.locator(`.panel-tab[data-tab="${scene.open}"]`).click();
        await page.waitForTimeout(800);
      }
      for (const title of scene.expand || []) {
        const summary = page.locator('summary.detail-block-summary', { hasText: title }).first();
        await summary.click();
        if (scene.ready) await page.locator(scene.ready).first().waitFor({ timeout: 15000 }).catch(() => {});
        // Up to the top of the panel, so the times fill the picture rather
        // than starting at the bottom edge of it.
        await summary.evaluate((node) => node.scrollIntoView({ block: 'start' }));
        await page.waitForTimeout(800);
      }
      // Whatever was last clicked or opened keeps a focus ring, which in a
      // still picture reads as something highlighted on purpose.
      await page.evaluate(() => document.activeElement?.blur?.());

      const target = path.join(OUT, scene.file);
      await page.screenshot({ path: target, type: 'png' });
      let { size } = await stat(target);
      let written = scene.file;
      if (size > MAX_BYTES) {
        // Over Play's limit as a PNG: the same picture as a JPEG instead.
        written = scene.file.replace(/\.png$/, '.jpg');
        await page.screenshot({ path: path.join(OUT, written), type: 'jpeg', quality: 90 });
        ({ size } = await stat(path.join(OUT, written)));
      }
      console.log(`${written}  ${(size / 1048576).toFixed(1)} MB  ${scene.what}`);
      await page.close();
    }
    console.log(`\n${SCENES.length} screenshots, ${VIEWPORT.width * SCALE} x ${VIEWPORT.height * SCALE}, in ${path.relative(ROOT, OUT)}/`);
    console.log('Look at each one before uploading: a map whose tiles did not load photographs as empty.');
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
