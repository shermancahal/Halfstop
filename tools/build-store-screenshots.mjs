#!/usr/bin/env node
/**
 * Screenshots for the store listings: Google Play's phone, 7" and 10" tablet,
 * and the App Store's 6.9" iPhone and 13" iPad.
 *
 * Usage:  node tools/build-store-screenshots.mjs [site] [--only=play|apple|phone,ipad-13,...]
 *
 *   site   where to photograph, default https://app.halfstop.app/ - the
 *          website is the app, so the live site is what the app shows
 *   --only the devices to take, default all five; `play` and `apple` name
 *          each store's set
 *
 * CHROMIUM_PATH picks the browser, for a machine where Playwright's own
 * Chromium is not installed: any Chromium will do - Chrome, Brave, Edge.
 * HEADED=1 shows its windows while it works, which uses the machine's own
 * graphics rather than the hidden browser's, for when screenshots time out.
 *
 * Play asks for 16:9 or 9:16 exactly. Phone and 7" tablet screenshots are
 * 320 to 3840 pixels a side, 10" tablet ones 1080 to 7680. A device's own
 * screenshots are rarely either ratio and would need cropping by hand, so
 * these are taken in a browser the size of each device instead - see DEVICES.
 *
 * The App Store asks for exact sizes instead, from a short list per display:
 * these are the 6.9" iPhone (the 16 Pro Max's screen) and the 13" iPad, the
 * two App Store Connect requires - it scales them down for every smaller
 * device. The iPad is needed because the app runs on one, as Capacitor's
 * project is set up to.
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
import { STORAGE_KEY as FOLDERS_KEY } from '../assets/js/lib/folders.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Under docs/, like the feature graphic: for Play Console, not for visitors.
// One folder per device, since Play asks for each set separately.
const OUT = path.join(ROOT, 'docs', 'store', 'screenshots');

/**
 * The devices, as a viewport in CSS pixels and a device pixel ratio. Each
 * multiplies out to a size its store accepts:
 *
 *   phone      360 x 640   at 3  = 1080 x 1920   Play, 9:16
 *   tablet-7   1024 x 576  at 2  = 2048 x 1152   Play, 16:9
 *   tablet-10  1280 x 720  at 2  = 2560 x 1440   Play, 16:9
 *   iphone-6.9 440 x 956   at 3  = 1320 x 2868   App Store, 6.9" display
 *   ipad-13    1024 x 1366 at 2  = 2048 x 2732   App Store, 13" display
 *
 * The iPad is portrait and 1024 wide, past the 820 px the map switches to
 * its phone layout at, so it shows the panel beside the map as an iPad does.
 */
export const DEVICES = {
  phone: { store: 'play', viewport: { width: 360, height: 640 }, scale: 3, min: 320, max: 3840 },
  'tablet-7': { store: 'play', viewport: { width: 1024, height: 576 }, scale: 2, min: 320, max: 3840 },
  'tablet-10': { store: 'play', viewport: { width: 1280, height: 720 }, scale: 2, min: 1080, max: 7680 },
  'iphone-6.9': { store: 'apple', viewport: { width: 440, height: 956 }, scale: 3 },
  'ipad-13': { store: 'apple', viewport: { width: 1024, height: 1366 }, scale: 2 },
};

/**
 * The portrait sizes App Store Connect takes for each display, from Apple's
 * screenshot specifications. Anything else is refused at upload, so the
 * devices above are checked against these in the tests.
 */
export const APPLE_SIZES = {
  'iphone-6.9': [[1260, 2736], [1290, 2796], [1320, 2868]],
  'ipad-13': [[2064, 2752], [2048, 2732]],
};

/**
 * The devices `--only` names: a device, or a store's whole set. A name that
 * is neither comes back as it is, for the caller to report.
 */
export function devicesFor(only = '') {
  const names = String(only).split(',').map((name) => name.trim()).filter(Boolean);
  if (!names.length) return Object.keys(DEVICES);
  const out = [];
  for (const name of names) {
    const set = Object.keys(DEVICES).filter((device) => DEVICES[device].store === name);
    if (DEVICES[name]) out.push(name);
    else if (set.length) out.push(...set);
    else out.push(name);
  }
  return [...new Set(out)];
}

