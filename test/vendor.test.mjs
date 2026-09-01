import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';

/*
 * The map library is in this repository, and the repository has to keep it
 * honest.
 *
 * Vendoring it bought the thing that matters most for a field app: the service
 * worker precaches it, so a first load with no signal draws a map. It was
 * cross-origin before and the worker touches nothing cross-origin but
 * downloaded tiles, so only the browser's own evictable HTTP cache stood
 * between the app and a blank screen. Verified by loading the built site with
 * every cross-origin request refused - it draws; the previous arrangement did
 * not get the library at all.
 *
 * Every failure mode below is silent in the source and fatal in the browser.
 */

const at = (p) => new URL(`../${p}`, import.meta.url);
const read = (p) => readFile(at(p), 'utf8');

const engine = await read('assets/js/lib/engine.js');
const declaredVersion = /const MAPLIBRE_VERSION = '([^']+)'/.exec(engine)?.[1];

test('vendor: the engine still declares which MapLibre it wants', () => {
  assert.ok(declaredVersion, 'engine.js no longer declares MAPLIBRE_VERSION');
});

/*
 * A bumped constant and an unbumped directory is a 404 on the one file without
 * which nothing draws, and nothing in the source looks wrong.
 */
test('vendor: the copy on disk is the version the engine asks for', async () => {
  const dirs = (await readdir(at('assets/vendor'), { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith('maplibre-gl-'))
    .map((e) => e.name);
  assert.deepEqual(dirs, [`maplibre-gl-${declaredVersion}`],
    'run `npm run vendor` to make assets/vendor match MAPLIBRE_VERSION');
});

test('vendor: the files the page loads are actually there, and are not stubs', async () => {
  for (const [name, least] of [['maplibre-gl.js', 500_000], ['maplibre-gl.css', 20_000]]) {
    const { size } = await stat(at(`assets/vendor/maplibre-gl-${declaredVersion}/${name}`));
    assert.ok(size > least, `${name} is ${size} bytes — too small to be the real build`);
  }
});

/*
 * BSD-3-Clause. Redistributing the build means redistributing the notice, and
 * we redistribute it on every page load now.
 */
test('vendor: the licence travels with the code it covers', async () => {
  const licence = await read(`assets/vendor/maplibre-gl-${declaredVersion}/LICENSE.txt`);
  assert.match(licence, /MapLibre contributors/);
  assert.match(licence, /Redistribution and use in source and binary forms/);
});

test('vendor: MapLibre is loaded from this origin, not from a CDN', () => {
  const sources = /const SOURCES = \{[\s\S]*?\n\};/.exec(engine)?.[0] || '';
  const maplibre = /maplibre: \{[\s\S]*?\},/.exec(sources)?.[0] || '';
  assert.ok(maplibre, 'could not find the maplibre entry in SOURCES');
  assert.doesNotMatch(maplibre, /https?:\/\//,
    'MapLibre is being fetched over the network again — the service worker cannot cache that');
  assert.match(maplibre, /assets\/vendor\/maplibre-gl-\$\{MAPLIBRE_VERSION\}/);
});

/*
 * Mapbox GL is proprietary and its terms require Mapbox to serve it. It is the
 * one thing here that must NOT be vendored, so the check runs the other way.
 */
test('vendor: Mapbox GL is still left to Mapbox to serve', () => {
  const mapbox = /mapbox: \{[\s\S]*?\},/.exec(engine)?.[0] || '';
  assert.ok(mapbox, 'could not find the mapbox entry in SOURCES');
  /*
   * Both files, checked one at a time.
   *
   * Asserting that the block merely contains api.mapbox.com somewhere passed
   * with the script vendored and only the stylesheet left remote - which is
   * exactly the half-done state this is here to catch, and it went green on
   * the first attempt.
   */
  for (const key of ['js', 'css']) {
    const url = new RegExp(`${key}: \`([^\`]*)\``).exec(mapbox)?.[1];
    assert.ok(url, `the mapbox entry has no ${key}`);
    assert.ok(url.startsWith('https://api.mapbox.com/'),
      `mapbox ${key} is "${url}" — Mapbox GL is proprietary and its terms require Mapbox to serve it`);
  }
});
