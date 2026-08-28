/**
 * Service worker: makes the site installable and usable with no network.
 *
 * Generated in part by tools/build-dist.mjs, which substitutes the build
 * fingerprint and the precache list below. Editing the placeholders by hand is
 * fine for reading; the deployed copy always has real values.
 *
 * The strategy is deliberately asymmetric, and the reason is this project's own
 * history. Twice now a deploy has "not appeared" because a browser held stale
 * HTML: filenames are content-hashed, so one cached index.html pins the entire
 * bundle at an old version, and the symptom is indistinguishable from a failed
 * deploy. A cache-first service worker would make that state permanent instead
 * of ten minutes long. So:
 *
 *   HTML and build.json   network first, always. The cache is a fallback for
 *                         when there is no network, never a shortcut when
 *                         there is one.
 *   ?v=-stamped assets    cache first. The URL changes whenever the bytes do,
 *                         so a hit is by definition the right bytes.
 *   published map data    network first, cache fallback. Small, and a stale
 *                         catalogue disagreeing with the files beside it is
 *                         its own confusing bug.
 *   everything else       cache first, filled from the network on a miss.
 *
 * Cross-origin requests are passed straight through, untouched. Basemap tiles
 * and imagery belong to Mapbox, USGS, Esri and NOAA; caching them here would be
 * an unbounded store of somebody else's data, and Mapbox's terms cover offline
 * use through their own mechanism. The offline map packs in the app are a
 * separate, deliberate thing — see assets/js/lib/offline.js.
 */

const BUILD = '__BUILD__';
const PRECACHE = [/*__PRECACHE__*/];
const CACHE = `abmap-${BUILD}`;
// Not versioned by build: this holds tiles a person chose to download, and a
// new build is no reason to make them do it again.
const TILES = 'abmap-tiles-v1';

/** The pages the app has, so an offline navigation to any of them can be answered. */
const PAGES = ['index.html', 'library.html', 'map.html'];

const scoped = (file) => new URL(file, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Individually, not addAll: addAll rejects the whole install if a single
    // entry 404s, which would leave the app with no offline support at all and
    // nothing in the console to say which file was missing.
    const results = await Promise.allSettled(
      PRECACHE.map((file) => cache.add(new Request(scoped(file), { cache: 'reload' }))),
    );
    const failed = PRECACHE.filter((_, i) => results[i].status === 'rejected');
    if (failed.length) console.warn(`[sw] ${failed.length} file(s) did not precache:`, failed);
    console.log(`[sw] build ${BUILD}: cached ${PRECACHE.length - failed.length}/${PRECACHE.length} files`);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('abmap-') && name !== CACHE && name !== TILES) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// The page asks for this when the user accepts the "a newer build is available"
// prompt. Without it a new worker sits waiting until every tab is closed, and
// the reload appears to do nothing.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});

const isCacheable = (response) => response && response.ok && response.type === 'basic';

/*
 * Whether a URL is shaped like a map tile.
 *
 * Two forms cover the catalogue: a z/x/y path, and an ArcGIS export taking a
 * bounding box. Mapbox is excluded here as well as in the downloader - their
 * terms reserve offline storage to their own SDK, so their tiles are never put
 * in this cache and there is no reason to look for them in it.
 */
function isTileURL(url) {
  if (/(^|\.)mapbox\.com$/i.test(url.hostname)) return false;
  if (/\/\d{1,2}\/\d{1,7}\/\d{1,7}(\.\w{1,5})?$/.test(url.pathname)) return true;
  return /bbox=/i.test(url.search) && /f=image|format=image/i.test(url.search);
}

async function networkFirst(request, { fallback } = {}) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (hit) return hit;
    if (fallback) {
      const page = await cache.match(fallback);
      if (page) return page;
    }
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (isCacheable(response)) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  /*
   * Someone else's tiles: served from the offline cache if they are in it,
   * never put there on the way past.
   *
   * The old rule was to leave every cross-origin request alone, which is the
   * right default and also the reason "download this region" could not exist.
   * The distinction that makes it safe is *deliberate* rather than
   * opportunistic: nothing lands in this cache except tiles someone explicitly
   * asked to keep, the page decides which sources may go in it, and this
   * worker only ever reads from it. A miss falls through to the network
   * exactly as before.
   *
   * The cache is separate from the app cache and survives a build change: it
   * holds megabytes somebody waited for, and throwing that away because the
   * app updated would be the worst moment to do it.
   */
  if (url.origin !== self.location.origin) {
    /*
     * Narrowed to things that can actually be in the tile cache.
     *
     * The first cut of this intercepted every cross-origin request, which
     * broke offline startup outright - the smoke test caught it, the app never
     * finished initialising, and the reason is that respondWith takes over the
     * request completely: a style, a token check or a worker script that would
     * have failed cleanly on its own now failed through us instead.
     *
     * Nothing but downloaded tiles is ever in this cache, so nothing but a
     * tile-shaped URL has any business being looked up in it. Everything else
     * goes back to being none of this worker's business.
     */
    if (isTileURL(url)) {
      event.respondWith((async () => {
        const cache = await caches.open(TILES);
        const hit = await cache.match(request, { ignoreVary: true });
        return hit || fetch(request);
      })());
    }
    return;
  }
  if (!url.href.startsWith(self.registration.scope)) return;

  const path = url.pathname;

  // build.json is how the running page discovers it is out of date. Serving it
  // from a cache would make the staleness check report the staleness it caused.
  if (path.endsWith('/build.json')) return;

  if (request.mode === 'navigate' || path.endsWith('.html') || path.endsWith('/')) {
    const known = PAGES.find((page) => path.endsWith(`/${page}`));
    event.respondWith(networkFirst(request, { fallback: scoped(known || 'index.html') }));
    return;
  }

  if (/\/data\/.*\.(json|geojson|gpx|kml|kmz)$/.test(path)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});
