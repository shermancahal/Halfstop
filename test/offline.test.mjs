/**
 * Tests for offline region definition.
 *
 * The tile counter is the piece that has to be right: it is the number a person
 * uses to decide whether a download will finish before they leave, and it is
 * wrong in a way nobody notices until the download stops halfway. The y-axis
 * inversion in the XYZ scheme and the antimeridian are the two places it
 * silently returns nonsense, so both are pinned here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BASEMAPS } from '../assets/js/config.js';
import {
  MAX_ZOOM, TILE_BUDGET, OfflineStore,
  normalizeBounds, crossesAntimeridian, tileRange, countTiles,
  estimateBytes, formatBytes, areaKm2,
  createRegion, measureRegion, regionDefinition, buildManifest, regionsToGeoJSON,
  tieredPlan,
  countTieredTiles,
  mayCacheTiles, tileURLsFor, downloadTiles, clearTiles,
  REGION_MAX_KM2, regionSizeProblem,
} from '../assets/js/lib/offline.js';

// The Cherokee National Forest, roughly — the ground this app was built for.
const SMOKIES = { west: -84.5, south: 35.4, east: -83.6, north: 36.0 };

const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
};

/* ------------------------------------------------------------------ bounds */

test('bounds: accepts the array form, the object form and a live LngLatBounds', () => {
  const expected = { west: -84.5, south: 35.4, east: -83.6, north: 36.0 };

  assert.deepEqual(normalizeBounds([-84.5, 35.4, -83.6, 36.0]), expected);
  assert.deepEqual(normalizeBounds([[-84.5, 35.4], [-83.6, 36.0]]), expected);
  assert.deepEqual(normalizeBounds(SMOKIES), expected);
  assert.deepEqual(normalizeBounds({
    getWest: () => -84.5, getSouth: () => 35.4, getEast: () => -83.6, getNorth: () => 36.0,
  }), expected);
});

test('bounds: latitudes clamp to the Web Mercator limit rather than going infinite', () => {
  const box = normalizeBounds({ west: -10, south: -90, east: 10, north: 90 });
  assert.ok(box.north <= 85.0512 && box.south >= -85.0512);
  assert.ok(Number.isFinite(countTiles(box, 0, 2)), 'a pole-to-pole box must still count');
});

test('bounds: an inverted box is corrected, not rejected', () => {
  const box = normalizeBounds({ west: -84, south: 36, east: -83, north: 35 });
  assert.equal(box.south, 35);
  assert.equal(box.north, 36);
});

test('bounds: nonsense returns null instead of a box of NaN', () => {
  assert.equal(normalizeBounds(null), null);
  assert.equal(normalizeBounds({ west: 'x', south: 1, east: 2, north: 3 }), null);
  assert.equal(normalizeBounds([1, 2, 3]), null);
});

/* ------------------------------------------------------------------ tiles */

test('tiles: the world is one tile at z0 and four at z1', () => {
  const world = { west: -180, south: -85, east: 180, north: 85 };
  assert.equal(countTiles(world, 0, 0), 1);
  assert.equal(countTiles(world, 1, 1), 4);
  assert.equal(countTiles(world, 0, 2), 1 + 4 + 16);
});

test('tiles: north is the smaller y index, which is the easy thing to get backwards', () => {
  const range = tileRange(SMOKIES, 10);
  assert.ok(range.minY < range.maxY, 'the north edge must produce the lower y');
  assert.ok(range.minX < range.maxX);
  assert.ok(range.maxY - range.minY >= 0);
});

test('tiles: each zoom level costs about four times the one below it', () => {
  const low = countTiles(SMOKIES, 12, 12);
  const high = countTiles(SMOKIES, 13, 13);
  const ratio = high / low;
  assert.ok(ratio > 3 && ratio < 5, `expected roughly 4x, got ${ratio.toFixed(2)}`);
});

test('tiles: a box crossing the antimeridian counts both halves', () => {
  // The Aleutians. Naively this box is 359 degrees wide and counts the whole
  // planet; correctly it is one degree wide and counts almost nothing.
  const attu = { west: 179.5, south: 52.7, east: -179.5, north: 53.0 };
  assert.equal(crossesAntimeridian(attu), true);

  const crossing = countTiles(attu, 0, 8);
  const wholeWorld = countTiles({ west: -180, south: -85, east: 180, north: 85 }, 0, 8);
  assert.ok(crossing < wholeWorld / 100, `a one-degree box should not cost the planet (${crossing})`);
});