/** The pixel size a device's screenshots come out at. */
export function pixels({ viewport, scale }) {
  return { width: viewport.width * scale, height: viewport.height * scale };
}
// Play's limit is 8 MB; a satellite scene as PNG can come close.
const MAX_BYTES = 7.5 * 1024 * 1024;
// A screenshot waits for the page to draw a frame, which a map still
// decoding tiles can take a while to give up.
const SHOT_TIMEOUT = 60000;
// Tries per scene, each in a browser of its own.
const ATTEMPTS = 2;
// Where "From here" measures from on the pin: Jackson, Wyoming, down the
// valley from the pin, so the distance and bearing read as a real drive.
const STANDING = { latitude: 43.4799, longitude: -110.7624 };

/** The overlays that are on by default, plus `extra`, as the `o` parameter. */
function overlaysWith(extra = []) {
  const on = OVERLAYS.filter((overlay) => overlay.enabled).map((overlay) => overlay.id);
  return [...new Set([...on, ...extra])].join(',');
}

/** A saved pin, in the shape the folder store keeps one. */
const samplePin = (id, name, [lat, lon], icon, description = '') => ({
  id,
  feature: {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { kind: 'waypoint', name, icon, ...(description ? { description } : {}) },
  },
});

/**
 * A photographer's folders for a week in the Tetons, for the folders scene.
 *
 * Put in the browser's storage before the page loads, the way the app keeps
 * them, so the picture is the real Folders tab drawing real folders rather
 * than a mock-up. Nested, because folders inside folders is the thing a list
 * of pins cannot show; the places are real and roughly where they are.
 */
export const SAMPLE_FOLDERS = {
  version: 1,
  folders: [
    {
      id: 'f_tetons', name: 'Grand Teton, October', color: '#e8590c', items: [],
    },
    {
      id: 'f_sunrise', name: 'Sunrise', color: '#f59f00', parentId: 'f_tetons',
      items: [
        samplePin('i_mg0a0001_1', 'Oxbow Bend', [43.8547, -110.5883], 'photo',
          'Fog off the river until about 7:30. Moran in the water when it is still.'),
        samplePin('i_mg0a0002_2', 'Mormon Row barns', [43.6656, -110.6635], 'barn',
          'The Moulton barn faces the Tetons. First light hits the peaks before the barn.'),
        samplePin('i_mg0a0003_3', 'Schwabacher Landing', [43.7154, -110.6730], 'water',
          'Beaver ponds. Reflections best before the wind gets up.'),
      ],
    },
    {
      id: 'f_sunset', name: 'Sunset', color: '#7e22ce', parentId: 'f_tetons',
      items: [
        samplePin('i_mg0a0004_4', 'Snake River Overlook', [43.7546, -110.6228], 'viewpoint',
          'Where Ansel Adams stood. The trees have grown since.'),
        samplePin('i_mg0a0005_5', 'Signal Mountain summit', [43.8437, -110.6165], 'peak'),
        samplePin('i_mg0a0006_6', 'String Lake', [43.7862, -110.7290], 'water'),
      ],
    },
    {
      id: 'f_scouting', name: 'Scouting list', color: '#0f766e',
      items: [
        samplePin('i_mg0a0007_7', 'Jenny Lake trailhead', [43.7526, -110.7210], 'trailhead'),
        samplePin('i_mg0a0008_8', 'Taggart Lake trailhead', [43.6930, -110.7329], 'trailhead'),
      ],
    },
  ],
};

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
    // A shared pin opens its card, which fills a phone's screen: closed, so
    // the details are what is photographed. They open with the sections
    // folded - over the map on a phone, beside it on a tablet - so unfold the
    // one with the sun and moon in it.
    dismiss: true,
    open: 'details',
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
    what: 'Sky brightness: where the dark skies are, with its scale along the bottom',
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
  {
    file: '7-folders.png',
    what: 'Folders: a trip\'s places, sunrise and sunset, on the map beside them',
    params: {},
    hash: '#view=10.4/43.7750/-110.6650',
    folders: SAMPLE_FOLDERS,
    open: 'folders',
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
  if (scene.folders) {
    await page.addInitScript(([key, payload]) => {
      try { localStorage.setItem(key, payload); } catch { /* the scene shows no folders */ }
    }, [FOLDERS_KEY, JSON.stringify(scene.folders)]);
  }
  await page.goto(sceneURL(site, scene), { waitUntil: 'load', timeout: 60000 });
  await settle(page, scene);

  if (scene.dismiss) {
    // A card's own Close, so the app closes it the way a tap would.
    const close = page.locator('.maplibregl-popup button, .mapboxgl-popup button', { hasText: /^Close$/ }).first();
    if (await close.count()) await close.click();
    await page.waitForTimeout(400);
  }
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
  await page.screenshot({ path: target, type: 'png', timeout: SHOT_TIMEOUT });
  let { size } = await stat(target);
  let written = scene.file;
  if (size > MAX_BYTES) {
    // Over Play's limit as a PNG: the same picture as a JPEG instead.
    await unlink(target);
    written = scene.file.replace(/\.png$/, '.jpg');
    await page.screenshot({ path: path.join(folder, written), type: 'jpeg', quality: 90, timeout: SHOT_TIMEOUT });
    ({ size } = await stat(path.join(folder, written)));
  }
  return { written, size };
}

