/**
 * Offline regions — defining what to take with you.
 *
 * The honest framing first, because it decides the whole design: Mapbox GL JS
 * has no offline API. The browser cannot pre-download a tile pyramid and serve
 * it back with no signal; only the native mobile SDKs can, through
 * `OfflineRegionDefinition`. So this module does not pretend to download
 * anything. It does the part the browser is actually good at — letting you
 * choose the ground, see honestly what it will cost, and save that choice — and
 * exports the result in exactly the shape the iOS and Android SDKs consume.
 *
 * That means the regions you define on a laptop at the kitchen table are the
 * regions the app downloads later, rather than work to be redone on a phone.
 *
 * All the arithmetic here is pure and offline, which is the point: you are
 * usually planning this the night before, on a connection you do not trust.
 */

import { tileKey } from './pmtiles-store.js';

/**
 * The zoom ceiling for a saved region.
 *
 * Not arbitrary. Each zoom level past the last quadruples the tile count, and
 * z14 is roughly where a topo still shows the individual switchbacks and creek
 * crossings you navigate by. Going to z16 for the same ground costs sixteen
 * times the tiles to add detail you will not read on a phone screen while
 * standing in weather.
 */
export const MAX_ZOOM = 14;

/**
 * Mapbox's default offline ceiling per user, across all their regions.
 *
 * 6,000 tiles is what a Mapbox account allows before downloads start failing,
 * and it is raised only by asking them. Worth showing before a download is
 * queued rather than after it stops halfway up a mountain.
 */
export const TILE_BUDGET = 6000;

/**
 * Average bytes per tile, used for the size estimate.
 *
 * Deliberately a single documented number rather than a false precision: real
 * tiles run from a few hundred bytes over empty desert to 100 KB over a city,
 * and no estimate made without fetching them can be better than an order of
 * magnitude. Vector tiles carry geometry for every zoom above them, so they run
 * heavier than a raster tile of the same ground.
 */
const BYTES_PER_TILE = { vector: 45000, raster: 28000 };

const STORAGE_KEY = 'ab-maps-offline-v1';
const NAME_LIMIT = 80;