test('tiles: the zoom cap is enforced however it is asked for', () => {
  assert.equal(MAX_ZOOM, 14);
  assert.equal(countTiles(SMOKIES, 8, 22), countTiles(SMOKIES, 8, MAX_ZOOM), 'z22 must clamp to the cap');
  assert.equal(countTiles(SMOKIES, 14, 8), 0, 'a backwards range is empty, not negative');
});

test('tiles: a realistic trip region lands in a plausible range', () => {
  // Half a degree of Tennessee at z8-13 — the numbers on screen have to be
  // believable or the whole estimate is decoration.
  const tiles = countTiles(SMOKIES, 8, 13);
  assert.ok(tiles > 100 && tiles < 6000, `got ${tiles}`);
});

/* ------------------------------------------------------------------ size */

test('size: the estimate scales with tiles and vector runs heavier than raster', () => {
  assert.ok(estimateBytes(100, 'vector') > estimateBytes(100, 'raster'));
  assert.equal(estimateBytes(200, 'raster'), 2 * estimateBytes(100, 'raster'));
  assert.equal(estimateBytes(0, 'raster'), 0);
});

test('size: bytes read as bytes, not as a number nobody can parse', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.match(formatBytes(1024 * 900), /KB$/);
  assert.match(formatBytes(1024 ** 2 * 4), /MB$/);
  assert.match(formatBytes(1024 ** 3 * 2), /GB$/);
});

test('area: a degree box is about the right number of square kilometres', () => {
  // 1° x 1° at 35°N is roughly 111 x 91 km.
  const area = areaKm2({ west: -84, south: 35, east: -83, north: 36 });
  assert.ok(area > 9000 && area < 11500, `got ${Math.round(area)} km2`);
});

/* ------------------------------------------------------------------ regions */

test('region: zooms clamp to the cap and cannot invert', () => {
  const region = createRegion({ name: 'Cherokee', bounds: SMOKIES, minZoom: 9, maxZoom: 20 });
  assert.equal(region.maxZoom, MAX_ZOOM);

  const backwards = createRegion({ bounds: SMOKIES, minZoom: 12, maxZoom: 6 });
  assert.ok(backwards.maxZoom >= backwards.minZoom, 'max must never fall below min');
});

test('region: an unusable box makes no region at all', () => {
  assert.equal(createRegion({ name: 'Nowhere', bounds: null }), null);
});

test('region: going over the Mapbox ceiling is flagged before the download, not after', () => {
  const big = createRegion({ bounds: { west: -125, south: 25, east: -66, north: 49 }, minZoom: 0, maxZoom: 14 });
  const measure = measureRegion(big);
  assert.ok(measure.tiles > TILE_BUDGET);
  assert.equal(measure.overBudget, true);

  const small = createRegion({ bounds: SMOKIES, minZoom: 10, maxZoom: 12 });
  assert.equal(measureRegion(small).overBudget, false);
});

/* ------------------------------------------------------------------ export */

test('export: the definition matches what the mobile SDKs take', () => {
  // Both OfflineTilePyramidRegionDefinition and MGLTilePyramidOfflineRegion
  // want exactly these five fields; getting the shape wrong here means the app
  // has to translate, which defeats defining regions in the browser at all.
  const region = createRegion({ bounds: SMOKIES, minZoom: 8, maxZoom: 13 });
  const definition = regionDefinition(region, { styleURL: 'mapbox://styles/mapbox/outdoors-v12' });

  assert.deepEqual(Object.keys(definition).sort(), ['bounds', 'maxZoom', 'minZoom', 'pixelRatio', 'styleURL']);
  assert.deepEqual(definition.bounds.sw, [-84.5, 35.4], 'sw is [lon, lat]');
  assert.deepEqual(definition.bounds.ne, [-83.6, 36.0]);
  assert.equal(definition.minZoom, 8);
  assert.equal(definition.maxZoom, 13);
});