async function main() {
  const args = process.argv.slice(2);
  const site = args.find((arg) => !arg.startsWith('--')) || 'https://app.halfstop.app/';
  const only = (args.find((arg) => arg.startsWith('--only=')) || '').slice('--only='.length);
  const names = devicesFor(only);
  const unknown = names.filter((name) => !DEVICES[name]);
  if (unknown.length) {
    console.error(`No such device: ${unknown.join(', ')}. The devices are ${Object.keys(DEVICES).join(', ')},`
      + ' or play or apple for a store\'s set.');
    process.exitCode = 1;
    return;
  }

  const launch = () => chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: !process.env.HEADED,
  });
  const failed = [];
  for (const name of names) {
    const device = DEVICES[name];
    const size = pixels(device);
    const folder = path.join(OUT, name);
    await mkdir(folder, { recursive: true });
    console.log(`\n${name} (${device.store === 'apple' ? 'App Store' : 'Google Play'}): `
      + `${size.width} x ${size.height}, into ${path.relative(ROOT, folder)}/`);

    for (const scene of SCENES) {
      // Said before, not only after: a scene can take half a minute while
      // the tiles settle, and silence reads as stuck.
      process.stdout.write(`  ${scene.file} ... `);
      let outcome = null;
      let problem = '';
      /*
       * A browser of its own for every scene, and for every try. A map is a
       * WebGL canvas, and a browser that has drawn a couple of them - Brave,
       * hidden, on a Mac in particular - can stop producing frames, after
       * which every screenshot in it waits out its timeout. Starting clean
       * costs a second or two a scene and takes that off the table.
       */
      for (let attempt = 1; attempt <= ATTEMPTS && !outcome; attempt += 1) {
        const browser = await launch();
        try {
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
          outcome = await take(await context.newPage(), site, scene, folder);
        } catch (error) {
          problem = String(error?.message || error).split('\n')[0];
          if (attempt < ATTEMPTS) process.stdout.write('retrying ... ');
        } finally {
          await browser.close().catch(() => {});
        }
      }
      if (outcome) {
        const { written, size: bytes } = outcome;
        console.log(`${written === scene.file ? '' : `${written}, `}${(bytes / 1048576).toFixed(1)} MB  ${scene.what}`);
      } else {
        failed.push(`${name}/${scene.file}`);
        console.log(`FAILED: ${problem}`);
      }
    }
  }

  if (failed.length) {
    console.log(`\n${failed.length} did not come out: ${failed.join(', ')}. Run again, or with --only= for one `
      + 'device; if screenshots keep timing out, add HEADED=1 in front of the command.');
    process.exitCode = 1;
  }
  console.log('\nLook at each one before uploading: a map whose tiles did not load photographs as empty.');
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
