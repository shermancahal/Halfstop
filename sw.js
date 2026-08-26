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
      if (name.startsWith('abmap-') && name !== CACHE) await caches.delete(name);
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
  // Someone else's server, someone else's tiles. Not ours to store.
  if (url.origin !== self.location.origin) return;
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
