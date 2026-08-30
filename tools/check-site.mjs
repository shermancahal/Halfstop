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
tab.on('response', async (response) => {
  const at = response.url();
  if (!/\.pmtiles|\.pbf|fonts|glyphs/.test(at)) return;
  requests.push({
    at,
    outcome: `${response.status()} ${response.statusText()}`,
    range: response.request().headers().range || '',
    allow: response.headers()['access-control-allow-origin'] || '',
  });
});
tab.on('requestfailed', (request) => {
  const at = request.url();
  if (!/\.pmtiles|\.pbf|fonts|glyphs/.test(at)) return;
  requests.push({
    at,
    outcome: `FAILED — ${request.failure()?.errorText || 'no reason given'}`,
    range: request.headers().range || '',
    allow: '',
  });
});

console.log(`${page.href}\n`);

await tab.goto(page.href, { waitUntil: 'load', timeout: 90000 });

/*
 * Wait for the map to settle rather than for a fixed time. `idle` fires when
 * the engine has stopped fetching and rendering, which is exactly the moment
 * the question "what drew?" has an answer.
 */
const settled = await tab.evaluate(() => new Promise((resolve) => {
  const deadline = setTimeout(() => resolve('timed out after 45s'), 45000);
  const check = () => {
    const map = window.abmapMap;
    if (!map) return false;
    map.once('idle', () => { clearTimeout(deadline); resolve('idle'); });
    return true;
  };
  if (check()) return;
  const poll = setInterval(() => { if (check()) clearInterval(poll); }, 250);
})).catch((error) => `could not wait: ${error.message}`);

const report = await tab.evaluate(() => {
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
  for (const feature of map.queryRenderedFeatures()) {
    const key = `${feature.source}/${feature.sourceLayer || '-'}`;
    byLayer.set(key, (byLayer.get(key) || 0) + 1);
  }
  out.rendered = [...byLayer].sort((a, b) => b[1] - a[1]);
  return out;
});

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

console.log('\nArchive, glyph and tile requests');
if (!requests.length) console.log('  NONE — the map never asked for anything.');
const seen = new Set();
for (const request of requests) {
  // One line per outcome per URL: a tile pyramid produces hundreds of
  // identical successes and the interesting thing is always the distinct set.
  const key = `${request.at}|${request.outcome}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`  ${request.outcome.padEnd(34)} ${request.allow ? `acao=${request.allow} ` : ''}${request.at}`);
}
if (requests.length > seen.size) console.log(`  (${requests.length - seen.size} more with outcomes already listed)`);

console.log('\nConsole');
if (!consoleErrors.length) console.log('  clean');
for (const line of [...new Set(consoleErrors)].slice(0, 40)) console.log(`  ${line}`);

await tab.screenshot({ path: 'site.png', fullPage: false });
console.log('\nScreenshot written to site.png');

await browser.close();

const drew = report.rendered.length > 0;
if (!drew) {
  console.error('\nNothing rendered. The lines above say which stage stopped: no requests means the');
  console.error('source was never built, failed requests name the host problem, and successful');
  console.error('requests with no features means the style filtered everything out.');
  process.exit(1);
}
