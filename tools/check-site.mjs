/**
 * Open the published site in a real browser and report why the map is empty.
 *
 *   node tools/check-site.mjs https://shermancahal.github.io/Map/ byways
 *
 * Everything else in this repo checks one layer of the stack in isolation:
 * the unit tests check the reader, `check:archive` checks the host, the smoke
 * test checks the app against a stubbed engine. A map that draws a background
 * colour and nothing else passes all three, because the failure is in the
 * seam — a URL the config points somewhere else, a CORS refusal the browser
 * enforces and curl does not, a protocol that was never registered, a source
 * that fails silently because MapLibre reports source errors and this app
 * swallows "Failed to fetch".
 *
 * So this looks at the one thing none of them can: what actually happens in a
 * browser at the real origin. It reports, in order of what it would rule out:
 *
 *   · the config the site is serving — which archive, at what depth
 *   · which engine loaded, and whether pmtiles:// was registered
 *   · every request the archive URL received, with status or failure reason
 *   · every console error and every GL error event
 *   · how many features are actually rendered, per source-layer
 *
 * Deliberately not part of `npm test`: it needs a network, a browser and a
 * deployed site.
 */

import { chromium } from 'playwright';

const url = process.argv[2];
const basemap = process.argv[3] || 'byways';
if (!url) {
  console.error('Usage: node tools/check-site.mjs <site url> [basemap id] [zoom/lat/lon]');
  console.error('  e.g. node tools/check-site.mjs https://shermancahal.github.io/Map/ byways');
  process.exit(2);
}

/* Gatlinburg by default: inside the Smokies extract, and somewhere with roads. */
const view = process.argv[4] || '13/35.714/-83.511';

const page = new URL(url);
if (!page.pathname.endsWith('.html')) page.pathname = page.pathname.replace(/\/?$/, '/') + 'map.html';
page.searchParams.set('b', basemap);
// The map is constructed with `hash: 'view'`, so the position rides in a named
// parameter rather than the bare `#z/lat/lon` the engine uses by default.
page.hash = `#view=${view}`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const tab = await context.newPage();

const consoleErrors = [];
const requests = [];

tab.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    consoleErrors.push(`${message.type()}: ${message.text()}`);
  }
});
tab.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

/*
 * Requests are recorded by outcome rather than counted.
 *
 * A CORS refusal and a 404 and a DNS failure all end with no tiles, and they
 * are three different problems with three different fixes. `requestfailed`
 * carries the browser's own reason string, which is the only place the
 * difference is written down — the page sees an opaque "Failed to fetch".
 */
const inFlight = new Map();
const watched = (at) => /\.pmtiles|\.pbf|fonts|glyphs/.test(at);

/*
 * Started requests are tracked as well as finished ones.
 *
 * The first run of this hung for nine minutes on a live site, which no report
 * would have explained afterwards because a request that never finishes
 * produces neither a response nor a failure. It is also the single most
 * likely thing to be wrong with a hosted archive - a host that ignores Range
 * answers one tile read with the whole file - so "started, never finished,
 * and here is how much arrived" is a diagnosis rather than a gap.
 */
tab.on('request', (request) => {
  const at = request.url();
  if (watched(at)) inFlight.set(request, { at, started: Date.now(), range: request.headers().range || '' });
});

tab.on('response', async (response) => {
  const at = response.url();
  if (!watched(at)) return;
  const started = inFlight.get(response.request());
  inFlight.delete(response.request());
  requests.push({
    at,
    outcome: `${response.status()} ${response.statusText()}`,
    range: response.request().headers().range || '',
    allow: response.headers()['access-control-allow-origin'] || '',
    length: response.headers()['content-length'] || '',
    ms: started ? Date.now() - started.started : 0,
  });
});
tab.on('requestfailed', (request) => {
  const at = request.url();
  if (!watched(at)) return;
  inFlight.delete(request);
  requests.push({
    at,
    outcome: `FAILED — ${request.failure()?.errorText || 'no reason given'}`,
    range: request.headers().range || '',
    allow: '',
    length: '',
    ms: 0,
  });
});

console.log(`${page.href}\n`);

/*
 * A hard deadline over everything below.
 *
 * Each individual wait already has a timeout and it was not enough: the run
 * that motivated this sat for nine minutes with no output at all, because a
 * page whose main thread is saturated stalls `evaluate` and `screenshot` too,
 * and those are the calls that were meant to report the stall. A check that
 * can hang is a check that tells you nothing on exactly the sites worth
 * checking, so the whole sequence races a clock and whatever has been
 * collected gets printed either way.
 */
