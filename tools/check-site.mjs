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

/*
 * Overlays, because the report was about one of them.
 *
 * "Restrictions & advisories produces nothing" is not visible from a check
 * that only ever loads the basemap: the queried layers are off by default, so
 * every run so far has said nothing about them either way. The app already
 * reads its visible overlays from `?o=`, so switching them on needs no new
 * machinery in the app — only for this to stop ignoring the one parameter that
 * would have shown the failure.
 *
 * An empty value is not the same as an absent one: `?o=` means "none of them",
 * which is a useful thing to ask for, so only a missing argument leaves the
 * defaults alone.
 */
const overlays = process.argv[5] ?? null;

const page = new URL(url);
if (!page.pathname.endsWith('.html')) page.pathname = page.pathname.replace(/\/?$/, '/') + 'map.html';
page.searchParams.set('b', basemap);
if (overlays !== null) page.searchParams.set('o', overlays);
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

/*
 * Feature-service calls, recorded separately.
 *
 * `watched` above matches the archive, tiles, glyphs and fonts — which is
 * every request the basemap makes and none of the requests a queried overlay
 * makes. So this report could say `overlay-faa-uas-grid` drew nothing while
 * being structurally incapable of showing whether its data had ever been
 * asked for, and I read three runs of it as evidence about the layer.
 *
 * A layer that never fetched, a fetch that was refused and a fetch that came
 * back empty are three different faults with three different fixes, and they
 * are indistinguishable on screen. This is the line that separates them.
 */
const dataCalls = [];
const isData = (at) => /FeatureServer|MapServer|\/query\?/i.test(at);
tab.on('response', (response) => {
  const at = response.url();
  if (!isData(at)) return;
  dataCalls.push({ at, outcome: `${response.status()} ${response.statusText()}` });
});
tab.on('requestfailed', (request) => {
  const at = request.url();
  if (!isData(at)) return;
  dataCalls.push({ at, outcome: `FAILED — ${request.failure()?.errorText || 'no reason given'}` });
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

/*
 * And then wait for the style itself, which `idle` does not guarantee.
 *
 * Every report today was taken with `loaded=false` in it, and I read the
 * "drew nothing" list off it several times without noticing. Overlay layers
 * are attached after the style finishes, so a check that samples before then
 * cannot tell a layer that is broken from one that has not been added yet -
 * and I nearly reported the first when the evidence only supported "too
 * early".
 *
 * `idle` means the engine has stopped fetching and rendering, which happens
 * once before the style is complete. This waits for the style to say so, then
 * for the map to go quiet again.
 */
const stable = await inTime('the style', () => tab.evaluate(() => new Promise((resolve) => {
  const map = window.abmapMap;
  if (!map) { resolve('no map'); return; }
  const deadline = setTimeout(() => resolve(`gave up with styleLoaded=${map.isStyleLoaded()}`), 30000);
  const done = (how) => { clearTimeout(deadline); resolve(how); };
  const settleThen = () => {
    if (!map.isStyleLoaded()) return false;
    map.once('idle', () => done('style loaded'));
    // A map already quiet emits no further idle on its own.
    map.triggerRepaint?.();
    return true;
  };
  if (settleThen()) return;
  const poll = setInterval(() => { if (settleThen()) clearInterval(poll); }, 200);
})), 'the style never finished');

const EMPTY = {
  config: { archive: '(page never answered)', maxzoom: '', mapboxToken: '' },
  engine: { maplibre: '', mapbox: '', pmtilesRegistered: false },
  map: 'the page never answered',
  sources: [],
  rendered: [],
  byStyleLayer: [],
  silent: [],
  overlays: [],
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
    overlays: [],
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
  /*
   * Each queried overlay in three stages, because it can fail at any of them.
   *
   * A queried overlay draws nothing for three unrelated reasons: nobody
   * fetched its data, the data arrived but the engine holds no features for
   * this view, or it is held and something in the style keeps it off screen.
   * All three land in the "drew nothing" list below looking identical, which
   * is how three fixes in a row went to the wrong stage.
   *
   * `set` is what the app handed the source, `indexed` is what the engine
   * will answer for out of it, and the layer line is where it sits in the
   * draw order and how visible it is. Whichever of those is zero first is
   * the stage that is broken.
   */
  const order = (map.getStyle()?.layers || []).map((layer) => layer.id);
  const paintOf = (name) => {
    for (const prop of ['fill-pattern', 'fill-opacity', 'line-opacity', 'circle-opacity', 'text-opacity']) {
      try {
        const value = map.getPaintProperty(name, prop);
        if (value !== undefined) return `${prop}=${JSON.stringify(value).slice(0, 60)}`;
      } catch { /* the layer type does not carry this one */ }
    }
    return '';
  };
  for (const id of Object.keys(map.getStyle()?.sources || {})) {
    if (!id.startsWith('overlay-')) continue;
    const data = map.getSource(id)?._data;
    out.overlays.push({
      id,
      set: Array.isArray(data?.features) ? data.features.length : `not a collection (${typeof data})`,
      indexed: (() => { try { return map.querySourceFeatures(id).length; } catch { return 'unknown'; } })(),
      layers: order
        .map((name, at) => ({ name, at }))
        .filter((one) => one.name === id || one.name.startsWith(`${id}--`))
        .map((one) => {
          const visibility = (() => {
            try { return map.getLayoutProperty(one.name, 'visibility') ?? 'visible'; } catch { return '?'; }
          })();
          return `${one.name} · ${map.getLayer(one.name)?.type || '?'} · #${one.at} of ${order.length} · ${visibility} · ${paintOf(one.name)}`;
        }),
    });
  }
  return out;
}), EMPTY);

