/**
 * With no service, the app opens from what is kept on the device.
 *
 * Reported from the home-screen app on an iPhone: with no service it did not
 * open at all, so the offline maps in it could not be reached. Airplane mode
 * was always fine - a request with no signal fails at once and the cache
 * answers - and that is all the offline smoke test ever did. No service is
 * different: the phone has bars and no data, and a request hangs until the
 * system gives up. The worker only reached for the cache when the network
 * failed, so it waited, for the page and then for every module.
 *
 * These run sw.js itself, against a network that never answers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const SOURCE = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const SCOPE = 'https://app.example/';
const PATIENCE = 150;

/** sw.js in a sandbox with a fake cache and a network the test controls. */
function worker({ network }) {
  const source = SOURCE
    .replace('const PAGE_PATIENCE_MS = 3500;', `const PAGE_PATIENCE_MS = ${PATIENCE};`)
    .replace('const GLYPH_PATIENCE_MS = 5000;', `const GLYPH_PATIENCE_MS = ${PATIENCE};`);
  assert.ok(source.includes(`PAGE_PATIENCE_MS = ${PATIENCE}`) && source.includes(`GLYPH_PATIENCE_MS = ${PATIENCE}`),
    'a patience constant moved; this test no longer controls it');

  const stores = new Map();
  const keyOf = (request, ignoreSearch = false) => {
    const url = new URL(typeof request === 'string' ? request : request.url);
    if (ignoreSearch) url.search = '';
    return url.href;
  };
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const held = stores.get(name);
      return {
        async match(request, { ignoreSearch = false } = {}) {
          const want = keyOf(request, ignoreSearch);
          for (const [key, body] of held) {
            if ((ignoreSearch ? keyOf(key, true) : key) === want) return new Response(body);
          }
          return undefined;
        },
        async put(request, response) { held.set(keyOf(request), await response.text()); },
        async add(request) {
          const response = await fetch(request);
          if (!response.ok) throw new TypeError(`${response.status}`);
          held.set(keyOf(request), await response.text());
        },
        async keys() { return [...held.keys()]; },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const listeners = {};
  const fetched = [];
  const self = {
    addEventListener: (type, handler) => { listeners[type] = handler; },
    registration: { scope: SCOPE },
    location: { origin: new URL(SCOPE).origin },
    clients: { claim: async () => {} },
    skipWaiting: () => {},
  };
  const fetch = (request) => {
    fetched.push(typeof request === 'string' ? request : request.url);
    return network(request);
  };
  vm.runInNewContext(source, { self, caches, fetch, Request, Response, URL, console, setTimeout, Promise, Date });

  /** Ask the worker for a URL, as the page would; resolves with the body and how long it took. */
  const ask = async (url) => {
    let answer = null;
    const waits = [];
    listeners.fetch({
      request: new Request(url),
      respondWith: (promise) => { answer = promise; },
      waitUntil: (promise) => { waits.push(promise); },
    });
    assert.ok(answer, `the worker did not answer ${url}`);
    const started = Date.now();
    const response = await answer;
    return { body: await response.text(), ms: Date.now() - started };
  };
  const keep = async (url, body, name = 'abmap-__BUILD__') => (await caches.open(name)).put(url, new Response(body));
  /** Run an install or activate event to the end. */
  const lifecycle = async (type) => {
    const waits = [];
    listeners[type]({ waitUntil: (promise) => { waits.push(promise); } });
    await Promise.all(waits);
  };
  return { ask, keep, fetched, caches, stores, lifecycle };
}

const never = () => new Promise(() => {});

test('no service: a page kept on the device opens after a short wait, not after the network gives up', async () => {
  const sw = worker({ network: never });
  await sw.keep(`${SCOPE}index.html`, 'the home page, as kept');
  await sw.keep(`${SCOPE}map.html`, 'the map, as kept');

  const home = await sw.ask(SCOPE);
  assert.equal(home.body, 'the home page, as kept');
  assert.ok(home.ms >= PATIENCE - 20 && home.ms < PATIENCE + 500, `took ${home.ms}ms`);

  // A shared link opens the kept map, whatever its query.
  const map = await sw.ask(`${SCOPE}map.html?p=44.7,-73.6&pn=Kent+Falls`);
  assert.equal(map.body, 'the map, as kept');
});

test('no service: the rest of that page load comes from the device at once', async () => {
  const sw = worker({ network: never });
  await sw.keep(`${SCOPE}map.html`, 'the map, as kept');
  await sw.keep(`${SCOPE}assets/js/lib/folders.js`, 'export const kept = true;');
  await sw.keep(`${SCOPE}data/catalog.json`, '{"maps":[]}');

  await sw.ask(`${SCOPE}map.html`);
  // Unstamped modules and the catalogue are network first; with no service
  // each would have waited for the network. During the spell they do not.
  const module = await sw.ask(`${SCOPE}assets/js/lib/folders.js`);
  assert.equal(module.body, 'export const kept = true;');
  assert.ok(module.ms < 100, `a module waited ${module.ms}ms for a network that is not there`);
  const catalog = await sw.ask(`${SCOPE}data/catalog.json`);
  assert.equal(catalog.body, '{"maps":[]}');
  assert.ok(catalog.ms < 100);
});

test('a network that answers in time is still used, and ends the spell', async () => {
  let online = false;
  const sw = worker({
    network: async (request) => {
      if (!online) return never();
      return new Response(`fresh ${new URL(request.url).pathname}`);
    },
  });
  await sw.keep(`${SCOPE}map.html`, 'the map, as kept');
  await sw.keep(`${SCOPE}assets/js/lib/folders.js`, 'kept module');

  await sw.ask(`${SCOPE}map.html`);
  online = true;
  const page = await sw.ask(`${SCOPE}map.html`);
  assert.equal(page.body, 'fresh /map.html', 'a page the network answered in time came from the cache');
  const module = await sw.ask(`${SCOPE}assets/js/lib/folders.js`);
  assert.equal(module.body, 'fresh /assets/js/lib/folders.js', 'the spell outlived the network coming back');
});

test('a page with nothing kept waits for the network rather than failing', async () => {
  const sw = worker({
    network: () => new Promise((resolve) => { setTimeout(() => resolve(new Response('slow but here')), PATIENCE * 3); }),
  });
  const page = await sw.ask(`${SCOPE}faq.html`);
  assert.equal(page.body, 'slow but here');
});

test('airplane mode is as it was: the network fails at once and the cache answers', async () => {
  const sw = worker({ network: async () => { throw new TypeError('Failed to fetch'); } });
  await sw.keep(`${SCOPE}faq.html`, 'the help page, as kept');
  const page = await sw.ask(`${SCOPE}faq.html`);
  assert.equal(page.body, 'the help page, as kept');
  assert.ok(page.ms < 100, `took ${page.ms}ms with the network already known to be down`);
});

/* ------------------------------------------------------ the map's lettering */

const GLYPH = 'https://protomaps.github.io/basemaps-assets/fonts/Noto%20Sans%20Regular/0-255.pbf';

test('lettering: kept for good, and read from the device first', async () => {
  const sw = worker({ network: never });
  await sw.keep(GLYPH, 'letters', 'abmap-glyphs-v1');
  const glyph = await sw.ask(GLYPH);
  assert.equal(glyph.body, 'letters');
  assert.ok(glyph.ms < 100, `kept lettering waited ${glyph.ms}ms for a network`);
});

test('lettering: with no service a tile draws without it rather than waiting', async () => {
  const sw = worker({ network: never });
  let status = 0;
  const started = Date.now();
  // ask() reads the body; a 504 has none, which is the point.
  const result = await sw.ask(GLYPH.replace('0-255', '19968-20223'));
  status = result.body === '' ? 504 : 200;
  assert.equal(status, 504);
  assert.ok(Date.now() - started < PATIENCE + 500);
});

test('lettering: fetched once online, it is there offline', async () => {
  let online = true;
  const sw = worker({ network: async () => (online ? new Response('fetched letters') : never()) });
  assert.equal((await sw.ask(GLYPH)).body, 'fetched letters');
  online = false;
  assert.equal((await sw.ask(GLYPH)).body, 'fetched letters');
});

test('lettering: the common ranges are kept as the worker installs, and survive a new build', async () => {
  const sw = worker({ network: async (request) => new Response(`range ${new URL(request.url).pathname}`) });
  await sw.lifecycle('install');
  const kept = await (await sw.caches.open('abmap-glyphs-v1')).keys();
  assert.equal(kept.length, 12, `kept ${kept.length} ranges`);
  assert.ok(kept.includes(GLYPH));
  assert.ok(kept.some((url) => url.includes('Noto%20Sans%20Medium/8192-8447.pbf')));

  // A new build sweeps the old app cache, and leaves lettering and tiles.
  await sw.keep('https://app.example/old.js', 'old', 'abmap-oldbuild');
  await sw.keep('https://tiles.example/1/2/3.png', 'tile', 'abmap-tiles-v1');
  await sw.lifecycle('activate');
  assert.deepEqual([...sw.stores.keys()].sort(), ['abmap-__BUILD__', 'abmap-glyphs-v1', 'abmap-tiles-v1']);
});

test('lettering: the worker keeps the fonts the style draws with, from where it draws them', async () => {
  const { PROTOMAPS_SCHEMA } = await import('../assets/js/lib/byways-style.js');
  const base = /const GLYPHS_BASE = '([^']+)'/.exec(SOURCE)?.[1];
  assert.ok(PROTOMAPS_SCHEMA.glyphs().startsWith(base), 'the style reads lettering from somewhere the worker does not keep');
  const fonts = JSON.parse(/const GLYPH_FONTS = (\[[^\]]*\])/.exec(SOURCE)?.[1].replace(/'/g, '"') || '[]');
  assert.deepEqual(fonts.sort(), [...PROTOMAPS_SCHEMA.font, ...PROTOMAPS_SCHEMA.fontBold].sort());

  const pwa = await readFile(new URL('../assets/js/lib/pwa.js', import.meta.url), 'utf8');
  assert.match(pwa, /KEPT_GLYPHS = 'abmap-glyphs-v1'/, 'removing a worker would take the lettering with it');
});

test('the map adds folders and pins once its style is ready, not once every tile has come', async () => {
  const viewer = await readFile(new URL('../assets/js/viewer.js', import.meta.url), 'utf8');
  const wait = viewer.slice(viewer.indexOf('function waitForStyle'), viewer.indexOf('function waitForStyle') + 1800);
  assert.match(wait, /once\('style\.load'/);
});