let idCounter = 0;
function makeId() {
  idCounter += 1;
  return `region_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/* ------------------------------------------------------------------ bounds */

/**
 * Coerce anything bounds-shaped into `{west, south, east, north}`.
 *
 * Accepts the array form Mapbox uses, the object form this module stores, and
 * a live `LngLatBounds` — the map hands back the last one and the URL carries
 * the first, so normalising once here keeps that mess out of everything else.
 */
export function normalizeBounds(input) {
  if (!input) return null;

  let west; let south; let east; let north;

  if (typeof input.getWest === 'function') {
    west = input.getWest(); south = input.getSouth();
    east = input.getEast(); north = input.getNorth();
  } else if (Array.isArray(input)) {
    const flat = input.flat();
    if (flat.length !== 4) return null;
    [west, south, east, north] = flat;
  } else {
    ({ west, south, east, north } = input);
  }

  if (![west, south, east, north].every(Number.isFinite)) return null;

  // Web Mercator is undefined at the poles and the tile scheme stops at ±85.05.
  south = Math.max(-85.0511, Math.min(85.0511, south));
  north = Math.max(-85.0511, Math.min(85.0511, north));
  if (south > north) [south, north] = [north, south];

  return { west, south, east, north };
}

/** Does this box cross the antimeridian? Real in Alaska and the Aleutians. */
export function crossesAntimeridian({ west, east }) {
  return west > east;
}

/**
 * Split an antimeridian-crossing box into ordinary west-to-east boxes.
 *
 * Everything downstream can then assume west <= east, rather than each caller
 * rediscovering that a region over Attu counts negative tiles.
 */
function spans(bounds) {
  if (!crossesAntimeridian(bounds)) return [bounds];
  return [
    { ...bounds, west: bounds.west, east: 180 },
    { ...bounds, west: -180, east: bounds.east },
  ];
}

/* ------------------------------------------------------------------ tiles */

function lonToX(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom);
}

function latToY(lat, zoom) {
  const rad = (lat * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
  return Math.floor(y * 2 ** zoom);
}

/**
 * The tile x/y range covering a box at one zoom.
 *
 * y runs southward in the XYZ scheme, so the north edge produces the smaller
 * index — the inversion that quietly makes every hand-rolled tile counter
 * return zero the first time.
 */
export function tileRange(bounds, zoom) {
  const box = normalizeBounds(bounds);
  if (!box) return null;

  const limit = 2 ** zoom - 1;
  const clamp = (value) => Math.max(0, Math.min(limit, value));

  return {
    minX: clamp(lonToX(box.west, zoom)),
    maxX: clamp(lonToX(box.east, zoom)),
    minY: clamp(latToY(box.north, zoom)),
    maxY: clamp(latToY(box.south, zoom)),
  };
}

/** Tiles needed for a box across an inclusive zoom range. */
export function countTiles(bounds, minZoom = 0, maxZoom = MAX_ZOOM) {
  const box = normalizeBounds(bounds);
  if (!box) return 0;

  const low = Math.max(0, Math.round(minZoom));
  const high = Math.min(MAX_ZOOM, Math.round(maxZoom));
  if (high < low) return 0;

  let total = 0;
  for (const part of spans(box)) {
    for (let zoom = low; zoom <= high; zoom += 1) {
      const range = tileRange(part, zoom);
      total += (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
    }
  }
  return total;
}

/** Rough download size in bytes. See BYTES_PER_TILE for how rough. */
export function estimateBytes(tiles, kind = 'raster') {
  return tiles * (BYTES_PER_TILE[kind] || BYTES_PER_TILE.raster);
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Ground area of a box in square kilometres, corrected for latitude. */
export function areaKm2(bounds) {
  const box = normalizeBounds(bounds);
  if (!box) return 0;

  let total = 0;
  for (const part of spans(box)) {
    const meanLat = ((part.north + part.south) / 2) * (Math.PI / 180);
    const height = (part.north - part.south) * 111.32;
    const width = (part.east - part.west) * 111.32 * Math.cos(meanLat);
    total += Math.abs(height * width);
  }
  return total;
}

/* ------------------------------------------------------------------ regions */

function clampName(value, fallback) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, NAME_LIMIT) : fallback;
}

/**
 * A saved region: the ground, the zooms, and which map it is for.
 *
 * The basemap matters because a region is a pyramid of one map's tiles. Saving
 * "the Cherokee at z10–14" without saying which map means nothing to the
 * downloader, so the region carries the basemap it was defined against.
 */
export function createRegion({ name, bounds, minZoom = 8, maxZoom = 12, basemapId = '', basemapName = '' } = {}) {
  const box = normalizeBounds(bounds);
  if (!box) return null;

  const low = Math.max(0, Math.min(MAX_ZOOM, Math.round(minZoom)));
  const high = Math.max(low, Math.min(MAX_ZOOM, Math.round(maxZoom)));

  return {
    id: makeId(),
    name: clampName(name, 'Untitled region'),
    bounds: box,
    minZoom: low,
    maxZoom: high,
    basemapId,
    basemapName,
    created: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * The three zooms worth having, and where each of them is worth having it.
 *
 * A contiguous pyramid is the wrong shape for how a map is actually used in the
 * field. z8 to z14 over one region is about five thousand tiles, and almost all
 * of them are the top level covering ground nobody will look at closely — you
 * need the whole area at a glance, the road network at a middle zoom, and
 * street-level detail only where you are actually going.
 *
 * So: the broad and middle zooms cover the region, and the close zoom covers
 * only small boxes around the points you saved. Over a 50km region with twenty
 * waypoints that is a few hundred tiles instead of several thousand, for a map
 * that is more useful rather than less — the detail is where the detail was
 * wanted.
 *
 * Intermediate levels are skipped on purpose. A renderer shows z11 tiles
 * scaled while you are between 11 and 14; slightly soft for a moment beats
 * four times the download.
 *
 * @param waypoints [lon, lat] pairs — the places the close zoom is drawn around
 * @param radiusKm how far around each point to take the close zoom
 */
export function tieredPlan(bounds, waypoints = [], {
  broad = 8, mid = 11, close = 14, radiusKm = 2,
} = {}) {
  const box = normalizeBounds(bounds);
  if (!box) return null;

  const level = (zoom) => Math.max(0, Math.min(MAX_ZOOM, Math.round(zoom)));
  const tiers = [
    { zoom: level(broad), boxes: [box], covers: 'the whole region' },
    { zoom: level(mid), boxes: [box], covers: 'the whole region' },
  ];

  /*
   * A degree of longitude shrinks with latitude and a degree of latitude does
   * not, so the box around a point is not square in degrees. Using one number
   * for both would make the close zoom cover half as much ground east-west in
   * Alaska as in Texas, silently.
   */
  const latSpan = radiusKm / 111.32;
  const around = [];
  for (const point of waypoints) {
    const [lon, lat] = point || [];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const lonSpan = radiusKm / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
    around.push(normalizeBounds({
      west: lon - lonSpan, east: lon + lonSpan,
      south: lat - latSpan, north: lat + latSpan,
    }));
  }

  if (around.length) {
    tiers.push({ zoom: level(close), boxes: around.filter(Boolean), covers: 'around each waypoint' });
  }

  return tiers;
}

/**
 * What a tiered plan costs.
 *
 * Boxes around neighbouring waypoints overlap, and counting them separately
 * would bill the same tile twice — which matters because the number is shown to
 * somebody deciding whether to press download over a hotel wifi. Counted as a
 * set of tile keys rather than a sum of rectangles.
 */
export function countTieredTiles(tiers) {
  const seen = new Set();
  for (const tier of tiers || []) {
    for (const box of tier.boxes || []) {
      // `spans` is the existing splitter — an Alaska box that crosses the
      // antimeridian becomes two ordinary west-to-east boxes.
      for (const part of spans(box)) {
        const range = tileRange(part, tier.zoom);
        if (!range) continue;
        for (let x = range.minX; x <= range.maxX; x += 1) {
          for (let y = range.minY; y <= range.maxY; y += 1) seen.add(`${tier.zoom}/${x}/${y}`);
        }
      }
    }
  }
  return seen.size;
}

/**
 * What this region costs and whether it is over budget.
 *
 * Returned as data rather than rendered text so the same numbers drive the
 * panel, the warning and the export without being computed three ways.
 */
export function measureRegion(region, kind = 'raster') {
  const tiles = countTiles(region.bounds, region.minZoom, region.maxZoom);
  return {
    tiles,
    bytes: estimateBytes(tiles, kind),
    area: areaKm2(region.bounds),
    overBudget: tiles > TILE_BUDGET,
  };
}

/**
 * The region in the shape Mapbox's mobile SDKs actually take.
 *
 * `OfflineTilePyramidRegionDefinition` on Android and
 * `MGLTilePyramidOfflineRegion` on iOS both want exactly these five fields, so
 * an app can hand this straight to the SDK with no translation layer — which is
 * the whole reason for defining regions in a browser that cannot download them.
 */
export function regionDefinition(region, { styleURL = '', pixelRatio = 2 } = {}) {
  const { west, south, east, north } = region.bounds;
  return {
    styleURL,
    bounds: { sw: [west, south], ne: [east, north] },
    minZoom: region.minZoom,
    maxZoom: region.maxZoom,
    pixelRatio,
  };
}

/**
 * The export file: regions, definitions, and what they will cost.
 *
 * Versioned, because the app that reads this does not exist yet and will want
 * to know what it is looking at.
 */
export function buildManifest(regions, { styleURL = '', pixelRatio = 2, kind = 'raster', app = 'Fieldstop' } = {}) {
  return {
    format: 'american-byways-offline',
    version: 1,
    app,
    exported: new Date().toISOString(),
    tileBudget: TILE_BUDGET,
    maxZoom: MAX_ZOOM,
    regions: regions.map((region) => {
      const measure = measureRegion(region, kind);
      return {
        name: region.name,
        basemap: region.basemapName || region.basemapId,
        bounds: region.bounds,
        minZoom: region.minZoom,
        maxZoom: region.maxZoom,
        estimate: { tiles: measure.tiles, bytes: measure.bytes, areaKm2: Math.round(measure.area) },
        definition: regionDefinition(region, { styleURL, pixelRatio }),
      };
    }),
  };
}

/** A GeoJSON outline of every region, for drawing them on the map. */
export function regionsToGeoJSON(regions) {
  return {
    type: 'FeatureCollection',
    features: regions.flatMap((region) => spans(region.bounds).map((box) => ({
      type: 'Feature',
      properties: { id: region.id, name: region.name },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [box.west, box.south], [box.east, box.south],
          [box.east, box.north], [box.west, box.north],
          [box.west, box.south],
        ]],
      },
    }))),
  };
}

/* ------------------------------------------------------------------ store */

/**
 * Saved regions, persisted per browser.
 *
 * Same shape as the folder store on purpose — list/create/remove, a 'change'
 * event, and localStorage underneath — so the panel that renders it works the
 * way the rest of the app already does.
 */
export class OfflineStore extends EventTarget {
  constructor({ storage = globalThis.localStorage } = {}) {
    super();
    this.storage = storage;
    this.regions = this.load();
  }

  load() {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((region) => (normalizeBounds(region?.bounds) ? { ...region, bounds: normalizeBounds(region.bounds) } : null))
        .filter(Boolean);
    } catch {
      // A corrupt entry should cost you your saved regions, not the whole app.
      return [];
    }
  }

  save() {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.regions));
    } catch (error) {
      console.warn('[offline] could not save regions:', error.message);
    }
  }

  emit() {
    this.save();
    this.dispatchEvent(new CustomEvent('change'));
  }

  list() {
    return this.regions.slice();
  }

  get(id) {
    return this.regions.find((region) => region.id === id) || null;
  }

  add(input) {
    const region = createRegion(input);
    if (!region) return null;
    this.regions.push(region);
    this.emit();
    return region;
  }

  update(id, changes) {
    const region = this.get(id);
    if (!region) return null;

    if (changes.name !== undefined) region.name = clampName(changes.name, region.name);
    if (changes.bounds !== undefined) region.bounds = normalizeBounds(changes.bounds) || region.bounds;
    if (changes.minZoom !== undefined) region.minZoom = Math.max(0, Math.min(MAX_ZOOM, Math.round(changes.minZoom)));
    if (changes.maxZoom !== undefined) region.maxZoom = Math.max(0, Math.min(MAX_ZOOM, Math.round(changes.maxZoom)));
    if (region.maxZoom < region.minZoom) region.maxZoom = region.minZoom;

    region.updatedAt = Date.now();
    this.emit();
    return region;
  }

  remove(id) {
    const before = this.regions.length;
    this.regions = this.regions.filter((region) => region.id !== id);
    if (this.regions.length === before) return false;
    this.emit();
    return true;
  }

  /** Total tiles across every saved region — what Mapbox's ceiling applies to. */
  totalTiles(kind = 'raster') {
    return this.regions.reduce((sum, region) => sum + measureRegion(region, kind).tiles, 0);
  }
}

/* ------------------------------------------------------- downloading tiles */

/**
 * Whether this app may keep a source's tiles on disk.
 *
 * Not a technical question. USGS, the state agencies and the federal services
 * publish public data and put no such condition on it, and every one of them
 * is fetchable from a browser or it would not be in the catalogue.
 *
 * Mapbox is a licensing question rather than an impossibility, and the
 * distinction matters to anyone costing a paid tier: their native mobile
 * toolkit downloads regions properly and bills for it. What has no offline
 * facility is Mapbox GL JS, which is what runs here, and their terms reserve
 * storage of their tiles to the sanctioned SDKs - so caching them from a
 * webview would be using the service in a way it is not licensed for, at any
 * price. Reaching the supported route means drawing natively on the phone,
 * which is engineering rather than a plan upgrade.
 *
 * Written as an explicit deny list of hosts rather than an allow list of
 * everything else, so a new state layer is downloadable the day it is added
 * and nobody has to remember to permit it.
 */
const NO_CACHE_HOSTS = [
  /(^|\.)mapbox\.com$/i,
  /(^|\.)tiles\.mapbox\.com$/i,
  /*
   * The OpenStreetMap community tile servers, for a different reason.
   *
   * Nothing licenses these away, but they are volunteer-funded and their usage
   * policy asks bulk downloaders to run their own. Pulling four thousand tiles
   * off tile-cyclosm.openstreetmap.fr to fill somebody's phone is exactly what
   * it asks people not to do, and "we were allowed to" is not the same as "we
   * should".
   */
  /(^|\.)openstreetmap\.(org|fr|de)$/i,
  /(^|\.)tile\.osm\.org$/i,
];

export function mayCacheTiles(template) {
  try {
    const { hostname, protocol } = new URL(String(template).replace(/\{[^}]*\}/g, '0'));
    if (protocol !== 'https:') return false;
    return !NO_CACHE_HOSTS.some((pattern) => pattern.test(hostname));
  } catch {
    return false;
  }
}

/**
 * Every tile URL a region needs, deduplicated.
 *
 * A set of keys rather than a list of rectangles: boxes around neighbouring
 * waypoints overlap, and fetching the same tile twice is bandwidth somebody is
 * paying for on a hotel wifi.
 *
 * @param {Array<{zoom: number, boxes: object[]}>} tiers from `tieredPlan`
 * @param {string[]} templates tile URL templates to fill
 * @param {(template: string, tile: {z:number,x:number,y:number}) => string} fill
 * @returns {string[]}
 */
export function tileURLsFor(tiers, templates, fill) {
  const urls = new Set();
  for (const tier of tiers || []) {
    for (const box of tier.boxes || []) {
      for (const part of spans(box)) {
        const range = tileRange(part, tier.zoom);
        if (!range) continue;
        for (let x = range.minX; x <= range.maxX; x += 1) {
          for (let y = range.minY; y <= range.maxY; y += 1) {
            for (const template of templates) {
              if (!mayCacheTiles(template)) continue;
              urls.add(fill(template, { z: tier.zoom, x, y }));
            }
          }
        }
      }
    }
  }
  return [...urls];
}

/**
 * Fetch a list of tiles into a named cache, a few at a time.
 *
 * Serial would take an hour and unbounded parallelism gets a shared government
 * tile server to rate-limit or drop the connection - which reads to the person
 * waiting as the download breaking. Six at a time is enough to saturate a
 * phone's connection and few enough that no server treats it as abuse.
 *
 * A tile that will not come back is skipped rather than fatal. A region is
 * thousands of tiles and one 404 at the edge of a service's coverage must not
 * throw away the other four thousand; the count of failures is returned so the
 * caller can say something true about how complete the result is.
 *
 * @returns {Promise<{done: number, failed: number, cancelled: boolean}>}
 */
export async function downloadTiles(urls, {
  cacheName = 'abmap-tiles-v1', concurrency = 6, onProgress, signal, caches: store = globalThis.caches,
} = {}) {
  if (!store?.open) throw new Error('This browser cannot store tiles offline.');
  const cache = await store.open(cacheName);
  let done = 0;
  let failed = 0;
  let index = 0;

  const worker = async () => {
    while (index < urls.length) {
      if (signal?.aborted) return;
      const url = urls[index];
      index += 1;
      try {
        // Already held from an earlier download of an overlapping region.
        if (await cache.match(url, { ignoreVary: true })) { done += 1; onProgress?.(done, failed, urls.length); continue; }
        const response = await fetch(url, { mode: 'cors', signal });
        if (!response.ok) throw new Error(String(response.status));
        await cache.put(url, response);
        done += 1;
      } catch {
        failed += 1;
      }
      onProgress?.(done, failed, urls.length);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { done, failed, cancelled: Boolean(signal?.aborted) };
}

/**
 * Every tile a region needs, as z/x/y keys rather than URLs.
 *
 * The archive counterpart of `tileURLsFor`. An archive has no per-tile URLs —
 * it is one file read by byte range — so what a download enumerates is the
 * tiles themselves, which is what the region planner was counting all along.
 *
 * @param {Array<{zoom: number, boxes: object[]}>} tiers from `tieredPlan`
 * @returns {Array<{z: number, x: number, y: number}>}
 */
export function tileKeysFor(tiers) {
  const seen = new Set();
  const tiles = [];
  for (const tier of tiers || []) {
    for (const box of tier.boxes || []) {
      for (const part of spans(box)) {
        const range = tileRange(part, tier.zoom);
        if (!range) continue;
        for (let x = range.minX; x <= range.maxX; x += 1) {
          for (let y = range.minY; y <= range.maxY; y += 1) {
            const key = `${tier.zoom}/${x}/${y}`;
            if (seen.has(key)) continue;
            seen.add(key);
            tiles.push({ z: tier.zoom, x, y });
          }
        }
      }
    }
  }
  return tiles;
}

/**
 * Read a region out of an archive and keep it.
 *
 * Deliberately the same shape as `downloadTiles`: same concurrency, same
 * tolerance of individual failures, same progress signature, same return. The
 * two differ only in where a tile comes from and where it goes, and a person
 * watching the progress line should not be able to tell which one is running.
 *
 * A tile the archive does not hold is not a failure. An archive covering one
 * state genuinely has nothing outside it, and a region drawn slightly over the
 * edge would otherwise report thousands of "unavailable" tiles for having
 * asked a reasonable question.
 *
 * @param {Array<{z:number,x:number,y:number}>} tiles from `tileKeysFor`
 * @param {{archive: object, store: object, name: string}} where
 * @returns {Promise<{done: number, failed: number, absent: number, cancelled: boolean}>}
 */
/**
 * Every store key one saved region holds, under the archive it came from.
 *
 * Keyed on `region.archive` and not on whichever archive the map is reading
 * now, which is the whole point of recording it. A region downloaded from an
 * archive that has since moved holds tiles under the old name; computing the
 * keys from the current one would delete nothing, report success, and leave
 * the space still occupied.
 */
export function regionTileKeys(region) {
  if (!region?.archive || !region.bounds) return [];
  const tiers = [];
  const from = Math.min(region.minZoom, region.maxZoom);
  const to = Math.max(region.minZoom, region.maxZoom);
  for (let zoom = from; zoom <= to; zoom += 1) tiers.push({ zoom, boxes: [region.bounds] });
  return tileKeysFor(tiers).map(({ z, x, y }) => tileKey(region.archive, z, x, y));
}

export async function downloadArchiveTiles(tiles, {
  archive, store, name, concurrency = 6, onProgress, signal,
} = {}) {
  if (!archive || !store) throw new Error('This map has no archive to download from.');
  let done = 0;
  let failed = 0;
  let absent = 0;
  let index = 0;

  const worker = async () => {
    while (index < tiles.length) {
      if (signal?.aborted) return;
      const { z, x, y } = tiles[index];
      index += 1;
      /*
       * The key comes from the reader's own function, never from a template
       * written out here.
       *
       * These two halves have to agree exactly or offline fails in the worst
       * way available: the download reports every tile saved, the store fills
       * up, and the map is blank with no signal because the reader looks under
       * a name nothing was written to. There is no error anywhere in that -
       * an absent tile is a legitimate answer - so the only defence is that
       * one function decides the name for both sides.
       */
      const key = tileKey(name, z, x, y);
      try {
        if (await store.has(key)) { done += 1; onProgress?.(done, failed, tiles.length); continue; }
        const bytes = await archive.tile(z, x, y);
        if (bytes) {
          await store.put(key, bytes);
          done += 1;
        } else {
          absent += 1;
        }
      } catch {
        failed += 1;
      }
      onProgress?.(done, failed, tiles.length);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { done, failed, absent, cancelled: Boolean(signal?.aborted) };
}

/** Drop every tile a cache holds. */
export async function clearTiles(cacheName = 'abmap-tiles-v1', store = globalThis.caches) {
  if (!store?.delete) return false;
  return store.delete(cacheName);
}