test('export: the manifest carries the estimate alongside each definition', () => {
  const regions = [createRegion({ name: 'Cherokee', bounds: SMOKIES, basemapName: 'USGS Topo' })];
  const manifest = buildManifest(regions, { styleURL: 'mapbox://styles/mapbox/outdoors-v12' });

  assert.equal(manifest.format, 'american-byways-offline');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.maxZoom, MAX_ZOOM);
  assert.equal(manifest.regions.length, 1);
  assert.equal(manifest.regions[0].name, 'Cherokee');
  assert.equal(manifest.regions[0].basemap, 'USGS Topo');
  assert.ok(manifest.regions[0].estimate.tiles > 0);
  assert.ok(manifest.regions[0].definition.styleURL.startsWith('mapbox://'));
});

test('export: region outlines are closed rings, and a crossing region becomes two', () => {
  const one = createRegion({ bounds: SMOKIES });
  const ring = regionsToGeoJSON([one]).features[0].geometry.coordinates[0];
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring[4], 'the ring must close');

  const attu = createRegion({ bounds: { west: 179.5, south: 52.7, east: -179.5, north: 53.0 } });
  assert.equal(regionsToGeoJSON([attu]).features.length, 2, 'a crossing box draws as two');
});

/* ------------------------------------------------------------------ store */

test('store: regions persist across a reload', () => {
  const storage = memoryStorage();
  const first = new OfflineStore({ storage });
  first.add({ name: 'Cherokee', bounds: SMOKIES, minZoom: 9, maxZoom: 13 });

  const reloaded = new OfflineStore({ storage });
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.list()[0].name, 'Cherokee');
  assert.equal(reloaded.list()[0].maxZoom, 13);
});

test('store: a corrupt entry costs that entry, not every region', () => {
  const storage = memoryStorage();
  storage.setItem('ab-maps-offline-v1', JSON.stringify([
    { id: 'good', name: 'Kept', bounds: SMOKIES, minZoom: 8, maxZoom: 12 },
    { id: 'bad', name: 'Dropped', bounds: { west: 'x' } },
  ]));

  const store = new OfflineStore({ storage });
  assert.deepEqual(store.list().map((r) => r.name), ['Kept']);
});

test('store: unparseable storage does not take the app down with it', () => {
  const storage = memoryStorage();
  storage.setItem('ab-maps-offline-v1', 'not json at all');
  assert.deepEqual(new OfflineStore({ storage }).list(), []);
});

test('store: updates clamp the same way creation does', () => {
  const store = new OfflineStore({ storage: memoryStorage() });
  const region = store.add({ name: 'Cherokee', bounds: SMOKIES, minZoom: 8, maxZoom: 12 });

  store.update(region.id, { maxZoom: 19 });
  assert.equal(store.get(region.id).maxZoom, MAX_ZOOM);

  store.update(region.id, { minZoom: 14, maxZoom: 10 });
  assert.ok(store.get(region.id).maxZoom >= store.get(region.id).minZoom);
});

test('store: removing reports whether it removed anything', () => {
  const store = new OfflineStore({ storage: memoryStorage() });
  const region = store.add({ name: 'Cherokee', bounds: SMOKIES });
  assert.equal(store.remove('no-such-id'), false);
  assert.equal(store.remove(region.id), true);
  assert.equal(store.list().length, 0);
});

test('store: the budget applies to every region together, not one at a time', () => {
  // Mapbox's ceiling is per account. Two regions each comfortably under it can
  // still fail as a pair, so the total is what the panel has to warn on.
  const store = new OfflineStore({ storage: memoryStorage() });
  store.add({ name: 'A', bounds: SMOKIES, minZoom: 8, maxZoom: 13 });
  store.add({ name: 'B', bounds: { west: -110, south: 38, east: -109, north: 39 }, minZoom: 8, maxZoom: 13 });

  const total = store.totalTiles();
  assert.ok(total > measureRegion(store.list()[0]).tiles, 'the total must include both');
});

test('store: change fires on every mutation, so the panel stays honest', () => {
  const store = new OfflineStore({ storage: memoryStorage() });
  let changes = 0;
  store.addEventListener('change', () => { changes += 1; });

  const region = store.add({ name: 'Cherokee', bounds: SMOKIES });
  store.update(region.id, { name: 'Renamed' });
  store.remove(region.id);
  assert.equal(changes, 3);
});

/*
 * The tiered download.
 *
 * A contiguous pyramid spends almost everything on the top level, covering
 * ground nobody will look at closely. These fix the shape that replaces it:
 * broad and middle over the whole region, street level only where the saved
 * points are.
 */