/*
 * Which build this actually looked at.
 *
 * Twice now a check has been dispatched while a deploy was still publishing,
 * and the report that came back described the previous build - indistinguishable
 * from the new one having not fixed anything. The site publishes deployed.txt
 * with the commit in it, so the check can say which build it saw rather than
 * leaving that to be inferred from timing.
 */
const stamp = await inTime('reading the build stamp', async () => {
  const at = new URL('deployed.txt', page.href).href;
  const response = await tab.request.get(at);
  if (!response.ok()) return `deployed.txt answered ${response.status()}`;
  return (await response.text()).split('\n').filter(Boolean).join(' · ');
}, 'not read');

console.log(`  build                 ${stamp}`);
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
  console.log(`  overlays asked for    ${overlays === null ? '(defaults)' : (overlays || '(none)')}`);
  console.log(`  waited for            ${settled} · ${stable}`);
  console.log(`  looking at            z${report.map.zoom} ${report.map.centre}`);
}

console.log('\nSources');
for (const source of report.sources) {
  console.log(`  ${source.id.padEnd(14)} ${String(source.type).padEnd(7)} loaded=${String(source.loaded).padEnd(6)} maxzoom=${source.maxzoom ?? '-'} ${source.tiles}`);
}

if (report.overlays.length) {
  console.log('\nQueried overlays — fetched, indexed, drawn');
  for (const overlay of report.overlays) {
    console.log(`  ${overlay.id}`);
    console.log(`    features set on the source   ${overlay.set}`);
    console.log(`    features the engine holds    ${overlay.indexed}`);
    for (const layer of overlay.layers) console.log(`    ${layer}`);
  }
  console.log('    set=0 means nothing was fetched or the answer was empty — read the');
  console.log('    feature-service calls below. set>0 with nothing drawn is the style.');
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

/*
 * And if an overlay holds data the engine does not, hand it the same data
 * again and see whether that is enough.
 *
 * Measured on one commit at one place: Byways Topo set 32 features on
 * overlay-faa-uas-grid and the engine held 0; the raster basemap set the same
 * 32 and held 168. Same fetch, same source, same layers. That narrows it to
 * the moment the data was handed over, and the way to test a race is to
 * repeat the handover once the race is over rather than to reason about it —
 * three fixes reasoned from the code did not work.
 *
 * If the count comes up after this, the fault is when setData was called and
 * the fix is to call it again when the source is ready. If it stays at zero,
 * it is not the handover and this rules that out instead.
 */
const retried = await inTime('re-setting overlay data', () => tab.evaluate(async () => {
  const map = window.abmapMap;
  if (!map) return [];
  const out = [];
  for (const id of Object.keys(map.getStyle()?.sources || {})) {
    if (!id.startsWith('overlay-')) continue;
    const source = map.getSource(id);
    const data = source?._data;
    if (!Array.isArray(data?.features) || !data.features.length) continue;
    const before = map.querySourceFeatures(id).length;
    if (before) continue;
    source.setData(data);
    await new Promise((resolve) => {
      const deadline = setTimeout(resolve, 8000);
      map.once('idle', () => { clearTimeout(deadline); resolve(); });
      map.triggerRepaint?.();
    });
    out.push({ id, set: data.features.length, before, after: map.querySourceFeatures(id).length });
  }
  return out;
}), []);

if (Array.isArray(retried) && retried.length) {
  console.log('\nHanded the same data over a second time');
  for (const one of retried) {
    console.log(`  ${one.id}: ${one.set} set · engine held ${one.before}, now holds ${one.after}`);
  }
  console.log('  A count that comes up here means the first setData was too early.');
}

console.log('\nFeature-service calls');
if (!dataCalls.length) {
  console.log('  NONE — no queried overlay asked any service for anything.');
} else {
  for (const call of dataCalls) {
    const short = call.at.replace(/\?.*$/, '').replace('https://', '');
    const where = /[?&]where=([^&]*)/.exec(call.at)?.[1] || '';
    console.log(`  ${call.outcome.padEnd(22)} ${short}${where ? `  where=${decodeURIComponent(where)}` : ''}`);
  }
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