const BUDGET = Number(process.env.ABMAP_BUDGET_MS || 150000);
const ranOut = Symbol('ran out of time');
const deadline = new Promise((resolve) => setTimeout(() => resolve(ranOut), BUDGET));
const inTime = async (what, work, fallback) => {
  const result = await Promise.race([work().catch((error) => `failed: ${error.message}`), deadline]);
  if (result !== ranOut) return result;
  console.log(`  ${what} did not finish inside ${BUDGET / 1000}s.`);
  return fallback;
};

const arrived = await inTime('the page load', () => tab.goto(page.href, { waitUntil: 'load', timeout: 60000 }), null);
if (arrived === null) console.log('  (the report below is whatever was collected before that)');

/*
 * Wait for the map to settle rather than for a fixed time. `idle` fires when
 * the engine has stopped fetching and rendering, which is exactly the moment
 * the question "what drew?" has an answer.
 */
const settled = await inTime('the map', () => tab.evaluate(() => new Promise((resolve) => {
  const deadline = setTimeout(() => resolve('timed out after 45s'), 45000);
  const check = () => {
    const map = window.abmapMap;
    if (!map) return false;
    map.once('idle', () => { clearTimeout(deadline); resolve('idle'); });
    return true;
  };
  if (check()) return;
  const poll = setInterval(() => { if (check()) clearInterval(poll); }, 250);
})), 'never settled — the page is still busy');

const EMPTY = {
  config: { archive: '(page never answered)', maxzoom: '', mapboxToken: '' },
  engine: { maplibre: '', mapbox: '', pmtilesRegistered: false },
  map: 'the page never answered',
  sources: [],
  rendered: [],
  byStyleLayer: [],
  silent: [],
};

const report = await inTime('reading the map', () => tab.evaluate(() => {
  const out = {
    config: {
      archive: window.ABMAP_PROTOMAPS_ARCHIVE ?? '(undefined)',
      maxzoom: window.ABMAP_PROTOMAPS_MAXZOOM ?? '(undefined)',
      mapboxToken: window.ABMAP_MAPBOX_TOKEN ? `${String(window.ABMAP_MAPBOX_TOKEN).slice(0, 6)}… (${String(window.ABMAP_MAPBOX_TOKEN).length} chars)` : '(empty)',
    },
    engine: {
      maplibre: typeof window.maplibregl !== 'undefined' ? window.maplibregl.getVersion?.() || 'loaded' : 'not loaded',
      mapbox: typeof window.mapboxgl !== 'undefined' ? window.mapboxgl.version || 'loaded' : 'not loaded',
      pmtilesRegistered: Boolean(window.maplibregl && window.maplibregl.__abmapPMTiles),
    },
    map: null,
    sources: [],
    rendered: [],
    byStyleLayer: [],
    silent: [],
  };

  const map = window.abmapMap;
  if (!map) { out.map = 'no map instance exposed on window'; return out; }

  const centre = map.getCenter();
  out.map = {
    zoom: Number(map.getZoom().toFixed(2)),
    centre: `${centre.lng.toFixed(4)}, ${centre.lat.toFixed(4)}`,
    styleLoaded: map.isStyleLoaded(),
    styleName: map.getStyle()?.name || '(unnamed)',
    layers: map.getStyle()?.layers?.length ?? 0,
  };

  for (const [id, source] of Object.entries(map.getStyle()?.sources || {})) {
    out.sources.push({
      id,
      type: source.type,
      tiles: Array.isArray(source.tiles) ? source.tiles[0] : source.url || '',
      maxzoom: source.maxzoom,
      loaded: (() => { try { return map.isSourceLoaded(id); } catch { return 'unknown'; } })(),
    });
  }

  /*
   * Features per source-layer, straight off the screen.
   *
   * queryRenderedFeatures is the honest measure: it counts what a reader can
   * see, so a source that loaded and a style that filtered everything out are
   * distinguishable, and both are distinguishable from a source that never
   * arrived. querySourceFeatures would answer for the data alone, which is
   * the question the archive inspector already answers.
   */
  const byLayer = new Map();
  const byStyleLayer = new Map();
  for (const feature of map.queryRenderedFeatures()) {
    const key = `${feature.source}/${feature.sourceLayer || '-'}`;
    byLayer.set(key, (byLayer.get(key) || 0) + 1);
    const drawn = feature.layer?.id;
    if (drawn) byStyleLayer.set(drawn, (byStyleLayer.get(drawn) || 0) + 1);
  }
  out.rendered = [...byLayer].sort((a, b) => b[1] - a[1]);

  /*
   * And per style layer, which is the half that answers the useful question.
   *
   * Source-layer counts say the data arrived. They cannot distinguish a map
   * with route shields on it from one without, because a shield layer and the
   * road casing under it both read the `roads` source-layer and land in the
   * same bucket. Listing what each style layer drew - and, more to the point,
   * which ones drew nothing - is what says whether the map a reader sees is
   * the map this style describes.
   */
  out.byStyleLayer = [...byStyleLayer].sort((a, b) => b[1] - a[1]);
  out.silent = (map.getStyle()?.layers || [])
    .filter((layer) => layer.type !== 'background' && !byStyleLayer.has(layer.id))
    .map((layer) => layer.id);
  return out;
}), EMPTY);