const TIER_BOX = { west: -84.6, south: 35.6, east: -83.9, north: 36.2 };
const PINS = [[-84.28, 35.96], [-84.1, 36.05], [-84.5, 35.7]];

test('tiered: the close zoom follows the waypoints, not the region', () => {
  const plan = tieredPlan(TIER_BOX, PINS);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map((tier) => tier.zoom), [8, 11, 14]);
  assert.equal(plan[0].boxes.length, 1, 'broad covers the region');
  assert.equal(plan[1].boxes.length, 1, 'mid covers the region');
  assert.equal(plan[2].boxes.length, PINS.length, 'close covers one box per pin');
});

test('tiered: it is dramatically cheaper than the same range in full', () => {
  /*
   * The whole argument for the feature, asserted rather than claimed. If a
   * change ever makes this merely a bit cheaper, the trade stops being worth
   * the complexity and somebody should know.
   */
  const full = countTiles(TIER_BOX, 8, 14);
  const tiered = countTieredTiles(tieredPlan(TIER_BOX, PINS));
  assert.ok(tiered * 10 < full, `tiered ${tiered} should be far under full ${full}`);
});

test('tiered: overlapping waypoint boxes are not billed twice', () => {
  // Two pins a few hundred metres apart share most of their tiles. Summing
  // rectangles would count those twice and overstate the download to somebody
  // deciding whether to press it on hotel wifi.
  const together = countTieredTiles(tieredPlan(TIER_BOX, [[-84.28, 35.96], [-84.281, 35.961]]));
  const apart = countTieredTiles(tieredPlan(TIER_BOX, [[-84.28, 35.96], [-84.0, 36.1]]));
  assert.ok(together < apart, 'two pins on top of each other cost less than two far apart');
});

test('tiered: the close box is the same distance on the ground at any latitude', () => {
  /*
   * A degree of longitude shrinks towards the poles and a degree of latitude
   * does not. Using one number for both would quietly give an Alaskan pin half
   * the east-west coverage of a Texan one, which nobody would notice until
   * they were standing in it.
   */
  const at = (lat) => {
    const [box] = tieredPlan({ west: -150, south: lat - 1, east: -148, north: lat + 1 },
      [[-149, lat]])[2].boxes;
    return { lon: box.east - box.west, lat: box.north - box.south };
  };
  const south = at(30);
  const north = at(65);

  assert.ok(Math.abs(south.lat - north.lat) < 1e-9, 'latitude span does not vary');
  assert.ok(north.lon > south.lon * 1.5, 'longitude span widens towards the pole');
});

test('tiered: no waypoints means no close tier rather than an empty one', () => {
  // A region saved before anything was pinned. Two tiers is the honest answer;
  // a third with no boxes in it would render as a zoom level that downloads
  // nothing.
  const plan = tieredPlan(TIER_BOX, []);
  assert.equal(plan.length, 2);
  assert.ok(countTieredTiles(plan) > 0);
});

test('tiered: rubbish in is null or zero, never a throw', () => {
  assert.equal(tieredPlan(null), null);
  assert.equal(tieredPlan({ west: 'x' }), null);
  assert.equal(countTieredTiles(null), 0);
  assert.equal(countTieredTiles([]), 0);
  // A pin with a missing or non-numeric coordinate is skipped, not plotted at
  // the origin — which is in the Atlantic.
  assert.equal(tieredPlan(TIER_BOX, [[NaN, 35], null, [-84.28, 35.96]])[2].boxes.length, 1);
});


/* ------------------------------------------------- downloading tiles */

const fill = (template, tile) => String(template)
  .replace('{z}', tile.z).replace('{x}', tile.x).replace('{y}', tile.y);

