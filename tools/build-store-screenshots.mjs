#!/usr/bin/env node
/**
 * Screenshots for the Google Play store listing: phone, 7" and 10" tablet.
 *
 * Usage:  node tools/build-store-screenshots.mjs [site] [--only=phone,tablet-7,tablet-10]
 *
 *   site   where to photograph, default https://app.halfstop.app/ - the
 *          website is the app, so the live site is what the app shows
 *   --only the devices to take, default all three
 *
 * CHROMIUM_PATH picks the browser, for a machine where Playwright's own
 * Chromium is not installed: any Chromium will do - Chrome, Brave, Edge.
 *
 * Play asks for 16:9 or 9:16 exactly. Phone and 7" tablet screenshots are
 * 320 to 3840 pixels a side, 10" tablet ones 1080 to 7680. A device's own
 * screenshots are rarely either ratio and would need cropping by hand, so
 * these are taken in a browser the size of each device instead - see DEVICES.
 * The tablets are landscape and wider than the 820 px the map switches to its
 * phone layout at, so they show the panel beside the map rather than over it,
 * which is what somebody on a tablet actually gets.
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
 * pin. A scene that fails is reported and skipped, and the rest are taken.
 */

import { mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { OVERLAYS } from '../assets/js/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Under docs/, like the feature graphic: for Play Console, not for visitors.
// One folder per device, since Play asks for each set separately.
const OUT = path.join(ROOT, 'docs', 'store', 'screenshots');

/**
 * The devices, as a viewport in CSS pixels and a device pixel ratio. Each
 * multiplies out to an exact 9:16 or 16:9 inside Play's limits for it:
 *
 *   phone      360 x 640  at 3  = 1080 x 1920   (9:16)
 *   tablet-7   1024 x 576 at 2  = 2048 x 1152   (16:9)
 *   tablet-10  1280 x 720 at 2  = 2560 x 1440   (16:9)
 */
export const DEVICES = {
  phone: { viewport: { width: 360, height: 640 }, scale: 3, min: 320, max: 3840 },
  'tablet-7': { viewport: { width: 1024, height: 576 }, scale: 2, min: 320, max: 3840 },
  'tablet-10': { viewport: { width: 1280, height: 720 }, scale: 2, min: 1080, max: 7680 },
};

/** The pixel size a device's screenshots come out at. */
export function pixels({ viewport, scale }) {
  return { width: viewport.width * scale, height: viewport.height * scale };
}
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
    // The details open with the sections folded - over the map on a phone,
    // beside it on a tablet; unfold the one with the sun and moon in it.
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

/** One scene on one page; throws if something on the way fails. */
async function take(page, site, scene, folder) {
  await page.goto(sceneURL(site, scene), { waitUntil: 'load', timeout: 60000 });
  await settle(page, scene);

  if (scene.open) {
    // The panel starts closed at every width, but ask rather than assume:
    // the toggle closes an open one.
    if (await page.locator('#panel').isHidden()) await page.locator('#panel-toggle').click();
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

  const target = path.join(folder, scene.file);
  await page.screenshot({ path: target, type: 'png' });
  let { size } = await stat(target);
  let written = scene.file;
  if (size > MAX_BYTES) {
    // Over Play's limit as a PNG: the same picture as a JPEG instead.
    await unlink(target);
    written = scene.file.replace(/\.png$/, '.jpg');
    await page.screenshot({ path: path.join(folder, written), type: 'jpeg', quality: 90 });
    ({ size } = await stat(path.join(folder, written)));
  }
  return { written, size };
}

async function main() {
  const args = process.argv.slice(2);
  const site = args.find((arg) => !arg.startsWith('--')) || 'https://app.halfstop.app/';
  const only = (args.find((arg) => arg.startsWith('--only=')) || '').slice('--only='.length);
  const names = only ? only.split(',').map((name) => name.trim()).filter(Boolean) : Object.keys(DEVICES);
  const unknown = names.filter((name) => !DEVICES[name]);
  if (unknown.length) {
    console.error(`No such device: ${unknown.join(', ')}. The devices are ${Object.keys(DEVICES).join(', ')}.`);
    process.exitCode = 1;
    return;
  }

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const failed = [];
  try {
    for (const name of names) {
      const device = DEVICES[name];
      const size = pixels(device);
      const folder = path.join(OUT, name);
      await mkdir(folder, { recursive: true });
      console.log(`\n${name}: ${size.width} x ${size.height}, into ${path.relative(ROOT, folder)}/`);

      const context = await browser.newContext({
        viewport: device.viewport,
        deviceScaleFactor: device.scale,
        isMobile: true,
        hasTouch: true,
        colorScheme: 'light',
        locale: 'en-US',
        timezoneId: 'America/Denver',
        geolocation: STANDING,
        permissions: ['geolocation'],
      });
      for (const scene of SCENES) {
        // Said before, not only after: a scene can take half a minute while
        // the tiles settle, and silence reads as stuck.
        process.stdout.write(`  ${scene.file} ... `);
        const page = await context.newPage();
        try {
          const { written, size: bytes } = await take(page, site, scene, folder);
          console.log(`${written === scene.file ? '' : `${written}, `}${(bytes / 1048576).toFixed(1)} MB  ${scene.what}`);
        } catch (error) {
          failed.push(`${name}/${scene.file}`);
          console.log(`FAILED: ${String(error?.message || error).split('\n')[0]}`);
        } finally {
          await page.close().catch(() => {});
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  if (failed.length) {
    console.log(`\n${failed.length} did not come out: ${failed.join(', ')}. Run again, or with --only= for one device.`);
    process.exitCode = 1;
  }
  console.log('\nLook at each one before uploading: a map whose tiles did not load photographs as empty.');
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