console.log(`  waited for             ${settled}`);
console.log(`  archive               ${report.config.archive}`);
console.log(`  maxzoom               ${report.config.maxzoom}`);
console.log(`  mapbox token          ${report.config.mapboxToken}`);
console.log(`  maplibre              ${report.engine.maplibre}`);
console.log(`  mapbox gl             ${report.engine.mapbox}`);
console.log(`  pmtiles:// registered ${report.engine.pmtilesRegistered}`);
console.log('');

if (typeof report.map === 'string') {
  console.log(`  map                   ${report.map}`);
} else {
  console.log(`  style                 ${report.map.styleName} · ${report.map.layers} layers · loaded=${report.map.styleLoaded}`);
  console.log(`  looking at            z${report.map.zoom} ${report.map.centre}`);
}

console.log('\nSources');
for (const source of report.sources) {
  console.log(`  ${source.id.padEnd(14)} ${String(source.type).padEnd(7)} loaded=${String(source.loaded).padEnd(6)} maxzoom=${source.maxzoom ?? '-'} ${source.tiles}`);
}

console.log('\nRendered features on screen');
if (!report.rendered.length) console.log('  NONE — nothing at all is drawing.');
for (const [key, count] of report.rendered) console.log(`  ${String(count).padStart(6)}  ${key}`);

console.log('\nDrawn by style layer');
if (!report.byStyleLayer.length) console.log('  NONE');
for (const [id, count] of report.byStyleLayer) console.log(`  ${String(count).padStart(6)}  ${id}`);
if (report.silent.length) {
  console.log(`\n  Drew nothing here — ${report.silent.length}:`);
  console.log(`    ${report.silent.join(', ')}`);
  console.log('    Some of these are honest (no glacier in Tennessee). A label or shield');
  console.log('    layer in this list over ground that has them is a filter or a font.');
}

console.log('\nArchive, glyph and tile requests');
if (!requests.length) console.log('  NONE — the map never asked for anything.');
const seen = new Set();
for (const request of requests) {
  // One line per outcome per URL: a tile pyramid produces hundreds of
  // identical successes and the interesting thing is always the distinct set.
  const key = `${request.at}|${request.outcome}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const size = request.length ? `${(Number(request.length) / 1e6).toFixed(1)}MB ` : '';
  const took = request.ms ? `${(request.ms / 1000).toFixed(1)}s ` : '';
  console.log(`  ${request.outcome.padEnd(24)} ${size}${took}${request.allow ? `acao=${request.allow} ` : ''}${request.at}`);
}
if (requests.length > seen.size) console.log(`  (${requests.length - seen.size} more with outcomes already listed)`);

if (inFlight.size) {
  console.log(`\n  Still in flight when time ran out — ${inFlight.size}:`);
  for (const { at, started, range } of [...inFlight.values()].slice(0, 8)) {
    console.log(`    ${((Date.now() - started) / 1000).toFixed(0)}s so far  ${range ? `Range: ${range}  ` : ''}${at}`);
  }
  console.log('    A read that never finishes usually means the host ignored the Range header');
  console.log('    and is sending the whole archive to answer one tile.');
}

console.log('\nConsole');
if (!consoleErrors.length) console.log('  clean');
for (const line of [...new Set(consoleErrors)].slice(0, 40)) console.log(`  ${line}`);

const shot = await inTime('the screenshot', () => tab.screenshot({ path: 'site.png', timeout: 20000 }), null);
console.log(shot === null ? '\nNo screenshot — the page never held still.' : '\nScreenshot written to site.png');

/*
 * Killed rather than closed. A close waits for the context to shut down
 * cleanly, and a page still downloading an archive it should not be
 * downloading will not — which would hang the process after the report is
 * already printed, right where it looks like the check itself is stuck.
 */
await browser.close({ reason: 'done looking' }).catch(() => {});
process.exitCode = 0;

const drew = report.rendered.length > 0;
if (!drew) {
  console.error('\nNothing rendered. The lines above say which stage stopped: no requests means the');
  console.error('source was never built, failed requests name the host problem, and successful');
  console.error('requests with no features means the style filtered everything out.');
  process.exit(1);
}

process.exit(process.exitCode || 0);