test('offline: Mapbox tiles are not ours to keep', () => {
  /*
   * A licensing line, not a technical one. Mapbox reserve offline storage of
   * their tiles to their own SDK's offline API, and this is Mapbox GL JS in a
   * webview rather than that SDK.
   */
  assert.equal(mayCacheTiles('https://api.mapbox.com/v4/x/{z}/{x}/{y}.png'), false);
  assert.equal(mayCacheTiles('https://a.tiles.mapbox.com/v4/{z}/{x}/{y}.png'), false);

  // A deny list rather than an allow list, so a state layer added tomorrow is
  // downloadable without anyone remembering to permit it.
  assert.equal(mayCacheTiles('https://basemap.nationalmap.gov/arcgis/x/tile/{z}/{y}/{x}'), true);
  assert.equal(mayCacheTiles('https://gis.blm.gov/arcgis/x/MapServer/tile/{z}/{y}/{x}'), true);

  /*
   * The OSM community servers are excluded for a different reason: nothing
   * forbids it, but their usage policy asks bulk downloaders to run their own,
   * and pulling four thousand tiles to fill a phone is what it asks people not
   * to do.
   */
  assert.equal(mayCacheTiles('https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png'), false);
  assert.equal(mayCacheTiles('https://tile.openstreetmap.org/{z}/{x}/{y}.png'), false);

  // Not a host that merely contains the word.
  assert.equal(mayCacheTiles('https://mapbox.com.example.org/{z}/{x}/{y}.png'), true);
  assert.equal(mayCacheTiles('http://insecure.example.gov/{z}/{x}/{y}.png'), false);
  assert.equal(mayCacheTiles('nonsense'), false);
});

test('offline: a tile wanted twice is fetched once', () => {
  // Two tiers over the same ground: the second must not re-bill tiles the
  // first already counted, because the number goes to somebody deciding
  // whether to press download on a hotel wifi.
  const tiers = [
    { zoom: 8, boxes: [SMOKIES] },
    { zoom: 8, boxes: [SMOKIES] },
  ];
  const urls = tileURLsFor(tiers, ['https://example.gov/{z}/{x}/{y}.png'], fill);
  assert.equal(urls.length, new Set(urls).size, 'the list is already a set');
  assert.equal(urls.length, countTiles(SMOKIES, 8, 8));

  // A source that may not be cached contributes nothing, rather than being
  // fetched and then quietly discarded.
  const mixed = tileURLsFor(tiers, [
    'https://example.gov/{z}/{x}/{y}.png',
    'https://api.mapbox.com/{z}/{x}/{y}.png',
  ], fill);
  assert.equal(mixed.length, urls.length);
});

test('offline: one dead tile does not lose the region', async () => {
  const stored = new Map();
  const cache = {
    async match(url) { return stored.get(String(url)) || undefined; },
    async put(url, response) { stored.set(String(url), response); },
  };
  const store = { open: async () => cache, delete: async () => true };

  const urls = ['https://e.gov/a', 'https://e.gov/gone', 'https://e.gov/b'];
  globalThis.fetch = async (url) => (String(url).endsWith('/gone')
    ? { ok: false, status: 404 }
    : { ok: true, status: 200 });

  const seen = [];
  const result = await downloadTiles(urls, {
    caches: store, concurrency: 2, onProgress: (done, failed) => seen.push([done, failed]),
  });

  // The other two are kept. A region is thousands of tiles and one 404 at the
  // edge of a service's coverage must not throw away the rest.
  assert.deepEqual(result, { done: 2, failed: 1, cancelled: false });
  assert.equal(stored.size, 2);
  assert.ok(seen.length >= 3, 'progress is reported per tile, not at the end');

  // A second run over the same list re-fetches nothing.
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; return { ok: true, status: 200 }; };
  const again = await downloadTiles(urls, { caches: store, concurrency: 2 });
  assert.equal(fetched, 1, 'only the one that failed last time is asked for again');
  assert.equal(again.done, 3);

  assert.equal(await clearTiles('abmap-tiles-v1', store), true);
});

test('offline: cancelling stops the download where it stands', async () => {
  const stored = new Map();
  const store = {
    open: async () => ({
      async match() { return undefined; },
      async put(url, response) { stored.set(String(url), response); },
    }),
  };
  const controller = new AbortController();
  globalThis.fetch = async () => {
    // Cancel once the first tile is in, so the abort lands mid-run rather than
    // before it starts - the case where a half-finished download has to stop.
    if (stored.size >= 1) controller.abort();
    return { ok: true, status: 200 };
  };

  const urls = Array.from({ length: 40 }, (_, i) => `https://e.gov/${i}`);
  const result = await downloadTiles(urls, { caches: store, concurrency: 1, signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.ok(result.done < urls.length, 'it stopped rather than running to the end');
});


test('offline: a vector basemap has no raster stand-in to download', () => {
  /*
   * Byways Topo renders from Mapbox vector tiles when there is a token. Its
   * `tiles` array is CyclOSM - a no-token fallback, the same idea drawn by
   * somebody else - so a downloader reading `tiles` would have fetched a
   * different map from the one on screen and gone offline showing it.
   *
   * The viewer refuses on `style || custom === 'byways'`. This pins the fact
   * that makes the refusal necessary: the fallback tiles exist, and are not
   * the same map. If Byways Topo ever gains cacheable tiles that ARE its own
   * rendering, this fails and the refusal should be revisited - which is the
   * point of testing the reason rather than the rule.
   */
  const byways = BASEMAPS.find((entry) => entry.custom === 'byways');
  assert.ok(byways, 'Byways Topo is gone, so this test is about nothing');
  assert.ok((byways.tiles || []).length > 0, 'the fallback tiles are what made this dangerous');
  assert.equal((byways.tiles || []).some(mayCacheTiles), false,
    'the fallback is a community OSM server and must not be bulk-downloaded either');
});

test('offline: every basemap offering a download offers its own map', () => {
  // A raster basemap draws from the same tiles it would store; a vector one
  // does not, and is the case the refusal exists for.
  for (const basemap of BASEMAPS) {
    const rendersVector = Boolean(basemap.style || basemap.custom === 'byways');
    if (!rendersVector) continue;
    assert.equal((basemap.tiles || []).some(mayCacheTiles), false,
      `${basemap.id} renders from vector tiles but has cacheable rasters, which would download a different map`);
  }
});

test('offline: a region is discarded under the archive it came from', async () => {
  /*
   * The tiles a region holds are keyed by the archive that produced them, and
   * that name is recorded on the region precisely because it can differ from
   * the one the map is reading now.
   *
   * Computing the keys from the current archive instead would delete nothing,
   * report success, and leave the space occupied - the failure mode being
   * fixed here, arriving through the fix for it.
   */
  const { regionTileKeys } = await import('../assets/js/lib/offline.js');
  const { parseTileKey, memoryTileStore } = await import('../assets/js/lib/pmtiles-store.js');

  const region = {
    archive: 'https://old.example/byways.pmtiles',
    bounds: { west: -83.7, south: 37.7, east: -83.5, north: 37.9 },
    minZoom: 10,
    maxZoom: 11,
  };
  const keys = regionTileKeys(region);
  assert.ok(keys.length > 1, 'a two-zoom region should cover more than one tile');
  for (const key of keys) {
    assert.equal(parseTileKey(key).archive, region.archive,
      'a key was built from something other than the region’s own archive');
  }

  // Zooms outside the region are not touched, in either direction.
  const zooms = new Set(keys.map((key) => parseTileKey(key).z));
  assert.deepEqual([...zooms].sort((a, b) => a - b), [10, 11]);

  // A region with no archive recorded was never downloaded, and asking for its
  // keys must not produce keys under the empty name.
  assert.deepEqual(regionTileKeys({ ...region, archive: '' }), []);

  // And the store removes those and only those.
  const store = memoryTileStore();
  const body = new Uint8Array([1, 2, 3]);
  for (const key of keys) await store.put(key, body);
  const neighbour = 'https://old.example/byways.pmtiles.old|10/0/0';
  await store.put(neighbour, body);
  const removed = await store.remove(keys);
  assert.equal(removed, keys.length);
  assert.equal(await store.has(neighbour), true,
    'an archive whose name merely begins the same must survive');
  assert.equal(await store.count(), 1);
});

/*
 * A region is a place, not a state.
 *
 * The cap has to admit the ground this app is for - a national forest with the
 * roads into it - and refuse the whole of the state around it, and say why in
 * words that tell the reader what to do instead.
 */
test('offline: a national forest is a region and a state is not', () => {
  assert.equal(regionSizeProblem(SMOKIES), '', 'the Cherokee fits');
  assert.ok(areaKm2(SMOKIES) < REGION_MAX_KM2);

  const westVirginia = { west: -82.65, south: 37.2, east: -77.7, north: 40.65 };
  const refusal = regionSizeProblem(westVirginia);
  assert.match(refusal, /capped/);
  assert.match(refusal, /zoom in or draw something smaller/);
  assert.match(refusal, /25,000/);

  assert.match(regionSizeProblem(null), /not an area/);
  assert.match(regionSizeProblem({ west: -84, south: 35, east: -84, north: 35 }), /not an area/);
});
