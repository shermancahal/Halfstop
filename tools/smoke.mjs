/**
 * Smoke test: does the app survive a basemap switch?
 *
 * Not part of `npm test`, which runs with nothing installed. This needs a real
 * browser, and it earns that cost by catching the one class of bug the unit
 * tests structurally cannot: the app talking to a map engine over time.
 *
 * The bug it was written for is worth stating, because the stub that missed it
 * looked reasonable. Mapbox GL reports isStyleLoaded() as FALSE while a
 * 'style.load' handler is running — the style JSON is parsed but its sources
 * are not loaded yet. Every layer this app owns was rebuilt from inside that
 * handler, deferred on "not ready yet" to an event that had already fired, and
 * never came back. Switching a basemap silently dropped saved pins, imported
 * tracks and region outlines, with no error anywhere.
 *
 * So the stub below is deliberately stricter than the map: it goes ready only
 * on a later tick, after 'style.load' has been and gone.
 *
 *   npm install --no-save playwright && npm run smoke
 *
 * It builds dist and serves that build itself, on a port the OS picks. That is
 * not a convenience: pointing it at a server someone started earlier is how a
 * whole afternoon went into "the fix did not work" when the fix was fine and
 * the server was serving a copy of dist from before it. Set SMOKE_URL to test
 * a deployed origin instead.
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { SHIELD_DESIGNS } from '../assets/js/lib/route-shields.js';
import { buildArchive } from '../test/helpers/pmtiles-writer.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'smoke.gpx');
const MANY = path.join(ROOT, 'test', 'fixtures', 'many.gpx');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.gpx': 'application/gpx+xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

/*
 * A few hundred tiles over east Tennessee, deep enough to need a leaf
 * directory. Built here rather than fetched, so this needs no network.
 */
const SAMPLE_TILES = new Map();
for (let z = 6; z <= 12; z += 1) {
  const scale = 2 ** (z - 6);
  for (let x = 17 * scale; x < 17 * scale + Math.min(4, scale * 2); x += 1) {
    for (let y = 25 * scale; y < 25 * scale + Math.min(4, scale * 2); y += 1) {
      SAMPLE_TILES.set(`${z}/${x}/${y}`, new TextEncoder().encode(`tile ${z}/${x}/${y}`.padEnd(48, ' ')));
    }
  }
}
const SAMPLE_ARCHIVE = buildArchive(SAMPLE_TILES, { leaves: true });

/**
 * Build dist and serve it under /Map/, the subpath GitHub Pages uses, so the
 * relative asset paths resolve the same way they do in production.
 */
async function serveFreshBuild() {
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-dist.mjs')], { stdio: 'ignore' });
  const dist = path.join(ROOT, 'dist');

  /*
   * A token in the served build, which is not a detail.
   *
   * Route shields only exist in the Byways Topo vector style, and that style
   * only renders with a Mapbox token — so without one the whole feature is
   * absent from the page rather than broken on it, and every check written
   * against it passes by finding nothing. Which is exactly what happened: the
   * shields were reported generic on the live site while the smoke test was
   * green, because the smoke test was never looking at a map that had them.
   *
   * Written into dist rather than into the source tree: dist is disposable and
   * assets/js/token.js is somebody's real key.
   */
  await writeFile(path.join(dist, 'assets', 'js', 'token.js'),
    "window.ABMAP_MAPBOX_TOKEN = 'pk.smoke.notarealtoken';\n");

  /*
   * A small archive on the site, where a real one would be.
   *
   * Placed after the build rather than in the source tree, exactly as the
   * deploy does it, so it is not in the service worker's precache list - a
   * ninety-megabyte precache entry would be its own disaster. What it is here
   * to catch is the worker touching it at all: the Cache API rejects a 206 and
   * ignores Range on lookup, so an intercepted archive fails on every read or,
   * worse, returns the header where a tile was asked for.
   */
  await mkdir(path.join(dist, 'tiles'), { recursive: true });
  await writeFile(path.join(dist, 'tiles', 'byways.pmtiles'), Buffer.from(SAMPLE_ARCHIVE));
  await writeFile(path.join(dist, 'tiles', 'byways-no-range.pmtiles'), Buffer.from(SAMPLE_ARCHIVE));

  const server = createServer(async (request, response) => {
    let name = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    name = name.startsWith('/Map/') ? name.slice(5) : name.replace(/^\//, '');
    if (name === '' || name.endsWith('/')) name += 'index.html';
    const file = path.join(dist, name);
    if (!file.startsWith(dist)) return response.writeHead(403).end();
    try {
      const body = await readFile(file);
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      /*
       * Range requests, because one file here is read by byte range and
       * nothing else in this suite would notice if that stopped working.
       *
       * A server that answers 200 with the whole file for every request is
       * what most static fixtures are, and under one the archive reader still
       * works - it cuts the slice itself. Which means the service worker
       * mangling ranges, the thing the check below exists for, would be
       * invisible. So this behaves like a real host.
       */
      /*
       * One path is served whole whatever is asked of it, on purpose. Plenty
       * of static hosts behave that way, the archive reader copes by slicing
       * client-side, and it is the case where a worker caching the response
       * would write the entire archive into the app cache.
       */
      const asked = name.includes('no-range') ? null : /bytes=(\d+)-(\d*)/.exec(request.headers.range || '');
      if (asked) {
        const start = Number(asked[1]);
        const end = Math.min(asked[2] ? Number(asked[2]) : body.length - 1, body.length - 1);
        const slice = body.subarray(start, end + 1);
        return response.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${body.length}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        }).end(slice);
      }
      response.writeHead(200, {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      }).end(body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/Map/` };
}

const external = process.env.SMOKE_URL;
const hosted = external ? null : await serveFreshBuild();
const URL_UNDER_TEST = external || hosted.url;

/*
 * The viewer lives at map.html now that the root is a real homepage.
 *
 * Named once rather than spelled out at each navigation: three of these
 * pointed at the root and would have loaded a landing page while asking it
 * about layer rows.
 */
const MAP_URL = new URL('map.html', URL_UNDER_TEST).href;

const GL = `class E{constructor(){this._h={}}on(e,a,b){const f=b||a;
if(typeof a==='string'){(this._h[e+':'+a]||=[]).push(f)}else{(this._h[e]||=[]).push(f)}return this}
once(e,f){const g=(a)=>{this.off(e,g);f(a)};return this.on(e,g)}
off(e,f){const k=this._h[e];if(k){const i=k.indexOf(f);if(i>=0)k.splice(i,1)}return this}
fire(e,a){[...(this._h[e]||[])].forEach(f=>f(a))}}
class Bounds{constructor(w,s,e,n){this.w=w;this.s=s;this.e=e;this.n=n}
getWest(){return this.w}getSouth(){return this.s}getEast(){return this.e}getNorth(){return this.n}
extend(){return this}isEmpty(){return false}}
class Src{constructor(d){this._d=d}setData(d){this._d=d}}
// Mounted the way GL mounts it: a .maplibregl-popup container carrying the
// maxWidth the app asked for, with the card inside a .maplibregl-popup-content.
// Bare on the body it was as wide as the window, so every card under test laid
// out at 1280px instead of the 340 it gets over a map — and a line of text
// running under the close mark, which is a wrap-width bug, could not happen
// here at all.
class Popup{constructor(o){this._o=o||{}}setLngLat(){return this}
// Detaches on remove(), as the real one does. A no-op remove() left every
// popup in the DOM, so "the close button closes it" could not be tested at
// all — and a stale card is indistinguishable from a live one to a selector.
setDOMContent(n){const box=document.createElement('div');
box.className='maplibregl-popup maplibregl-popup-anchor-bottom';
if(this._o.maxWidth)box.style.maxWidth=this._o.maxWidth;
const inner=document.createElement('div');inner.className='maplibregl-popup-content';
inner.appendChild(n);box.appendChild(inner);
this._n=box;document.body.appendChild(box);return this}
addTo(){return this}remove(){this._n?.remove();return this}}
class M extends E{constructor(o){super();window.__mapOptions=o;this._s=new Map();this._l=new Map();this._img=new Map();
this._ready=false;window.__map=this;this._apply(o.style);
setTimeout(()=>{this.fire('style.load');           // sources NOT loaded yet
  setTimeout(()=>{this._ready=true;this.fire('styledata');this.fire('idle');this.fire('load')},30)},0)}
_apply(s){this._l.clear();this._s.clear();this._img.clear();if(s&&s.layers)for(const l of s.layers)this._l.set(l.id,l)}
loaded(){return this._ready}isStyleLoaded(){return this._ready}
// Mounts the control, as the real one does: calls onAdd and appends what it
// hands back. A no-op here meant the app's own two map tools were never in the
// DOM under test, so nothing could check them.
// Into a corner container, the way GL does it. Appended straight onto #map
// they piled up at its top-left corner under everything else that lives
// there, and a click on a map tool was intercepted by whatever overlay was
// on top — a collision the real layout does not have.
//
// Low z-index, also the way GL does it: its control groups sit inside the map
// and the side panel covers them. At 30 they floated over the panel and
// intercepted clicks on the panel's own close button, which is the mirror of
// the bug this container was added to fix.
addControl(c,p){if(c&&typeof c.onAdd==='function'){const n=c.onAdd(this);
if(n&&n.nodeType===1){const pos=p||'top-right';const id='ctrl-'+pos;
let box=document.getElementById(id);
if(!box){box=document.createElement('div');box.id=id;box.className='mapboxgl-ctrl-'+pos;
box.style.cssText='position:absolute;z-index:2;'+(pos.includes('top')?'top:8px;':'bottom:8px;')+(pos.includes('right')?'right:8px;':'left:8px;');
(document.getElementById('map')||document.body).appendChild(box)}
box.appendChild(n)}}return this}getCanvas(){return{style:{}}}getContainer(){return document.getElementById('map')}
// Throws before the style is up, as GL does. A stub that accepts an image at
// any time cannot catch a registrar called too early — which is exactly how a
// whole state's markers went missing with an empty catch block over the top.
addImage(i,d){if(!this._ready)throw new Error('Style is not done loading');this._img.set(i,d)}
removeImage(i){this._img.delete(i)}
hasImage(i){return this._img.has(i)}imageIds(){return [...this._img.keys()]}
addSource(i,c){this._s.set(i,new Src(c.data))}getSource(i){return this._s.get(i)}removeSource(i){this._s.delete(i)}
addLayer(l,b){if(b&&!this._l.has(b))throw new Error('before missing '+b);this._l.set(l.id,l)}
getLayer(i){return this._l.get(i)}removeLayer(i){this._l.delete(i)}layerIds(){return [...this._l.keys()]}
moveLayer(){}
// Recorded rather than ignored: a paint property that does not belong to the
// layer it is set on is a real bug (raster-opacity on a fill), and a stub that
// swallows the call cannot catch it.
setPaintProperty(i,p,v){const l=this._l.get(i);if(l){l.paint=l.paint||{};l.paint[p]=v}}
// Recorded for the same reason as paint: which image a shield layer ends up
// asking for is the whole of whether the route markers are right, and a stub
// that swallows the call cannot tell.
setLayoutProperty(i,p,v){const l=this._l.get(i);if(l){l.layout=l.layout||{};l.layout[p]=v}}
setStyle(s,o){this._ready=false;
  // Model both paths GL takes. With diff:true (the default) it applies the
  // difference and NEVER fires 'style.load' — it just drops the layers that are
  // not in the new style. Only a full reload fires it. Getting this wrong is
  // what let a broken basemap switch pass a green smoke test.
  const full=!o||o.diff===false;
  this._apply(s);
  setTimeout(()=>{if(full)this.fire('style.load');
    setTimeout(()=>{this._ready=true;this.fire('styledata');this.fire('idle')},30)},0)}
getStyle(){return{layers:[...this._l.values()]}}getBounds(){return new Bounds(-85,35,-83,37)}
getZoom(){return 12}getCenter(){return{lng:-84.28,lat:35.96}}fitBounds(){}flyTo(){}easeTo(){}jumpTo(){}
project(){return{x:100,y:100}}unproject(){return{lng:0,lat:0}}
// Answers with whatever the test has staged, the way a vector basemap answers
// with whatever is drawn under the tap. A stub that always returns nothing
// cannot tell "we asked and there was nothing" from "we never asked".
queryRenderedFeatures(p,o){const r=window.__rendered||[];const want=o&&o.layers;return want?r.filter(f=>!f.layer||want.includes(f.layer.id)):r}resize(){}remove(){}}
window.maplibregl={Map:M,NavigationControl:class{},ScaleControl:class{},GeolocateControl:class{},
FullscreenControl:class{},Popup,LngLatBounds:Bounds,
Marker:class{setLngLat(){return this}addTo(){return this}remove(){return this}}};
window.mapboxgl=window.maplibregl;`;

/*
 * A picture of one element, when asked for.
 *
 * Off by default - it is not a check and nothing here compares images. It is
 * for the case this suite cannot cover, which is whether a card that passes
 * every assertion actually looks right:
 *
 *   SMOKE_SHOTS=/tmp/shots npm run smoke
 */
const shot = async (locator, name) => {
  if (!process.env.SMOKE_SHOTS) return;
  await mkdir(process.env.SMOKE_SHOTS, { recursive: true });
  await locator.screenshot({ path: path.join(process.env.SMOKE_SHOTS, `${name}.png`) });
};

const failures = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures.push(label);
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

/*
 * Service workers are switched off for everything below, and switched back on
 * for the one check that is about them.
 *
 * Not squeamishness: `page.route` does not intercept requests that pass through
 * a service worker, so with the worker running, every mocked third-party
 * service above — the weather colour scale, the recreation sublayers, the
 * aurora feed — went to the real network instead of to its fixture. The suite
 * did not fail, it hung, halfway through and with no indication why.
 */
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await context.newPage();

/*
 * Read the saved collection the way the app stores it.
 *
 * Folders moved from localStorage into IndexedDB when a few megabytes of
 * string stopped being enough for a real collection. Checks below want to
 * confirm what was actually written to disk rather than what is in memory, so
 * they read the store itself - falling back to the old row, because a browser
 * without IndexedDB still keeps folders there.
 */
await context.addInitScript(() => {
  window.__readFolders = () => new Promise((resolve) => {
    const fromLocal = () => {
      try {
        const raw = JSON.parse(window.localStorage.getItem('ab-maps-folders-v1') || '{}');
        resolve(raw.folders || raw.items || []);
      } catch { resolve([]); }
    };
    if (typeof indexedDB === 'undefined') { fromLocal(); return; }
    const open = indexedDB.open('ab-maps-folders', 1);
    open.onerror = fromLocal;
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('state')) { fromLocal(); return; }
      const request = db.transaction('state', 'readonly').objectStore('state').get('ab-maps-folders-v1');
      request.onerror = fromLocal;
      request.onsuccess = () => (request.result ? resolve(request.result.folders || []) : fromLocal());
    };
  });
});

/*
 * Open the panel if it is shut, then show a tab.
 *
 * The panel now starts closed - it is a tool you reach for, and opening it
 * over the map before anyone asked made the map narrower for no reason. Every
 * tab click in this file used to assume it was already open, which was true by
 * accident: an earlier interaction happened to open it, and the first reload
 * that came afterwards took the assumption away.
 */
const showTab = async (name) => {
  if (await page.locator('#panel').isHidden()) {
    await page.locator('#panel-toggle').click();
    await page.waitForTimeout(120);
  }
  await page.click(`.panel-tab[data-tab="${name}"]`);
};

const consoleErrors = [];
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
page.on('console', (message) => { if (message.type() === 'error' && !/404/.test(message.text())) consoleErrors.push(message.text()); });
page.on('dialog', (dialog) => dialog.accept('Smoke folder'));

/*
 * A warning shaped exactly like the live one, including the motion field whose
 * convention this whole feature turns on: 245DEG is where the storm is coming
 * from, so the arrow and the words both have to say northeast.
 */
const ALERTS = {
  features: [{
    geometry: { type: 'Polygon', coordinates: [[[-84.5, 35.7], [-83.9, 35.7], [-83.9, 36.2], [-84.5, 36.2], [-84.5, 35.7]]] },
    properties: {
      id: 'smoke-1', event: 'Severe Thunderstorm Warning', severity: 'Severe',
      areaDesc: 'Anderson, Knox, Roane counties, TN',
      expires: '2026-08-24T02:15:00-04:00',
      parameters: { eventMotionDescription: ['2026-08-24T01:24:00-00:00...storm...245DEG...41KT...LAT...LON 3821 8454'] },
    },
  }],
};

/*
 * A gridded sky-cover series shaped like the NWS one, clouding over toward
 * dawn — enough for the Milky Way card to produce a real percentage rather
 * than falling back to its moon-only wording.
 */
const SKY_COVER = (() => {
  /*
   * Anchored to now, not to a date.
   *
   * A fixture pinned to one calendar day passes until the clock rolls past it
   * and then reports "cloud unknown" — which is the app's freshness guard
   * doing its job on stale readings, and looks exactly like the feature being
   * broken. Noon today, forward two days.
   */
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  return Array.from({ length: 48 }, (unused, index) => ({
    validTime: `${new Date(noon.valueOf() + index * 3600000).toISOString().replace('.000Z', '+00:00')}/PT1H`,
    value: index < 18 ? 10 : 85,
  }));
})();

/*
 * The rest of the gridpoint, shaped so the fog card has a night to find.
 *
 * Built from the same clock anchor as the sky cover above and for the same
 * reason. The shape is deliberate rather than plausible: the hours the sky
 * cover has clear are given a dewpoint depression of a few tenths and a light
 * wind, which is the textbook radiation-fog night, and the clouded hours are
 * given dry air. A fixture that fogged at every hour could not tell a card that
 * found the peak from a card that took the first row.
 */
const GRID_HOURS = (() => {
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  return Array.from({ length: 48 }, (unused, index) => {
    const validTime = `${new Date(noon.valueOf() + index * 3600000).toISOString().replace('.000Z', '+00:00')}/PT1H`;
    // Hours 14-17 after noon are the foggy ones: evening, clear, near-saturated.
    const foggy = index >= 14 && index <= 17;
    return {
      validTime,
      temperature: foggy ? 6 : 18,
      dewpoint: foggy ? 5.6 : 3,
      windSpeed: foggy ? 4 : 14,
    };
  });
})();

const gridSeries = (field, uom) => ({
  uom,
  values: GRID_HOURS.map((hour) => ({ validTime: hour.validTime, value: hour[field] })),
});

/*
 * Fire perimeters, as the feature service returns them. The layer this stands
 * in for used to ask a feature service for an image — which it cannot make —
 * so it answered 400 to every tile and drew nothing, for months, without
 * anything in the app saying so.
 */
const PERIMETERS = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { attr_IncidentName: 'Smoke Ridge', attr_GACC: 'SACC' },
    geometry: {
      type: 'Polygon',
      coordinates: [[[-84.4, 35.8], [-84.1, 35.8], [-84.1, 36.0], [-84.4, 36.0], [-84.4, 35.8]]],
    },
  }],
};

// A 1x1 PNG. Anything the page loads as an image gets this rather than the GL
// stub: a basemap thumbnail that fails to load removes itself, which would make
// "the previews are missing" and "the previews are switched off" identical from
// in here.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let pretendNewerBuild = false;

await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (route.request().resourceType() === 'image' && !url.startsWith(new URL(URL_UNDER_TEST).origin)) {
    return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
  }
  /*
   * The geocoder, answering a search the way Mapbox v5 does.
   *
   * Two features with the hierarchy in `context` rather than as siblings,
   * which is the shape open country returns and the one the parser has to get
   * right — a fixture that only carried sibling features would pass for
   * somewhere with a street address and nowhere with a campground.
   */
  // A forward search only: the same endpoint does reverse geocoding, and its
  // path is a coordinate pair — digits, commas and dots, never a letter.
  if (/api\.mapbox\.com\/geocoding\/v5\/mapbox\.places\/[^/]*[A-Za-z%][^/]*\.json/.test(url)) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ features: [
        {
          id: 'poi.1', text: 'Elkmont Campground', place_name: 'Elkmont Campground, Gatlinburg, Tennessee',
          place_type: ['poi'], center: [-83.58, 35.65],
          properties: { category: 'campground, park' },
          context: [{ id: 'place.9', text: 'Gatlinburg' }, { id: 'region.9', text: 'Tennessee', short_code: 'US-TN' }],
        },
        {
          id: 'place.2', text: 'Elkmont', place_name: 'Elkmont, Tennessee',
          place_type: ['place'], center: [-83.58, 35.66], bbox: [-83.62, 35.62, -83.54, 35.7],
          context: [{ id: 'region.9', text: 'Tennessee', short_code: 'US-TN' }],
        },
      ] }),
    });
  }
  /*
   * The weather colour scales, as GeoServer really answers them.
   *
   * Shape captured from the live NDFD service, including the nodata sentinel
   * it opens with — a fixture that only holds the tidy entries would pass
   * whether or not the panel filters them out.
   */
  if (/GetLegendGraphic.*application\/json/.test(url)) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ Legend: [{ layerName: 'temp', rules: [{ symbolizers: [{ Raster: {
        colormap: { entries: [
          { label: '', quantity: '-500', color: '#000000' },
          ...Array.from({ length: 12 }, (unused, step) => ({
            label: String(-40 + step * 12), quantity: String(-40 + step * 12),
            color: `#${(0x2b2bff + step * 0x001100).toString(16).slice(-6)}`,
          })),
        ] },
      } }] }] }] }),
    });
  }
  /*
   * One recreation sublayer per request, as USGS publishes them. The stub
   * answers each with a single point so the merge — and the icon that comes
   * from which sublayer answered — is what the check is looking at.
   */
  /*
   * An ArcGIS legend, in the shape those services publish it.
   *
   * The BLM, MVUM and recreation layers all declare a `legendJSON`, and until
   * now nothing in the app read it — the row rendered its note and no key,
   * which is indistinguishable from a service that answered with nothing. This
   * fixture is what proves the difference.
   */
  /*
   * An ArcGIS identify, in the two different shapes the road services use.
   *
   * BLM names its designations in fields and puts the road class in the
   * SUBLAYER name; the Forest Service spreads permission across a column per
   * vehicle with a `_datesopen` beside each. Both are read off the live
   * services rather than from their printed legends, and the card has to make
   * one readable answer out of the pair.
   */
  if (/MapServer\/identify/.test(url)) {
    const blm = /gis\.blm\.gov/.test(url);
    const nothingOpen = await page.evaluate(() => Boolean(window.__identifyNothingOpen)).catch(() => false);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results: blm
        ? [{
          layerId: 1,
          layerName: 'Roads Managed for Limited Public Motorized Use',
          attributes: {
            OBJECTID: 4411,
            ROUTE_PRMRY_NM: 'Cathedral Valley Road',
            PLAN_ASSET_CLASS: 'Road',
            PLAN_OHV_ROUTE_DSGNTN: 'Limited',
            OHV_ROUTE_DSGNTN_LIM: 'Licensed vehicles only',
            OHV_DSGNTN_LIM_EXPLAIN: 'Street-legal vehicles only; no OHV use.',
            PLAN_SEASON_RSTRCT_CODE: 'Closed when wet',
            OBSRVE_SRFCE_TYPE: 'Native',
            Shape_Length: 8123.4,
            GlobalID: 'ignored',
            NEPA_DOC_NUM: '<Null>',
          },
        }]
        : [{
          layerId: 1,
          layerName: 'Motor Vehicle Use Map: Roads',
          attributes: {
            OBJECTID: 91,
            name: 'GILFORD',
            seasonal: 'yearlong',
            surfacetype: 'NAT - NATIVE MATERIAL',
            operationalmaintlevel: '2 - HIGH CLEARANCE VEHICLES',
            jurisdiction: 'FS - FOREST SERVICE',
            motorcycle: nothingOpen ? '' : 'motorcycle',
            motorcycle_datesopen: nothingOpen ? '' : '01/01-12/31',
            otherwheeled_ohv: nothingOpen ? '' : 'otherwheeled_ohv',
            otherwheeled_ohv_datesopen: nothingOpen ? '' : '05/15-10/31',
            tracked_ohv_lt50inches: '',
            tracked_ohv_lt50_datesopen: '',
          },
        }] }),
    });
  }

  if (/MapServer\/legend\?f=pjson/.test(url)) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ layers: [{
        layerId: 0,
        layerName: 'Roads',
        legend: [
          { label: 'Open to all vehicles', imageData: PIXEL.toString('base64'), contentType: 'image/png' },
          { label: 'Open seasonally', imageData: PIXEL.toString('base64'), contentType: 'image/png' },
          // Unlabelled rows are published by these services and must not draw a
          // swatch with nothing beside it.
          { label: '   ', imageData: PIXEL.toString('base64'), contentType: 'image/png' },
        ],
      }] }),
    });
  }

  if (/structures\/MapServer\/(\d+)\/query/.test(url)) {
    const sub = Number(/structures\/MapServer\/(\d+)\/query/.exec(url)[1]);
    return route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-84.28 + sub / 1000, 35.96] },
          properties: { name: `Site ${sub}` },
        }],
      }),
    });
  }
  // NOAA space weather, in the shapes the live services publish.
  if (/ovation_aurora_latest/.test(url)) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        'Observation Time': '2026-08-26T00:00:00Z',
        'Forecast Time': '2026-08-26T00:30:00Z',
        // The smoke pin is -84.28, 35.96 — which is 276 east, latitude 36.
        coordinates: [[0, -90, 0], [276, 36, 12], [276, 37, 9]],
      }),
    });
  }
  if (/noaa-planetary-k-index/.test(url)) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        ['time_tag', 'Kp', 'Kp_fraction'],
        ['2026-08-25T18:00:00', '2', '2.00'],
        ['2026-08-25T21:00:00', '5', '4.67'],
      ]),
    });
  }
  if (/WFIGS_Interagency_Perimeters/.test(url)) {
    return route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify(PERIMETERS) });
  }
  if (/\/points\//.test(url)) {
    return route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({ properties: {
        forecast: `${URL_UNDER_TEST}forecast`,
        forecastGridData: `${URL_UNDER_TEST}gridpoint`,
        relativeLocation: { properties: { city: 'Oak Ridge', state: 'TN' } },
      } }),
    });
  }
  if (/gridpoint/.test(url)) {
    return route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({ properties: {
        skyCover: { uom: 'wmoUnit:percent', values: SKY_COVER },
        temperature: gridSeries('temperature', 'wmoUnit:degC'),
        dewpoint: gridSeries('dewpoint', 'wmoUnit:degC'),
        windSpeed: gridSeries('windSpeed', 'wmoUnit:km_h-1'),
      } }),
    });
  }
  if (/alerts\/active/.test(url)) {
    return route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify(ALERTS) });
  }
  // deployed.txt is written by the deploy workflow, so it never exists locally.
  // Serving a realistic one keeps this a test of whether the stamp renders
  // rather than a test of whether someone has run a deploy.
  if (/deployed\.txt/.test(url)) {
    return route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: 'commit: 0123456789abcdef\nbuilt: 2026-08-24T00:00:00Z\n',
    });
  }
  /*
   * Pretend the server has moved on.
   *
   * The stale-page notice can only be exercised by making build.json disagree
   * with the fingerprint the page already loaded, which is precisely the state
   * GitHub Pages leaves a reader in for ten minutes after every deploy.
   */
  if (pretendNewerBuild && /build\.json/.test(url)) {
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ build: 'deadbeef' }),
    });
  }
  if (url.startsWith(new URL(URL_UNDER_TEST).origin)) return route.continue();
  if (/\.css($|\?)/.test(url)) {
    /*
     * The engine's stylesheet, reduced to the one rule that collides with ours.
     *
     * Empty CSS here meant the load order could never be wrong in this suite,
     * and the popup card came back #fff on the real site in dark mode twice
     * before anybody found it. Same specificity as ours, so whichever loads
     * last takes the background — which is exactly what is being checked.
     */
    return route.fulfill({
      status: 200,
      contentType: 'text/css',
      body: '.mapboxgl-popup-content,.maplibregl-popup-content{background:#fff;color:#000}',
    });
  }
  if (/api\.mapbox\.com\/geocoding/.test(url)) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ features: [{ place_type: ['region'], text: 'Tennessee', properties: { short_code: 'US-TN' } }] }),
    });
  }
  return route.fulfill({ status: 200, contentType: 'application/javascript', body: GL });
});

await page.goto(MAP_URL, { waitUntil: 'networkidle' });

/*
 * Open a layer group without toggling it.
 *
 * Clicking the summary flips a <details>, so two checks that each "open" the
 * same group leave it shut for the second one — which fails as "the layer is
 * not there" rather than as "the group is closed". Setting `open` is
 * idempotent, which is what a set-up step should be.
 */
const openGroup = async (name) => {
  await page.locator('summary', { hasText: name }).first()
    .evaluate((node) => { node.parentElement.open = true; });
  await page.waitForTimeout(200);
};

await page.waitForTimeout(1200);

const state = () => page.evaluate(() => {
  const map = window.__map;
  const ids = map.layerIds();
  return {
    folderFeatures: map.getSource('folders')?._d?.features?.length ?? null,
    folderPoints: (map.getSource('folders')?._d?.features || []).filter((f) => f.geometry?.type === 'Point').length,
    folderLines: (map.getSource('folders')?._d?.features || []).filter((f) => /Line/.test(f.geometry?.type || '')).length,
    folderLayers: ids.filter((id) => id.startsWith('folders')).length,
    documentLayers: ids.filter((id) => /-point$|-line$/.test(id)
      && !/^(folders|scratch|region|road)/.test(id)).length,
    regionLayers: ids.filter((id) => id.startsWith('region')).length,
  };
});

console.log('\nImport a file and file it into a folder');
await page.setInputFiles('#file-input', FIXTURE);
await page.waitForTimeout(1000);
await page.click('#import-ask button:has-text("New folder")').catch(() => {});
await page.waitForTimeout(700);

const afterImport = await state();
check('waypoints reached the map', afterImport.folderPoints, 2);
// Filing takes the track too, so a drive imported on the phone syncs whole.
check('and the track was filed with them', afterImport.folderLines, 1);
/*
 * A waypoint still in an open file is drawn like a saved one - white disc,
 * coloured ring, its own symbol. It used to be a bare coloured dot, so the
 * same tower looked like two different things either side of being filed.
 */
const openFilePins = await page.evaluate(() => {
  const ids = window.__map.layerIds();
  const icon = ids.find((id) => /-point-icon$/.test(id) && !id.startsWith('folders'));
  const disc = ids.find((id) => /-point$/.test(id) && !id.startsWith('folders'));
  const spec = (id) => window.__map._l?.get(id) || null;
  return {
    icon: Boolean(icon),
    named: spec(icon)?.layout?.['icon-image']?.[1] ?? null,
    fill: spec(disc)?.paint?.['circle-color'] ?? null,
    ringed: Boolean(spec(disc)?.paint?.['circle-stroke-color']),
  };
});
check('an open file draws its waypoints with a symbol', openFilePins.icon, true);
// Bigger as you zoom in: at street zoom the symbol matters most, and it was
// the same sixteen pixels there as on a state-wide view.
const pinGrowth = await page.evaluate(() => {
  const spec = window.__map._l?.get('folders-point');
  const icon = window.__map._l?.get('folders-point-icon');
  const at = (ramp, zoom) => {
    const stops = ramp.slice(3);
    for (let i = 0; i < stops.length; i += 2) if (stops[i] === zoom) return stops[i + 1];
    return null;
  };
  return {
    disc: [at(spec.paint['circle-radius'], 8), at(spec.paint['circle-radius'], 14)],
    glyph: [at(icon.layout['icon-size'], 8), at(icon.layout['icon-size'], 14)],
  };
});
check('a pin grows past zoom 10', pinGrowth.disc[1] > pinGrowth.disc[0] * 1.8, true);
check('and its symbol grows with it', pinGrowth.glyph[1] > pinGrowth.glyph[0] * 1.8, true);
check('from the pin set', openFilePins.named, 'pin-');
check('on a white disc', openFilePins.fill, '#ffffff');
check('with the colour as its ring', openFilePins.ringed, true);
/*
 * The folder row: a name that wraps, a count, an eye, and one edit mark. No
 * swatch, and no description under each pin - a folder of a hundred notes
 * was a wall of grey text.
 */
const folderHead = await page.evaluate(() => {
  const head = document.querySelector('#folder-list .folder-head');
  return {
    order: [...head.children].map((node) => node.className.split(' ').find((c) => c.startsWith('folder-'))),
    // Counted as "anything but the five", not by the removed classes' names:
    // the selectors test refuses a class nothing in the app produces any more.
    extras: head.children.length,
    editIsMark: Boolean(head.querySelector('.folder-menu-button svg')) && head.querySelector('.folder-menu-button').textContent.trim() === '',
    prose: document.querySelectorAll('#folder-list .folder-body > p').length,
  };
});
check('the folder row is name, count, eye, edit', folderHead.order, ['folder-disclosure', 'folder-name', 'folder-count', 'folder-eye', 'folder-menu-button']);
check('and nothing else - no swatch beside the name', folderHead.extras, 5);
check('and edit as a mark rather than a word', folderHead.editIsMark, true);
check('and nothing written under the pins', folderHead.prose, 0);

/*
 * Folding a folder folds everything open on it.
 *
 * The style editor is a sibling of the folder's body rather than part of it,
 * so hiding the body left it standing - and on a phone that editor is the
 * whole screen. The pins went away below the fold, nothing visible changed,
 * and the folder read as refusing to close.
 */
const firstFolder = (await page.locator('#folder-list .folder').first().getAttribute('data-folder'));
const folderBox = () => page.locator(`.folder[data-folder="${firstFolder}"]`)
  .evaluate((node) => Math.round(node.getBoundingClientRect().height));
await page.locator(`.folder[data-folder="${firstFolder}"] .folder-menu-button`).click();
await page.waitForTimeout(400);
check('the folder editor opens', await page.locator('.style-editor').count(), 1);
const openHeight = await folderBox();

await page.locator(`.folder[data-folder="${firstFolder}"] .folder-disclosure`).click();
await page.waitForTimeout(400);
check('folding it closes the editor too', await page.locator('.style-editor').count(), 0);
const foldedHeight = await folderBox();
check('so the folder really is one row high', foldedHeight < 90, true);
check('and not still carrying the editor', foldedHeight < openHeight / 2, true);

// But a folded folder can still be opened to rename it: folding is the
// transition, not a rule about folded folders.
await page.locator(`.folder[data-folder="${firstFolder}"] .folder-menu-button`).click();
await page.waitForTimeout(400);
check('a folded folder can still be renamed without unfolding',
  await page.locator(`.folder[data-folder="${firstFolder}"] .folder-rename`).isVisible(), true);
await page.locator(`.folder[data-folder="${firstFolder}"] .folder-disclosure`).click();
await page.waitForTimeout(300);
check('and unfolds again', await page.locator(`.folder[data-folder="${firstFolder}"]`)
  .evaluate((node) => node.classList.contains('is-collapsed')), false);

/*
 * Folders can be filed inside folders. The panel shows the tree - a folder,
 * then what is under it - and hiding a parent takes its branch off the map
 * without touching what each folder is set to on its own.
 */
const folderIds = () => page.locator('#folder-list .folder').evaluateAll(
  (nodes) => nodes.map((node) => node.dataset.folder));
const beforeNew = await folderIds();
await page.locator('#new-folder').click();
await page.waitForTimeout(400);
const child = (await folderIds()).find((id) => !beforeNew.includes(id));
const parent = beforeNew[0];

await page.locator(`.folder[data-folder="${child}"] .folder-menu-button`).click();
await page.waitForTimeout(300);
const nestOptions = await page.locator(`.folder[data-folder="${child}"] .folder-parent option`)
  .evaluateAll((nodes) => nodes.map((node) => node.value));
check('a new folder is offered every folder it could go inside',
  nestOptions[0] === '' && nestOptions.includes(parent), true);
check('and never itself', nestOptions.includes(child), false);

await page.selectOption(`.folder[data-folder="${child}"] .folder-parent`, parent);
await page.waitForTimeout(500);
const row = page.locator(`.folder[data-folder="${child}"]`);
check('filing it inside another draws it one level in', await row.getAttribute('data-depth'), '1');
check('and marks it as nested, so the indent is not an accident',
  (await row.getAttribute('class')).includes('is-nested'), true);
check('the tree reads parent first, then what is under it',
  (await folderIds()).indexOf(parent) + 1, (await folderIds()).indexOf(child));

// Hiding the parent: the child's own switch is untouched, but it stops drawing.
await page.locator(`.folder[data-folder="${parent}"] .folder-eye`).click();
await page.waitForTimeout(400);
const childEye = page.locator(`.folder[data-folder="${child}"] .folder-eye`);
check('hiding a parent leaves the child set to show', await childEye.getAttribute('aria-pressed'), 'true');
check('but says the switch is not the one deciding',
  (await childEye.getAttribute('class')).includes('is-dimmed'), true);
check('and the title explains why nothing is on the map',
  /above it is hidden/.test(await childEye.getAttribute('title')), true);
await page.locator(`.folder[data-folder="${parent}"] .folder-eye`).click();
await page.waitForTimeout(300);
check('showing it again clears that', (await childEye.getAttribute('class')).includes('is-dimmed'), false);

// A parent may not be filed inside its own child, or the branch comes loose.
await page.locator(`.folder[data-folder="${parent}"] .folder-menu-button`).click();
await page.waitForTimeout(300);
check('a folder is never offered a place inside its own branch',
  (await page.locator(`.folder[data-folder="${parent}"] .folder-parent option`)
    .evaluateAll((nodes) => nodes.map((node) => node.value))).includes(child), false);
await shot(page.locator('#folder-list'), 'folder-tree');

// Put it back, so the checks below count the folders they expect. The suite
// already answers every dialog, so this one needs no handler of its own.
await page.locator(`.folder[data-folder="${child}"] .folder-menu-button`).click();
await page.waitForTimeout(300);
await page.locator(`.folder[data-folder="${child}"] .editor-folder-actions button`, { hasText: 'Delete' }).click();
await page.waitForTimeout(400);
check('and it can be deleted again', (await folderIds()).includes(child), false);

/*
 * The symbol picker searches, because there are a hundred and seventy of them
 * now and a grid that size cannot be scanned. What is checked is the word a
 * person would actually type: "building" has to bring back the house and the
 * church, whose names do not contain it.
 */
await page.locator('#folder-list .folder-menu-button').first().click();
await page.waitForTimeout(300);
check('the picker offers a search', await page.locator('.style-editor .icon-search').count(), 1);
const grouped = await page.locator('.style-editor .icon-group-label').count();
check('and groups the symbols when nothing is typed', grouped > 6, true);
await page.fill('.style-editor .icon-search', 'building');
await page.waitForTimeout(200);
const buildingSearch = await page.evaluate(() => ({
  heading: document.querySelector('.style-editor .icon-group-label')?.textContent.trim(),
  names: [...document.querySelectorAll('.style-editor .icon-choice')].map((n) => n.getAttribute('aria-label')),
}));
check('a search says how many it found', /matches$/.test(buildingSearch.heading || ''), true);
check('and finds buildings whose names are not "building"',
  ['House', 'Church', 'School', 'Hospital'].every((name) => buildingSearch.names.includes(name)), true);
await page.fill('.style-editor .icon-search', 'xyzzy');
await page.waitForTimeout(200);
check('a query that matches nothing says so',
  await page.locator('.style-editor .icon-group-label', { hasText: 'Nothing matches that' }).count(), 1);
await page.fill('.style-editor .icon-search', '');
await page.waitForTimeout(200);
check('and clearing it brings the groups back',
  await page.locator('.style-editor .icon-group-label').count(), grouped);
await shot(page.locator('.style-editor'), 'icon-picker');

/*
 * The colours. Eighteen bold ones plus "no colour", and six of them are
 * GaiaGPS's own to the exact hex so an imported pin lands on a swatch. They
 * are compared as colours rather than as strings, because Gaia writes its hex
 * in capitals and a pin used to open with nothing selected because of it.
 */
const swatches = await page.evaluate(() => {
  const row = document.querySelector('.style-editor .swatch-row');
  const nodes = [...(row?.querySelectorAll('.swatch') || [])];
  return {
    total: nodes.length,
    inherit: nodes.filter((node) => node.classList.contains('is-inherit')).length,
    colors: nodes.map((node) => node.dataset.color).filter(Boolean),
  };
});
check('the colour row offers eighteen and a way to clear it', swatches.total, 19);
check('one of which is "no colour"', swatches.inherit, 1);
check('GaiaGPS\'s own six are all there, so an import lands on a swatch',
  ['#f42410', '#ffef00', '#4abd32', '#0479ff', '#2d3fc7', '#784d3e']
    .every((hex) => swatches.colors.includes(hex)), true);
check('and no colour is offered twice', new Set(swatches.colors).size, swatches.colors.length);
await shot(page.locator('.style-editor .swatch-row'), 'colour-row');

await page.keyboard.press('Escape');
await shot(page.locator('#folder-list .folder').first(), 'folder-row');
check('folder layers present', afterImport.folderLayers, 5);
check('document layers present', afterImport.documentLayers > 0, true);

/*
 * Import opens a file. It does not wait to be given one.
 *
 * It spent a while as "Add from an open file…", hidden until a document was
 * already loaded - so the one button in this tab about bringing data in was
 * invisible to anyone who had not already brought some in another way. Both
 * halves are checked, because either alone still leaves it wrong: a permanent
 * button that opens the old picker would answer an empty tab with an error
 * toast, which is how it came to be hidden the first time.
 */
await showTab('folders');
await page.waitForTimeout(200);
// Scoped to the tab: the offline panel builds a .folder-actions of its own.
const actions = await page.evaluate(() => [...document.querySelectorAll('#tab-folders .folder-actions .button')]
  .map((node) => ({
    label: node.textContent.trim(), icon: Boolean(node.querySelector('svg')), hidden: node.hidden,
    top: Math.round(node.getBoundingClientRect().top),
    clipped: [...node.querySelectorAll('span')].some((span) => span.scrollWidth > span.clientWidth + 1),
  })));
check('the folder actions are New folder, New trip and Import',
  actions.map((a) => a.label), ['New folder', 'New trip', 'Import']);
check('each carrying a mark of its own', actions.every((a) => a.icon), true);
check('and Import is there before anything has been imported',
  actions.find((a) => a.label === 'Import')?.hidden, false);
// Two rows: the two "new" buttons together, Import on a line of its own. Three
// on one line cut "New folder" short at the panel's width.
check('New folder and New trip share a line', actions[0].top === actions[1].top, true);
check('and Import has the next to itself', actions[2].top > actions[1].top, true);
check('with every word intact', actions.filter((a) => a.clipped).map((a) => a.label), []);
await shot(page.locator('#tab-folders .folder-actions'), 'folder-actions');

/*
 * Filing an already-open file happens on that file's own row.
 *
 * Which is the question the old button asked first - "which open file?" - and
 * the row has already answered it, so the picker opens on that file.
 */
await page.locator('#files-block > summary').click();
await page.waitForTimeout(200);
const fileRow = page.locator('#loaded-list .map-entry').first();
check('an open file offers to file itself into a folder',
  await fileRow.locator('[title="File this into a folder"]').count(), 1);
await shot(fileRow, 'loaded-file-row');
await fileRow.locator('[title="File this into a folder"]').click();
await page.waitForTimeout(300);
const picked = await page.evaluate(() => {
  const picker = document.querySelector('#folder-list .picker');
  if (!picker) return null;
  const source = picker.querySelector('select');
  return {
    chosen: source.options[source.selectedIndex]?.textContent.trim(),
    // Compared against the row rather than a literal: the claim is that the
    // picker opens on the file you pressed, whatever that file is called.
    row: document.querySelector('#loaded-list .map-entry .map-entry-name')?.textContent.trim(),
  };
});
check('and the picker opens on the file that asked for it', picked?.chosen, picked?.row);
check('which is a file, not an empty select', Boolean(picked?.row), true);
await page.locator('#folder-list .picker .button-ghost').click();
await page.waitForTimeout(200);
await page.locator('#files-block > summary').click();
await page.waitForTimeout(200);

/*
 * Nine basemap names say almost nothing about which one you want. One tile of
 * each says it immediately — so every basemap has to have a preview, including
 * the one nothing can render server-side.
 */
/*
 * A layer that only exists inside one state.
 *
 * Kentucky publishes three-inch aerial and five-foot lidar hillshade, and both
 * stop at the state line. Fifty states of those in one flat list would be
 * unusable, so an overlay names the states it covers and the panel offers it
 * only inside them. The stub map sits over Tennessee, so none of them should be
 * on offer here — which is the half of the behaviour that is easy to get wrong
 * and impossible to notice.
 */
/*
 * The route markers, end to end.
 *
 * Reported twice as "all states are generic". Everything under it was tested —
 * the expression builders, the blanks, the contrast of every number — and none
 * of it was looking at a map with shields on it, because they only exist in the
 * vector style and the vector style needs a token. So this asks the one
 * question all of that was standing in for: after the map has settled over
 * Tennessee, which image is the shield layer actually asking for?
 */
console.log('\nThe route markers follow the state the map is over');
await page.waitForTimeout(1500);
const shields = await page.evaluate(() => {
  const map = window.__map;
  const layer = map.getLayer('road-shield');
  return {
    exists: Boolean(layer),
    resolvedState: window.__abmapState || null,
    iconImage: JSON.stringify(layer?.layout?.['icon-image'] || null),
    tennesseeImages: map.imageIds().filter((id) => id.includes('st-TN')),
    anyStateImages: map.imageIds().filter((id) => id.startsWith('abmap-shield-')).length,
  };
});
check('the shield layer is on the map at all', shields.exists, true);

/*
 * Every image the layer can name, present before anything asks for it.
 *
 * Reported from the live site as five lines of `Image "abmap-shield-state-2"
 * could not be loaded`. Those are the *generic* markers — the ones that need no
 * state and no network — so a map that cannot draw them draws no shields at
 * all, which is a different and worse failure than drawing the wrong ones.
 *
 * `state` and `default` are drawn on a canvas and must be there the moment
 * registration returns; `us` and `interstate` come from PNG blanks and are
 * allowed to arrive late, so they are given a moment.
 */
/*
 * Enumerated from SHIELD_DESIGNS rather than from a list written out here.
 *
 * The list used to be a literal four names, so adding the brown scenic and
 * forest designs left this check blind to precisely the two that were new -
 * an enumeration that does not enumerate is the same failure as a find pattern
 * that does not compile, and it passes just as quietly.
 */
const baseImages = await page.evaluate(async (designs) => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const have = new Set(window.__map.imageIds());
  const want = [];
  for (const design of designs) {
    for (const length of [2, 3, 4]) want.push(`abmap-shield-${design}-${length}`);
  }
  return want.filter((id) => !have.has(id));
}, SHIELD_DESIGNS);
check('no generic shield image is missing', baseImages, []);
check('and that covers the ref-chosen designs too',
  SHIELD_DESIGNS.includes('scenic') && SHIELD_DESIGNS.includes('forest'), true);
check('Tennessee images are registered', shields.tennesseeImages.length > 0, true);
check('and the layer asks for Tennessee, not the generic design',
  /st-TN/.test(shields.iconImage), true);
check('and it knows it has applied that state, not merely resolved it',
  await page.evaluate(async () => (await window.abmapShields()).drawnFor), 'TN');

/*
 * And it survives the style being rebuilt under it.
 *
 * This is the check the previous one was quietly standing in for. The state was
 * applied exactly once, by the geocoder callback, and the style is built with
 * no state in it — so anything that rebuilt the layers put the generic markers
 * back permanently. On a real map that is the ordinary case rather than an edge
 * one: the vector style finishes loading *after* the geocoder answers, so the
 * markers were generic from the first frame and there was no second chance.
 *
 * Knocking the layer back to the generic expression and firing 'style.load' is
 * what a basemap swap back to Byways Topo does.
 */
const rebuilt = await page.evaluate(async () => {
  const map = window.__map;
  map.setLayoutProperty('road-shield', 'icon-image', ['concat', 'abmap-shield-', 'state', '-2']);
  const knocked = JSON.stringify(map.getLayer('road-shield')?.layout?.['icon-image']);
  map.fire('style.load');
  await new Promise((resolve) => setTimeout(resolve, 200));
  return {
    knocked,
    recovered: JSON.stringify(map.getLayer('road-shield')?.layout?.['icon-image']),
    drawnFor: (await window.abmapShields()).drawnFor,
  };
});
check('the generic expression really was put back', /st-TN/.test(rebuilt.knocked), false);
check('a style rebuild restores the state markers', /st-TN/.test(rebuilt.recovered), true);
check('and the record of what is drawn follows it', rebuilt.drawnFor, 'TN');

/*
 * And when the style event arrives before the layers do.
 *
 * This is the original failure, in the order it really happens. The lookup
 * answers in a couple of hundred milliseconds and the vector style takes
 * longer, so on a real map the state is known while `road-shield` does not yet
 * exist — there is nothing to set it on. That used to be the end of it: the
 * state had been recorded as handled, so every later pass returned early and
 * the markers stayed generic for the life of the page.
 *
 * Taking the layer away, firing the style event without it, and only then
 * putting it back is that sequence exactly.
 */
const late = await page.evaluate(async () => {
  const map = window.__map;
  const layer = map.getLayer('road-shield');
  map.removeLayer('road-shield');
  map.fire('style.load');
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Back, as the style finishing its load would put it: generic, because that
  // is how the style document is written.
  map.addLayer({ ...layer, layout: { ...layer.layout, 'icon-image': ['concat', 'abmap-shield-', 'state', '-2'] } });
  const beforeIdle = JSON.stringify(map.getLayer('road-shield')?.layout?.['icon-image']);
  map.fire('idle');
  await new Promise((resolve) => setTimeout(resolve, 50));
  return {
    beforeIdle,
    afterIdle: JSON.stringify(map.getLayer('road-shield')?.layout?.['icon-image']),
  };
});
check('the layer comes back generic, as the style document builds it',
  /st-TN/.test(late.beforeIdle), false);
check('and a settled frame points it at the state anyway',
  /st-TN/.test(late.afterIdle), true);

/*
 * And a shield image that goes missing comes back.
 *
 * This is the symptom, reported three times: a road labelled with a bare "70"
 * and no marker under it, because GL drops an icon whose image is absent and
 * keeps the text. Three different causes have been found and fixed for it and
 * it returned anyway, so the map now checks its own images every settled frame
 * rather than trusting that registration went well.
 *
 * Taking an image away and firing idle is that, without needing to reproduce
 * whichever cause it was.
 */
const healed = await page.evaluate(async () => {
  const map = window.__map;
  const victim = map.imageIds().find((id) => id.startsWith('abmap-shield-'));
  map.removeImage(victim);
  const gone = !map.hasImage(victim);
  map.fire('idle');
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { victim, gone, back: map.hasImage(victim) };
});
check('an image really was removed', healed.gone, true);
check('and a settled frame puts it back', healed.back, true);

/*
 * And it never stops being willing to.
 *
 * The first healer counted settled frames where anything was missing and gave
 * up after twelve. Most of these images are PNG blanks fetched over the
 * network, so they are all legitimately absent for the first second, and
 * `idle` fires several times a second — the budget was gone before the first
 * blank landed, and the healer was dead for the rest of the page's life.
 * Whatever had registered kept working until something was lost: "it was
 * working for a while", exactly.
 *
 * The guard is now a rate limit rather than a cap, so the property worth
 * checking is that repair still happens after a long run of frames. Three
 * removals spread past the throttle: if any cap existed, the last would not
 * come back.
 */
const repeatedly = await page.evaluate(async () => {
  const map = window.__map;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const results = [];

  for (let round = 0; round < 3; round += 1) {
    // Far more settled frames than any cap would have survived.
    for (let tick = 0; tick < 30; tick += 1) map.fire('idle');
    // Past the once-a-second throttle, so the next attempt is allowed.
    await wait(1100);

    const victim = map.imageIds().find((id) => id.startsWith('abmap-shield-'));
    map.removeImage(victim);
    map.fire('idle');
    await wait(300);
    results.push(map.hasImage(victim));
  }
  return results;
});
check('it repairs every time, however long the page has been open',
  repeatedly, [true, true, true]);

console.log('\nA state layer is offered only inside its state');
const scoped = await page.evaluate(async () => {
  const config = await import('./assets/js/config.js');
  return config.OVERLAYS.filter((entry) => entry.states)
    .map((entry) => ({ id: entry.id, states: entry.states }));
});
check('the catalogue has some', scoped.length > 0, true);

await showTab('layers');
await page.waitForTimeout(600);
const offered = await page.evaluate((ids) => ids.filter((id) => {
  const rows = [...document.querySelectorAll('#overlay-list .layer-option-label')];
  return rows.some((node) => node.dataset.layer === id);
}), scoped.map((entry) => entry.id));
/*
 * Both halves, now that more than one state has data.
 *
 * The map sits over Tennessee, so Tennessee's own layers belong in the list
 * and every other state's does not. Checked as "exactly the TN ones" rather
 * than "none of them", because "none" passed for months by accident — it was
 * true of a catalogue with one state in it however the scoping behaved.
 */
check('the state whose ground is on screen has its layers offered',
  offered.sort(), scoped.filter((entry) => entry.states.includes('TN')).map((entry) => entry.id).sort());
check('and no other state\u2019s are',
  offered.some((id) => scoped.find((entry) => entry.id === id)?.states.some((code) => code !== 'TN')),
  false);
check('while the layers that apply everywhere still are',
  await page.locator('#overlay-list .layer-row').count() > 0, true);

// One heading for all of them, with the state on each row: fifty headings of
// two layers each is what the old grouping would have become.
/*
 * Picked by layer id, not by punctuation.
 *
 * Matching labels containing a bracket used to mean "a state layer" and now
 * means nothing - "Aerial (3 in)" and "Roads & trails (USGS)" both have one,
 * and only the first is a state's. The ids of the state-scoped layers are
 * already known here, so they are what the check asks for.
 */
const stateRows = await page.evaluate((ids) => {
  const heads = [...document.querySelectorAll('.layer-group-summary span:first-child')]
    .map((node) => node.textContent.trim());
  const named = [...document.querySelectorAll('#overlay-list .layer-option-label')]
    .filter((node) => ids.includes(node.dataset.layer))
    .map((node) => node.textContent.trim());
  return { heads, named };
}, scoped.filter((entry) => entry.states.includes('TN')).map((entry) => entry.id));
check('state data sits under one heading, not one per state',
  stateRows.heads.includes('State data'), true);
check('and no heading is a state name', stateRows.heads.includes('Tennessee'), false);
check('while every state row says which state it is',
  stateRows.named.length > 0 && stateRows.named.every((text) => text.endsWith('(Tennessee)')), true);

/*
 * The panel is shut until asked for, and opens on Layers.
 *
 * Both halves matter and both were wrong: it opened over the map on every wide
 * screen, and it opened on Folders - so the first thing anybody saw was an
 * empty list of their own files rather than the map they came for. The toggle
 * has to be reachable on a wide screen too, or closing by default strands a
 * desktop with no way back in.
 */
console.log('\nThe panel waits to be asked, and opens on Layers');
{
  const fresh = await context.newPage();
  await fresh.goto(MAP_URL, { waitUntil: 'networkidle' });
  await fresh.waitForTimeout(900);
  check('it starts closed', await fresh.locator('#panel').isHidden(), true);
  check('and the way to open it is on screen', await fresh.locator('#panel-toggle').isVisible(), true);
  /*
   * The toggle and the search bar are two controls, not one.
   *
   * They sit at the same height in the same surface with the same shadow, and
   * were close enough to read as a single segmented control - reported as "the
   * hamburger is part of the search". Measured while the panel is closed,
   * which is the only state in which both are on screen: opening it hides the
   * toggle, and an earlier draft of this check clicked it a second time and
   * waited a minute for a button that was no longer there.
   */
  const spacing = await fresh.evaluate(() => {
    const button = document.getElementById('panel-toggle').getBoundingClientRect();
    const search = document.getElementById('map-search').getBoundingClientRect();
    return { gap: Math.round(search.left - button.right), buttonRight: Math.round(button.right), searchLeft: Math.round(search.left), round: getComputedStyle(document.getElementById('panel-toggle')).borderRadius };
  });
  check('there is clear air between them', spacing.gap >= 12, true);
  check('and the toggle is round, not another pill', /50%|19px/.test(spacing.round), true);

  await fresh.locator('#panel-toggle').click();
  await fresh.waitForTimeout(200);
  check('opening it shows the panel', await fresh.locator('#panel').isVisible(), true);
  check('on the Layers tab', await fresh.locator('#tab-layers').isVisible(), true);
  check('not on Folders', await fresh.locator('#tab-folders').isHidden(), true);

  // The two floating buttons that duplicated the panel's own tabs are gone.
  check('no duplicate Layers button floats over the map',
    await fresh.locator('#quick-layers').count(), 0);
  check('nor a duplicate Folders one', await fresh.locator('#quick-folders').count(), 0);
  await fresh.close();
}

console.log('\nEvery basemap previews itself');
await showTab('layers');
await page.waitForTimeout(700);
const previews = await page.evaluate(() => ({
  rows: document.querySelectorAll('#basemap-list .layer-row').length,
  thumbs: document.querySelectorAll('#basemap-list .layer-thumb').length,
  drawn: document.querySelectorAll('#basemap-list .layer-thumb.is-drawn').length,
  // The preview follows the map, so the tile it asks for has to be the one
  // under the current centre rather than a fixed corner of the world.
  src: document.querySelector('#basemap-list img.layer-thumb')?.getAttribute('src') || '',
}));
check('every basemap has one', previews.thumbs, previews.rows);
check('Byways Topo is drawn rather than fetched', previews.drawn, 1);
check('and the rest ask for a tile near the middle of the map',
  /\/12\/1609\/1089|1609.*1089/.test(previews.src), true);

console.log('\nSwitch to a raster basemap and back');
await showTab('layers');
await page.locator('.layer-row', { hasText: /^USGS Topo$/ }).locator('input[type=radio]').check();
await page.waitForTimeout(900);
const afterRaster = await state();
check('waypoints survive the switch', afterRaster.folderFeatures, afterImport.folderFeatures);
check('folder layers survive', afterRaster.folderLayers, afterImport.folderLayers);
check('document layers survive', afterRaster.documentLayers, afterImport.documentLayers);

await page.locator('.layer-row', { hasText: /^Byways Topo/ }).locator('input[type=radio]').check();
await page.waitForTimeout(900);
const afterVector = await state();
check('waypoints survive switching back', afterVector.folderFeatures, afterImport.folderFeatures);
check('folder layers survive switching back', afterVector.folderLayers, afterImport.folderLayers);
check('region outlines survive', afterVector.regionLayers, afterImport.regionLayers);

console.log('\nA style applied by diff (no style.load) must not lose the layers');
await page.evaluate(() => {
  // What GL does when it diffs: our layers are not in the new style, so they go.
  for (const id of window.__map.layerIds()) {
    if (/^(folders|scratch|region)/.test(id) || /-point$|-line$/.test(id)) window.__map.removeLayer(id);
  }
  window.__map.removeSource('folders');
  window.__map.fire('styledata');
  window.__map.fire('idle');
});
await page.waitForTimeout(600);
const afterDiff = await state();
check('layers repaired after a silent diff', afterDiff.folderLayers, afterImport.folderLayers);
check('waypoints repaired after a silent diff', afterDiff.folderFeatures, afterImport.folderFeatures);

/*
 * The Details panel remembers which sections you fold away, and that memory
 * broke twice in ways unit tests could not see: a `const` read from the module
 * `state` literal above its own declaration (a temporal dead zone throw the
 * storage try/catch swallowed), and the phantom `toggle` event a `<details
 * open>` fires when the attribute is set, which overwrote the stored set with
 * whatever the first render happened to show. Both only appear across a real
 * reload, so the check is here.
 */
/*
 * The sky panels: four buttons, one box, and which box you left open is
 * remembered. Same reload trap as the collapsed sections above, so it gets the
 * same treatment — the memory is the part that breaks, not the rendering.
 */
console.log('\nThe sky panels open, and the open one is remembered');
await showTab('waypoints');
await page.waitForTimeout(300);
await page.locator('.waypoint-card').first().click();
await page.waitForTimeout(900);

check('no panel is open to begin with', await page.locator('.sky-panel').count(), 0);
await page.locator('.sky-tab', { hasText: /Milky Way/ }).click();
await page.waitForTimeout(400);
check('the Milky Way panel opens', await page.locator('.core-rows').count() > 0, true);
const mwText = await page.locator('.sky-panel').innerText();
check('it leads with how much of the band is up', /Most of the band up\s*\n?\s*\d+%/.test(mwText), true);
check('and says what the percentage measures', /above the horizon/.test(mwText), true);

// The headline is the reason to go or not go, and it is only allowed to state
// a percentage once cloud cover has actually arrived.
await page.waitForFunction(() => /sky quality/.test(document.querySelector('.core-hero')?.textContent || ''), null, { timeout: 5000 })
  .catch(() => {});
const heroText = await page.locator('.core-hero').innerText();
check('the headline scores the night', /\d+%\s*\n?\s*sky quality/.test(heroText), true);
check('and shows the cloud it used', /% cloud/.test(heroText), true);

await page.locator('.core-guide-summary').click();
await page.waitForTimeout(300);
const moments = await page.locator('.core-moment-name').allInnerTexts();
check('the guide names the classic moment first', moments[0], 'Core at its highest');
check('and offers others without padding the list', moments.length > 1 && moments.length <= 5, true);

await page.locator('.sky-tab', { hasText: /^Moon/ }).click();
await page.waitForTimeout(400);
check('switching tabs swaps the box', await page.locator('.moon-card').count(), 1);
check('only one box at a time', await page.locator('.sky-panel').count(), 1);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await showTab('waypoints');
await page.waitForTimeout(300);
await page.locator('.waypoint-card').first().click();
await page.waitForTimeout(900);
check('the open panel survives a reload', await page.locator('.moon-card').count(), 1);

// Severe weather lives inside Weather rather than under a heading of its own:
// a section that reads "no active warnings" on every pin is one people stop
// reading, which is a bad property for the part that matters most when it does
// have something to say.
console.log('\nA warned storm reports its heading and draws it');
const stormText = await page.locator('.detail-block').filter({ hasText: 'Severe Thunderstorm' }).first().innerText();
check('the warning sits inside the weather section',
  /WEATHER/i.test(await page.locator('.detail-block').filter({ hasText: 'Severe Thunderstorm' }).first().innerText()),
  true);
check('the warning is named', /Severe Thunderstorm Warning/.test(stormText), true);
// 245DEG is the direction it is coming FROM. Getting this backwards would send
// someone straight into the storm, so it is checked in words, not degrees.
check('the heading is read the right way round', /Moving northeast at 47 mph/.test(stormText), true);

await page.locator('button', { hasText: 'Show the warning areas on the map' }).click();
await page.waitForTimeout(500);
const storm = await page.evaluate(() => {
  const data = window.__map.getSource('storm-warnings')?._d;
  return (data?.features || []).map((feature) => feature.properties.kind);
});
check('the area, the track and its head all reach the map', storm, ['area', 'motion', 'head']);
// The label layer is only added when the style can carry text; the stub map
// has no glyphs, so the geometry layers are what must be here.
const stormLayers = await page.evaluate(() => window.__map.layerIds().filter((id) => id.startsWith('storm')));
for (const id of ['storm-area', 'storm-outline', 'storm-motion', 'storm-head']) {
  check(`${id} is drawn`, stormLayers.includes(id), true);
}
check('and no label layer without glyphs to draw it with',
  stormLayers.includes('storm-motion-label'), false);

/*
 * A layer whose data is fetched for the view rather than served as tiles. The
 * check that matters is that features actually reach a source: a switch that
 * adds layers and never fills them looks identical, on screen, to a region
 * with no fires in it.
 */
/*
 * The weather keys, which used to be a fetched picture of somebody else's
 * typography and are now the same swatch list the radar layer draws.
 */
console.log('\nA weather layer draws the service colour scale as swatches');
await showTab('layers');
await page.waitForTimeout(300);
// The group is a <details>, and a row inside a closed one is not clickable.
await openGroup(/Weather/);
const scale = await (async () => {
  const row = page.locator('.layer-row', { hasText: /^Temperature/ }).first();
  await row.locator('.layer-info, [aria-expanded]').first().click();
  await page.waitForTimeout(400);
  return row.evaluate((node) => {
    // The description is the row's next sibling rather than a child of it —
    // scoping this to the row itself finds nothing and reads as "the scale
    // never rendered", which is a different bug entirely.
    const desc = node.nextElementSibling;
    const list = desc?.querySelector('.legend');
    return {
      swatches: desc?.querySelectorAll('.legend-swatch').length ?? 0,
      split: !!(list?.classList.contains('is-split') || list?.classList.contains('is-wide')),
      wide: !!list?.classList.contains('is-wide'),
      labels: [...(desc?.querySelectorAll('.legend-item') || [])].slice(0, 3)
        .map((item) => item.textContent.trim()),
      // The prose above it restated what the swatches say, so a layer with a
      // scale shows the scale alone.
      prose: desc?.querySelectorAll('.layer-desc-text').length ?? 0,
      picture: desc?.querySelectorAll('.legend-image').length ?? 0,
    };
  });
})();
check('the scale is drawn as swatches, not fetched as a picture', scale.picture, 0);
check('every step in the colormap has a swatch', scale.swatches, 12);
check('the nodata sentinel is not one of them', scale.labels.includes(''), false);
check('a long ramp splits into more than one column', scale.split, true);
check('and the prose that restated it is gone', scale.prose, 0);

/*
 * Recreation sites, which used to be two rasters of server-drawn names with
 * nothing on them clickable. The check is that a point carries the icon of the
 * sublayer that produced it — that is the whole mechanism.
 */
/*
 * The light pollution layer, switched on the way a reader switches it on.
 * Reported as absent, and "the entry is in the catalogue" is not the same
 * claim as "the switch puts a layer on the map".
 */
console.log('\nLight pollution is offered and adds a layer');
await showTab('layers');
await page.waitForTimeout(300);
const lpOffered = await page.evaluate(() => !!document.querySelector('[data-layer="light-pollution"]'));
check('the layer is in the panel', lpOffered, true);
await openGroup(/Conditions/);
await page.locator('.layer-row', { hasText: /Light pollution/ }).locator('input[type=checkbox]').check();
await page.waitForTimeout(500);
const lp = await page.evaluate(() => {
  const map = window.__map;
  const layer = map.getLayer('overlay-light-pollution');
  const source = map.getSource('overlay-light-pollution');
  return { hasLayer: !!layer, type: layer?.type, hasSource: !!source };
});
check('switching it on adds a layer', lp.hasLayer, true);
check('and it is a raster', lp.type, 'raster');
check('with a source behind it', lp.hasSource, true);

console.log('\nRecreation sites draw as icons, one per kind of place');
await showTab('layers');
await page.waitForTimeout(300);
await openGroup(/Land & access/);
await page.locator('.layer-row', { hasText: /^Recreation/ }).locator('input[type=checkbox]').check();
await page.waitForTimeout(900);
const rec = await page.evaluate(() => {
  const map = window.__map;
  const features = map.getSource('overlay-recreation')?._d?.features || [];
  const layer = map.getLayer('overlay-recreation');
  return {
    type: layer?.type,
    count: features.length,
    icons: [...new Set(features.map((feature) => feature.properties.icon))].sort(),
    labelled: features.every((feature) => !!feature.properties.kindLabel),
    named: features.every((feature) => !!feature.properties.name),
    iconImages: map.imageIds().filter((id) => id.startsWith('pin-')).length,
  };
});
check('it is a symbol layer, not a fill', rec.type, 'symbol');
check('every sublayer contributed a site', rec.count, 8);
check('and each carries the icon of its own kind',
  rec.icons, ['cabin', 'campground', 'historic', 'information', 'picnic', 'ranger', 'trailhead']);
check('the symbols are registered as NPS images, not the pin glyphs',
  await page.evaluate(() => window.__map.imageIds().filter((id) => id.startsWith('nps-')).length > 0), true);

/*
 * The key shows the symbols themselves. A list of coloured squares cannot
 * answer "which of these is the tent", which is what got reported.
 */
const symbolKey = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.layer-row')]
    .find((node) => /^Recreation/.test(node.textContent.trim()));
  const desc = row?.nextElementSibling;
  return {
    rows: desc?.querySelectorAll('.legend.is-symbols .legend-item').length ?? 0,
    drawn: desc?.querySelectorAll('.legend-symbol svg').length ?? 0,
  };
});
// Seven sublayers, six symbols: cabins and shelters share one.
check('the key lists one row per symbol', symbolKey.rows, 7);
check('and each row draws the symbol rather than a colour', symbolKey.drawn, 7);
check('with a kind to show in the popup', rec.labelled, true);
check('and a name', rec.named, true);
check('the pin images the icons name are registered', rec.iconImages > 0, true);

// The inspector that answers "the switch is on and I see nothing" without a
// round trip. It is only useful if it reports the layer it is asked about.
const report = await page.evaluate(() => window.abmapOverlays());
check('the inspector finds the switched-on layer',
  report.switchedOn.some((row) => row.id === 'recreation'), true);
check('and says what the last query returned per kind',
  report.switchedOn.find((row) => row.id === 'recreation').lastFetch.total, 8);

console.log('\nA queried overlay loads features for the view');
await showTab('layers');
await page.waitForTimeout(300);
await openGroup(/Conditions/);
await page.locator('.layer-row', { hasText: /^Wildfire/ }).locator('input[type=checkbox]').check();
await page.waitForTimeout(900);

const fire = await page.evaluate(() => {
  const map = window.__map;
  const ids = map.layerIds();
  return {
    fill: ids.includes('overlay-wildfire'),
    line: ids.includes('overlay-wildfire--2'),
    features: map.getSource('overlay-wildfire')?._d?.features?.length ?? null,
  };
});
check('the fill layer is added', fire.fill, true);
check('and the outline with it', fire.line, true);
check('and the perimeters reach the source', fire.features, 1);

/*
 * Each of the three shares one source, so each has to say what it can draw.
 *
 * The dot layer went in without a filter, on the reasoning that a circle never
 * renders over lines and polygons. It does - the circle bucket walks every
 * vertex - so Maryland's roads came back as a dot on every bend, reported from
 * the map twice before the cause was found. Nothing in the config says which
 * geometry a given service will return, so the filters are the only guard.
 */
const shapes = await page.evaluate(() => {
  const map = window.__map;
  const at = (id) => JSON.stringify(map.getLayer(id)?.filter ?? null);
  return {
    fill: at('overlay-wildfire'),
    line: at('overlay-wildfire--2'),
    dot: at('overlay-wildfire--3'),
    // Wildfire is areas, so it gets no casing. Asking anyway is the check that
    // a casing is not quietly drawn round every polygon on the map.
    casing: map.getLayer('overlay-wildfire--1') ? 'present' : 'absent',
  };
});
// Multi-part variants included: geometry-type answers MultiPolygon for a
// feature with more than one ring group, and an equality test dropped exactly
// the features most likely to be a real park.
check('the fill draws polygons, single or multi', shapes.fill,
  '["in",["geometry-type"],["literal",["Polygon","MultiPolygon"]]]');
check('the outline draws anything but a point', shapes.line,
  '["!",["in",["geometry-type"],["literal",["Point","MultiPoint"]]]]');
check('and the dot draws points only', shapes.dot,
  '["in",["geometry-type"],["literal",["Point","MultiPoint"]]]');
check('an area layer gets no road casing', shapes.casing, 'absent');

// The slider is one control over two kinds of layer now. `raster-opacity` on a
// fill layer is not a dimmer, it is a spec error, so what it sets has to follow
// the layer type.
const slider = page.locator('.layer-row', { hasText: /^Wildfire/ })
  .locator('xpath=following-sibling::*[1]').locator('input[type=range]');
/*
 * Driven through the element rather than through Playwright's fill().
 *
 * `fill()` on an input[type=range] does not reliably move it, and the call
 * here was wrapped in a catch that swallowed the failure - so for as long as
 * this check has existed it has been reading the opacity the layer was created
 * with. It passed because that happened to be 0.27 and the assertion was
 * "under 0.3". Hatching raised the starting value and the check finally failed,
 * which is the first time it has said anything at all.
 */
await page.evaluate(() => {
  // By its aria-label, which the panel sets to "<layer> opacity". Walking the
  // DOM from the row text was my first attempt and it matched nothing: the
  // row's textContent is not anchored at the layer name.
  const range = document.querySelector('input[type=range][aria-label="Wildfire opacity"]');
  if (!range) throw new Error('no opacity slider for Wildfire');
  range.value = '30';
  range.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(300);
const paints = await page.evaluate(() => {
  const map = window.__map;
  return {
    fill: Object.keys(map.getLayer('overlay-wildfire')?.paint || {}),
    line: Object.keys(map.getLayer('overlay-wildfire--2')?.paint || {}),
    fillValue: map.getLayer('overlay-wildfire')?.paint?.['fill-opacity'],
  };
});
check('the fill is dimmed as a fill', paints.fill.includes('fill-opacity'), true);
check('and never as a raster', paints.fill.includes('raster-opacity'), false);
check('the outline is dimmed as a line', paints.line.includes('line-opacity'), true);
// The exact value the slider asks for - 30% through opacityPaint's fill
// branch - so a layer left at its creation opacity cannot satisfy this.
check('and the slider actually moved it', Number(paints.fillValue?.toFixed(3)), 0.135);

// A raster basemap bakes its overlays into the style document, and a queried
// overlay cannot be baked into anything. It has to be added on that path too,
// or switching to USGS Topo quietly drops it.
await page.locator('.layer-row', { hasText: /^USGS Topo$/ }).locator('input[type=radio]').check();
/*
 * Waited for rather than slept through.
 *
 * The layer is rebuilt synchronously when the style loads, but its features
 * come back from a fetch that starts afterwards - so a fixed pause is a race,
 * and this one lost about one run in five with "expected 1, got 0", which reads
 * like the overlay being dropped by the basemap switch. Waiting on the
 * condition does not weaken the check: if the features never arrive this times
 * out and the assertion below still fails, on the same evidence.
 */
await page.waitForFunction(
  () => (window.__map?.getSource('overlay-wildfire')?._d?.features?.length ?? 0) > 0,
  null,
  { timeout: 8000 },
).catch(() => {});
const fireOnRaster = await page.evaluate(() => ({
  fill: window.__map.layerIds().includes('overlay-wildfire'),
  features: window.__map.getSource('overlay-wildfire')?._d?.features?.length ?? null,
}));
check('it survives a switch to a raster basemap', fireOnRaster.fill, true);
check('with its features', fireOnRaster.features, 1);
await page.locator('.layer-row', { hasText: /^Byways Topo/ }).locator('input[type=radio]').check();
await page.waitForTimeout(1100);

await page.locator('.layer-row', { hasText: /^Wildfire/ }).locator('input[type=checkbox]').uncheck();
await page.waitForTimeout(500);
const afterOff = await page.evaluate(() => window.__map.layerIds().filter((id) => id.startsWith('overlay-wildfire')));
check('switching it off takes both layers with it', afterOff, []);

console.log('\nThe Location section leads with decimal and hides the rest');
await showTab('waypoints');
await page.waitForTimeout(300);
await page.locator('.waypoint-card').first().click();
await page.waitForTimeout(900);

// Location is a foldable block now, like the rest of the panel — so this
// looks inside the block rather than for the flat section it used to be.
const locationSection = () => page.locator('.detail-block').filter({ hasText: 'Location' }).first();
check('the Location block is open by default, not tidied away',
  await locationSection().evaluate((node) => node.open), true);
check('decimal degrees are on screen without opening anything',
  await locationSection().locator('.detail-line-label', { hasText: /^Decimal$/ }).count(), 1);
check('the other formats start hidden',
  await page.locator('.coord-more').first().evaluate((node) => node.open), false);
await page.locator('.coord-more-summary').first().click();
await page.waitForTimeout(200);
check('opening it reveals UTM',
  await page.locator('.coord-more[open] .detail-line-label', { hasText: /^UTM$/ }).count(), 1);

// Who manages the land is part of where the place is: it reads inside Location
// rather than under a heading three sections further down.
const sectionOrder = await page.evaluate(() => [...document.querySelectorAll('#details-body h2.panel-title, #details-body .detail-block-summary')]
  .map((node) => node.textContent.trim()));
check('there is no land manager section of its own',
  sectionOrder.some((title) => /Land manager/i.test(title)), false);
check('and Location is the first section on the panel',
  /Location/i.test(sectionOrder[sectionOrder.findIndex((t) => /Location/i.test(t))] || ''), true);
check('every section carries a mark',
  await page.locator('#details-body .detail-block-summary .detail-block-mark').count() > 0, true);

/*
 * A field note is the most perishable thing on a pin — "gate locked", "creek
 * up" — and it was two taps deep. It belongs on the card, trimmed.
 */
console.log('\nA field note reaches the cards');
// Sections start open, so no click first — clicking would close it.
await page.locator('textarea[aria-label="New field note"]').fill('Gate locked at the second cattle guard, creek was up over the ford');
await page.locator('button', { hasText: /^Add note$/ }).click();
await page.waitForTimeout(400);

await showTab('waypoints');
await page.waitForTimeout(500);
const cardNote = await page.locator('.waypoint-note').first().innerText().catch(() => '');
check('the newest note is on the waypoint card', /Gate locked at the second/.test(cardNote), true);

/*
 * Units are a property of the reader, not of the view. They used to live only
 * in the URL, which meant they reset on every fresh visit and travelled with
 * every shared link — wrong in both directions.
 *
 * Placed after everything that depends on an imported file: this reloads, and
 * a loaded document lives in memory rather than in storage.
 */
/*
 * The header's download button. It used to export only open map files, so
 * somebody with a hundred saved waypoints and no file open pressed it and was
 * told there was nothing to export.
 */
console.log('\nThe export takes folders as well as files');
// It lives in the offline menu now rather than in the header — one control for
// every way of taking the map with you, instead of three scattered ones.
await page.click('#offline-trigger');
await page.waitForTimeout(200);
// The sentence above the regions used to say downloading "happens in the app"
// - and went on saying it inside the app, above the button that does it.
check('the region copy says what this device does, not what some other one would',
  await page.evaluate(() => /happens in the app|a browser cannot/.test(document.querySelector('#offline-panel').textContent)), false);
await page.waitForTimeout(300);
check('the offline menu holds the export and the picture', await page.evaluate(() => Boolean(
  document.getElementById('download-button') && document.getElementById('snapshot-button'))), true);
/*
 * The layout that was asked for: the picture on a line of its own, the two
 * exports sharing the next, and the region download full width with the same
 * mark as the exports. Measured, because a class that wraps one button per
 * line and a class that pairs them are indistinguishable in the DOM.
 */
const offlineRows = await page.evaluate(() => {
  const at = (id) => document.getElementById(id).getBoundingClientRect();
  const picture = at('snapshot-button');
  const gpx = at('download-button');
  const geo = [...document.querySelectorAll('#offline-panel button')].find((b) => /GeoJSON/.test(b.textContent)).getBoundingClientRect();
  const save = at('region-save-button');
  const draw = at('region-draw-button');
  return {
    pictureAlone: picture.bottom <= gpx.top && Math.round(picture.width) > Math.round(gpx.width) * 1.5,
    exportsPaired: Math.abs(gpx.top - geo.top) < 2 && Math.abs(gpx.width - geo.width) < 2,
    saveFull: Math.round(save.width) === Math.round(picture.width) && save.bottom <= draw.top,
    saveLabel: document.getElementById('region-save-button').textContent.trim(),
    saveMark: document.getElementById('region-save-button').querySelector('svg')?.outerHTML
      === document.getElementById('download-button').querySelector('svg')?.outerHTML,
    drawLabel: document.getElementById('region-draw-button').textContent.trim(),
    // Pairing two labelled buttons in a 330px menu is exactly how a label
    // becomes "Export G...", which the DOM cannot see and a person can.
    clipped: [...document.querySelectorAll('#offline-panel .offline-actions .button span')]
      .filter((span) => span.scrollWidth > span.clientWidth + 1)
      .map((span) => `${span.textContent} (${span.scrollWidth - span.clientWidth}px over, button ${Math.round(span.parentElement.getBoundingClientRect().width)}px)`),
  };
});
check('and no label is cut short to fit', offlineRows.clipped, []);
check('the picture has a line of its own', offlineRows.pictureAlone, true);
check('and the two exports share the next', offlineRows.exportsPaired, true);
check('the region download is full width like the picture', offlineRows.saveFull, true);
check('named for what it does', offlineRows.saveLabel, 'Offline download');
check('with the same mark as the exports', offlineRows.saveMark, true);
check('and a region can be drawn', offlineRows.drawLabel, 'Draw a region');
await shot(page.locator('#offline-panel'), 'offline-panel');
/*
 * Both formats, because they are for different readers.
 *
 * The default is GPX - the thing a handheld, Gaia or AllTrails will actually
 * import - and GeoJSON stays for a map that wants the full properties. This
 * check reads the bytes of each rather than trusting the button label: the
 * export quietly changing format is exactly the kind of thing that is only
 * noticed by the person whose device will not open the file.
 */
const grab = async (buttonId) => page.evaluate(async (id) => {
  let captured = null;
  const original = URL.createObjectURL;
  URL.createObjectURL = (blob) => { captured = blob; return original.call(URL, blob); };
  document.getElementById(id).click();
  // saveBlob is async now: it asks about sharing before it falls back to an
  // anchor, so the blob does not exist yet on the line after the click.
  await new Promise((resolve) => setTimeout(resolve, 150));
  URL.createObjectURL = original;
  return captured ? captured.text() : null;
}, buttonId);

const gpx = await grab('download-button');
check('the default export is GPX', /<gpx[\s>]/.test(gpx || ''), true);

const geo = await page.evaluate(async () => {
  const button = [...document.querySelectorAll('button')].find((b) => /GeoJSON/i.test(b.textContent));
  if (!button) return null;
  let captured = null;
  const original = URL.createObjectURL;
  URL.createObjectURL = (blob) => { captured = blob; return original.call(URL, blob); };
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  URL.createObjectURL = original;
  return captured ? captured.text() : null;
});
const parsed = geo ? JSON.parse(geo) : { features: [] };
check('GeoJSON is still there for a map to read',
  parsed.features.some((f) => /Smoke folder/.test(f.properties?.source || '')), true);

/*
 * The two files describe the same map.
 *
 * Checked against each other rather than against a name written in here: a
 * literal would only prove the fixture is what this file thinks it is, and
 * would keep passing if GPX quietly stopped carrying waypoints. Every point
 * the GeoJSON names has to be named in the GPX too.
 */
const pointNames = parsed.features
  .filter((f) => /Point/.test(f.geometry?.type || '') && f.properties?.name)
  .map((f) => f.properties.name);
check('there is a point to compare', pointNames.length > 0, true);
check('and every one of them is in the GPX',
  pointNames.every((name) => (gpx || '').includes(name)), true);
check('as an actual waypoint element', /<wpt[\s>]/.test(gpx || ''), true);

console.log('\nUnits are chosen, applied and remembered');
await page.click('#settings-trigger');
await page.waitForTimeout(200);
check('the menu offers both conversions and the three themes',
  await page.locator('.settings-choice').count(), 7);
/*
 * Chosen by accessible name, because the face of the button is now "\u00b0C"
 * and "km / m" - short enough for a phone, and spelled out where a screen
 * reader and this test look. A choice that lost its name would fail here.
 */
const choice = (name) => page.locator(`.settings-choice[aria-label="${name}"]`);
await choice('Celsius').click();
await page.waitForTimeout(400);
check('Celsius sticks in the menu',
  await page.locator('.settings-choice.is-on[aria-label="Celsius"]').count(), 1);
check('and the face of the button is the short form',
  (await choice('Celsius').textContent()).trim(), '\u00b0C');
await choice('Kilometers and meters').click();
await page.waitForTimeout(400);
await page.keyboard.press('Escape');

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.click('#settings-trigger');
await page.waitForTimeout(300);
check('and both survive a reload',
  await page.locator('.settings-choice.is-on[aria-label="Celsius"], .settings-choice.is-on[aria-label="Kilometers and meters"]').count(), 2);
// Back to what the rest of the run expects.
await choice('Fahrenheit').click();
await choice('Miles and feet').click();
await page.waitForTimeout(300);

/*
 * Theme and account, behind the same button as the units.
 *
 * Both used to be controls of their own in a header that also carries a
 * wordmark and five map tools, and neither is a place to go - they are things
 * about this device. What is checked here is the part that could silently rot:
 * the theme row has to actually move the document, and System has to be
 * reachable again afterwards. The old header toggle could not do that at all -
 * once pressed, the only way back to following the phone was clearing site
 * data - so "System restores the default" is the check that would have failed
 * before this moved.
 */
console.log('\nTheme and account live under the settings button');
check('the header keeps no theme toggle of its own',
  await page.locator('#theme-toggle').count(), 0);
check('nor an account button beside it',
  await page.locator('#account-trigger').count(), 0);

// Marks, not words: each theme button is an icon carrying its name.
check('the theme row is drawn as three marks',
  await page.locator('.settings-choice[aria-label="System"] svg, .settings-choice[aria-label="Light"] svg, .settings-choice[aria-label="Dark"] svg').count(), 3);
await choice('Dark').click();
await page.waitForTimeout(200);
check('choosing Dark darkens the document',
  await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
await choice('Light').click();
await page.waitForTimeout(200);
check('and Light lightens it',
  await page.evaluate(() => document.documentElement.dataset.theme), 'light');
await choice('System').click();
await page.waitForTimeout(200);
check('while System hands the decision back to the device', await page.evaluate(() => ({
  attribute: document.documentElement.dataset.theme ?? null,
  stored: window.localStorage.getItem('ab-maps-theme'),
})), { attribute: null, stored: null });

check('the account sits in the same menu',
  await page.locator('#settings-panel #account-panel').count(), 1);

/*
 * The plan, which is one plan and includes everything.
 *
 * Checked for the word rather than the element, because the failure worth
 * catching is not "the block vanished" — it is a build that quietly starts
 * gating something. "Free" is the honest state of this project, and the day
 * it stops being true this check is what has to be changed on purpose. The
 * sentence that used to sit under it was asked off the menu; the FAQ is where
 * it is explained.
 */
const plan = await page.evaluate(() => {
  const name = document.querySelector('#settings-panel .plan-name');
  return {
    name: name?.textContent.trim(),
    block: name?.parentElement.textContent.replace(/\s+/g, ' ').trim(),
  };
});
check('the plan is named where the account is', plan.name, 'Free');
check('and nothing is written under it', plan.block, 'PlanFree');
await shot(page.locator('#settings-panel'), 'settings-menu');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

/*
 * Three destinations as three marks, each still carrying its name.
 *
 * A link whose whole content is a picture has no accessible name unless one is
 * given to it, and a header of unlabelled glyphs is unusable with a screen
 * reader. So the names are checked, not just the count.
 */
check('the nav is three marks', await page.locator('.nav-icons a[href]').count(), 3);
check('each one named for anything that cannot see a picture',
  await page.evaluate(() => [...document.querySelectorAll('.nav-icons a')]
    .map((node) => node.getAttribute('aria-label'))), ['Home', 'Map', 'Help']);
check('and drawn rather than written',
  await page.evaluate(() => [...document.querySelectorAll('.nav-icons a')]
    .every((node) => node.querySelector('svg') && !node.textContent.trim())), true);
await shot(page.locator('.site-header'), 'site-header');

/*
 * A picture of the sign-in form where it now lives.
 *
 * Off unless SMOKE_SHOTS asks for it, and on a page of its own so nothing it
 * does reaches the run above. Accounts are configured by two globals that
 * token.js sets, and the smoke build has neither - which is why every check in
 * this file has only ever seen the "accounts are not set up" line, and why the
 * form that a real deployment shows in this menu goes unlooked at. The globals
 * are supplied here and every call to the service is failed, because the point
 * is the layout of the form and not what happens when you fill it in.
 */
if (process.env.SMOKE_SHOTS && !external) {
  const shots = await context.newPage();
  await shots.route('**/*.supabase.co/**', (route) => route.abort());
  // The same stub the run above uses; without it the page never gets a map
  // library, viewer init stops before it renders anything, and the menu this
  // is here to photograph comes out empty.
  await shots.route('**/mapbox-gl.js*', (route) => route.fulfill({
    status: 200, contentType: 'application/javascript', body: GL,
  }));
  await shots.addInitScript(() => {
    window.ABMAP_SUPABASE_URL = 'https://smoke.supabase.co';
    window.ABMAP_SUPABASE_KEY = 'smoke-anon-key';
  });
  await shots.goto(MAP_URL, { waitUntil: 'domcontentloaded' });
  await shots.waitForTimeout(2500);
  await shots.click('#settings-trigger');
  await shots.waitForTimeout(400);
  await shot(shots.locator('#settings-panel'), 'settings-signed-out');
  await shots.close();
}

/*
 * The account, signed in, without a server.
 *
 * supabase-js is fetched from a CDN the moment a project is configured, so a
 * fake of that one module - a session already there, a table with nothing in
 * it - is enough to draw the signed-in card. What is checked is the layout
 * that was asked for: the name on a line of its own, the address under it, an
 * edit that opens a form already filled in, the sync line, and two buttons
 * each carrying a mark. It was one row with the address cut off at "sherm..."
 * and nothing here could have said so.
 */
if (!external) {
  console.log('\nThe signed-in account reads top to bottom');
  const signed = await context.newPage();
  await signed.route('**/*.supabase.co/**', (route) => route.abort());
  await signed.route('**/mapbox-gl.js*', (route) => route.fulfill({
    status: 200, contentType: 'application/javascript', body: GL,
  }));
  // A predicate rather than a glob: the library's URL ends in "@2.45.4/+esm",
  // and a glob star stops at the slash, so the pattern quietly matched nothing
  // and the import went to the real network. A module import is also a CORS
  // fetch, hence the header - without it the browser refuses the fake.
  await signed.route((url) => url.href.includes('@supabase/supabase-js'), (route) => route.fulfill({
    status: 200, contentType: 'application/javascript',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: `export function createClient() {
      const user = { id: 'u1', email: 'sherman@example.com', user_metadata: { display_name: 'Sherman Cahal' } };
      const table = {
        select() { return { async eq() { return { data: [], error: null }; } }; },
        async upsert() { return { error: null }; },
      };
      return {
        from() { return table; },
        auth: {
          async getSession() { return { data: { session: { user } } }; },
          onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
          async updateUser(attributes) {
            Object.assign(user.user_metadata, attributes.data || {});
            return { data: { user }, error: null };
          },
          async signOut() {},
        },
      };
    }`,
  }));
  await signed.addInitScript(() => {
    window.ABMAP_SUPABASE_URL = 'https://smoke.supabase.co';
    window.ABMAP_SUPABASE_KEY = 'smoke-anon-key';
  });
  await signed.goto(MAP_URL, { waitUntil: 'domcontentloaded' });
  await signed.waitForTimeout(2500);
  await signed.click('#settings-trigger');
  await signed.waitForFunction(() => document.querySelector('#account-panel .account-name'), null, { timeout: 5000 })
    .catch(() => {});

  const card = await signed.evaluate(() => {
    const panel = document.querySelector('#account-panel');
    return {
      rows: [...panel.children].map((node) => node.className.split(' ')[0]),
      name: panel.querySelector('.account-name')?.textContent.trim(),
      email: panel.querySelector('.account-email')?.textContent.trim(),
      sync: panel.querySelector('.account-meta')?.textContent.trim(),
      buttons: [...panel.querySelectorAll('.account-actions button')]
        .map((button) => [button.textContent.trim(), Boolean(button.querySelector('svg'))]),
      hints: [...panel.querySelectorAll('.hint')].map((node) => node.textContent.trim()),
    };
  });
  // First, so that when the card is wrong the complaint under it is in the log.
  check('a clean sign-in has nothing to complain about', card.hints, []);
  check('who, then the edit, then the sync line, then the buttons',
    card.rows, ['account-who', 'button', 'account-meta', 'account-actions']);
  check('the name is the one typed into the profile', card.name, 'Sherman Cahal');
  check('with the address on its own line under it', card.email, 'sherman@example.com');
  check('and the sync line counts folders', /folders? synced/.test(card.sync || ''), true);
  check('two buttons, each with a mark', card.buttons, [['Sync now', true], ['Sign out', true]]);
  await shot(signed.locator('#settings-panel'), 'settings-signed-in');

  await signed.locator('#account-panel .account-edit').click();
  await signed.waitForTimeout(200);
  check('editing opens a form already filled in', await signed.evaluate(() => ({
    name: document.querySelector('#account-panel input[aria-label="Name"]')?.value,
    email: document.querySelector('#account-panel input[aria-label="Email"]')?.value,
  })), { name: 'Sherman Cahal', email: 'sherman@example.com' });
  await shot(signed.locator('#settings-panel'), 'settings-edit-profile');
  await signed.fill('#account-panel input[aria-label="Name"]', 'S. Cahal');
  await signed.locator('#account-panel .account-form button[type="submit"]').click();
  await signed.waitForTimeout(400);
  check('and saving puts the new name on the card',
    await signed.evaluate(() => document.querySelector('#account-panel .account-name')?.textContent.trim()), 'S. Cahal');
  check('saying so',
    await signed.evaluate(() => document.querySelector('#account-panel .hint')?.textContent.trim()), 'Saved.');
  await signed.close();
}

/*
 * The Milky Way band on the map, and the control that moves it.
 *
 * The maths for this has been in sky.js and under test for a while; what was
 * missing was ever drawing it. So the check is deliberately about the map data
 * rather than about the numbers: an arc feature with more than two points, and
 * a scrubber that changes it.
 */
/*
 * Aurora as a readout rather than a layer. From these latitudes it decides a
 * night about twice a decade, so what is worth having is the number, not a
 * switch that draws nothing almost every night.
 */
/*
 * The picture of the map, which is the offline that needs no tiles and no
 * token. The check is that the button is wired and the map was built able to
 * be read back — WebGL discards its drawing buffer by default, and a snapshot
 * feature built without preserveDrawingBuffer saves a blank rectangle while
 * looking like it worked.
 */
console.log('\nThe visible map can be saved as a picture');
const snapshot = await page.evaluate(() => ({
  button: !!document.getElementById('snapshot-button'),
  preserved: window.__mapOptions?.preserveDrawingBuffer === true,
}));
check('the button is there', snapshot.button, true);
check('and the map keeps its drawing buffer so it can be read back',
  snapshot.preserved, true);

console.log('\nSpace weather reaches the Photography panel');
await showTab('waypoints');
await page.waitForTimeout(400);
await page.locator('.waypoint-card').first().click();
await page.waitForTimeout(800);
await page.locator('.detail-block').filter({ hasText: 'Photography' }).first()
  .evaluate((node) => { node.open = true; });
// Every tab carries a glyph now, because five text labels wrap in a 320px
// panel and a wrapped tab strip reads as two rows of unrelated buttons.
const tabs = await page.evaluate(() => ({
  count: document.querySelectorAll('.sky-tab').length,
  withIcons: document.querySelectorAll('.sky-tab .sky-tab-icon svg').length,
  labels: [...document.querySelectorAll('.sky-tab-text')].map((node) => node.textContent),
}));
/*
 * Counted against itself rather than against a number.
 *
 * This said "five", and adding a sixth tab broke it — which is a change to be
 * noticed, not a failure. What actually matters is that every tab has a mark:
 * a strip of six is a wall of small capitals otherwise, which is why the icons
 * were added in the first place.
 */
check('every sky tab has an icon', tabs.withIcons, tabs.count);
check('and a label to go with it', tabs.labels.length, tabs.count);
check('including Aurora', tabs.labels.includes('Aurora'), true);
check('and Eclipse', tabs.labels.includes('Eclipse'), true);

// Three across then two, rather than the three rows a two-column grid gave.
const tabRows = await page.evaluate(() => {
  const tops = [...document.querySelectorAll('.sky-tab')]
    .map((node) => Math.round(node.getBoundingClientRect().top));
  return new Set(tops).size;
});
check('laid out in two rows, not three', tabRows, 2);

await page.locator('.sky-tab', { hasText: /Aurora/ }).first().click();
await page.waitForTimeout(900);
const aurora = await page.evaluate(() => ({
  text: [...document.querySelectorAll('.core-row')].map((node) => node.textContent.trim()).join(' | '),
  note: [...document.querySelectorAll('.legend-note')].map((node) => node.textContent).join(' '),
}));
check('the chance at this point is reported', /12%/.test(aurora.text), true);
check('alongside the planetary K index', /5/.test(aurora.text), true);

/*
 * Fog, worked out here rather than read off a service.
 *
 * The National Weather Service publishes no fog probability, so the whole card
 * is this app's arithmetic on the gridpoint's temperature, dewpoint, wind and
 * sky cover. The fixture gives it a four-hour window of near-saturated air
 * under a clear sky with a light wind and leaves every other hour dry, so a
 * card that reported the first row rather than the peak, or that ignored an
 * ingredient, cannot pass: it has to name radiation fog, land inside that
 * window, and say the number came from a model rather than a forecaster.
 */
await page.locator('.sky-tab', { hasText: /^Fog/ }).first().click();
await page.waitForTimeout(1200);
const fog = await page.evaluate(() => ({
  band: document.querySelector('.fog-band')?.textContent.trim(),
  headline: document.querySelector('.fog-headline')?.textContent.trim(),
  when: document.querySelector('.fog-when')?.textContent.trim(),
  rows: [...document.querySelectorAll('.core-row')].map((node) => node.textContent.trim()).join(' | '),
  blocks: document.querySelectorAll('.fog-block').length,
  likely: document.querySelectorAll('.fog-block.is-likely').length,
  hint: [...document.querySelectorAll('.hint')].map((node) => node.textContent).join(' '),
}));
check('the fog card reaches a verdict', /Fog (likely|possible)/.test(fog.band || ''), true);
check('and names the kind rather than just a number', fog.headline, 'Ground fog');
check('with the hour it peaks at', /\d+% at \d/.test(fog.when || ''), true);
check('the reasoning is on the card, not in a footnote',
  /dewpoint depression/i.test(fog.rows), true);
/*
 * The line that keeps this honest. Every number here is modelled, and a card
 * that presented it as a published forecast would be the one real problem with
 * shipping this feature.
 */
check('and it says the number is modelled, not published',
  /modelled here from the forecast ingredients/.test(fog.rows), true);
check('the strip covers the hours ahead', fog.blocks > 12, true);
check('and marks only the foggy ones', fog.likely > 0 && fog.likely < fog.blocks, true);
check('the card says which service it did the arithmetic on',
  /gridded forecast/.test(fog.hint), true);
await shot(page.locator('.sky-panel'), 'fog-panel');
check('and Kp is translated into what it means here', /storm/.test(aurora.note), true);

console.log('\nThe Milky Way band is drawn, and the night can be scrubbed');
await showTab('waypoints');
await page.waitForTimeout(400);
await page.locator('.waypoint-card').first().click();
await page.waitForTimeout(800);
// Opened, not toggled: Photography starts open, so clicking its summary here
// closes it — and every check below then reports the feature as missing rather
// than the section as shut. The layer groups had the same trap.
await page.locator('.detail-block').filter({ hasText: 'Photography' }).first()
  .evaluate((node) => { node.open = true; });
await page.waitForTimeout(300);
// The aggregate drawing lives behind its own sub-tab inside Photography, and
// the tab IS the switch — opening it draws, which is the whole reason it is
// called Draw rather than carrying a button that says so.
await page.locator('.sky-tab', { hasText: /^Draw$/ }).first().click();
await page.waitForTimeout(700);
check('opening the Draw tab draws, with no second press',
  await page.evaluate(() => (window.__map.getSource('light-directions')?._d?.features || []).length > 0),
  true);
check('and it carries no button that would be the same press again',
  await page.locator('[data-toggle="sky-lines"]').count(), 0);

const arcOf = () => page.evaluate(() => {
  const features = window.__map.getSource('light-directions')?._d?.features || [];
  const arc = features.find((feature) => feature.properties.kind === 'arc');
  return {
    present: !!arc,
    points: arc?.geometry.coordinates.length ?? 0,
    first: arc?.geometry.coordinates[0]?.map((n) => Number(n.toFixed(4))).join(',') ?? '',
    bearings: features.filter((feature) => feature.properties.kind !== 'arc').length,
  };
});

const band = await arcOf();
check('the band is drawn as its own arc feature', band.present, true);
check('sampled into a curve rather than a straight line', band.points > 10, true);
check('and the rise and set bearings are still there', band.bearings > 0, true);

check('the scrubber spans one night', await page.locator('.scrub-range').count(), 1);
const scrubbed = await (async () => {
  const range = page.locator('.scrub-range').first();
  const { min, max } = await range.evaluate((node) => ({ min: node.min, max: node.max }));
  await range.evaluate((node, value) => {
    node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(Number(min) + (Number(max) - Number(min)) * 0.15));
  await new Promise((resolve) => setTimeout(resolve, 400));
  return arcOf();
})();
check('and moving it moves the band', scrubbed.first !== band.first, true);
check('the Now button is there to get back', await page.locator('.scrub-now').count(), 1);

/*
 * The night's whole path, not just this instant. The band tells you what the
 * frame holds now; the track tells you where it will be by the time you have
 * walked in, which is the thing the panel's numbers cannot show.
 */
const track = await page.evaluate(() => {
  const features = window.__map.getSource('light-directions')?._d?.features || [];
  const line = features.find((feature) => feature.properties.kind === 'track');
  const hours = features.filter((feature) => feature.properties.kind === 'hour');
  return {
    present: !!line,
    points: line?.geometry.coordinates.length ?? 0,
    hours: hours.length,
    labelled: hours.every((hour) => !!hour.properties.label),
  };
});
check('the core track is drawn across the night', track.present, true);
/*
 * And inside the frame.
 *
 * The reach was a fixed 40km chosen for trip-planning zooms, so at any zoom
 * closer than that the ring was drawn twenty-five kilometres off the edge of
 * the screen while the spokes, which run the full reach, crossed it — the
 * drawing looked like bearings and nothing else. The ring is only a ring if
 * you can see it.
 */
const ringFits = await page.evaluate(() => {
  const features = window.__map.getSource('light-directions')?._d?.features || [];
  const line = features.find((feature) => feature.properties.kind === 'track');
  const bounds = window.__map.getBounds();
  const inside = (point) => point[0] >= bounds.getWest() && point[0] <= bounds.getEast()
    && point[1] >= bounds.getSouth() && point[1] <= bounds.getNorth();
  const centre = window.__map.getCenter();
  const away = (point) => Math.hypot(point[0] - centre.lng, point[1] - centre.lat);
  const tall = bounds.getNorth() - bounds.getSouth();
  return {
    ring: (line?.geometry.coordinates || []).every(inside),
    // Not collapsed onto the pin either: a ring drawn at a hundred metres in a
    // view of a whole state is as unreadable as one drawn off the edge.
    reach: Math.min(...(line?.geometry.coordinates || [[0, 0]]).map(away)) / tall,
  };
});
check('the whole ring is inside the view, at this zoom', ringFits.ring, true);
check('and far enough out to read a bearing off', ringFits.reach > 0.05, true);
check('sampled finely enough to read as a curve', track.points > 8, true);
check('with the hours marked along it', track.hours > 0, true);
check('and every hour mark carries its time', track.labelled, true);

/*
 * The spoke from the pin to the band, which is the "where do I stand and which
 * way do I face" half. Without it the arc is a shape floating near the pin
 * rather than something anchored to where the reader is.
 */
const spoke = await page.evaluate(() => {
  const features = window.__map.getSource('light-directions')?._d?.features || [];
  const core = features.find((feature) => feature.properties.body === 'core'
    && feature.properties.kind !== 'arc');
  return {
    present: !!core,
    label: core?.properties.label || '',
    startsAtPin: core ? JSON.stringify(core.geometry.coordinates[0]) : '',
    // The spoke specifically: the band and the night's track are also 'core',
    // and counting all of them measures the wrong thing.
    spokes: features.filter((feature) => feature.properties.body === 'core'
      && !feature.properties.kind).length,
  };
});
if (spoke.present) {
  check('the core spoke carries its bearing in degrees', /\d+°/.test(spoke.label), true);
  check('and there is one core bearing, not two collinear ones', spoke.spokes, 1);
}

console.log('\nCollapsed Details sections survive a reload');
// Back onto a pin: the step above reloaded, so the panel is on its first tab.
await showTab('waypoints');
await page.waitForTimeout(400);
await page.locator('.waypoint-card').first().click();
await page.waitForTimeout(800);
const sunMoon = () => page.locator('.detail-block').filter({ hasText: 'Photography' }).first();
await page.locator('.detail-block-summary', { hasText: /Photography/i }).click();
await page.waitForTimeout(300);
check('collapsing closes the section', await sunMoon().evaluate((node) => node.open), false);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await showTab('waypoints');
await page.waitForTimeout(300);
await page.locator('.waypoint-card').first().click();
await page.waitForTimeout(900);
check('it is still closed after a reload', await sunMoon().evaluate((node) => node.open), false);
check('sections never collapsed stay open',
  await page.locator('.detail-block').filter({ hasText: 'Field notes' }).first()
    .evaluate((node) => node.open),
  true);

/*
 * A real GaiaGPS export runs to four figures of waypoints. Rendering all of
 * them makes the panel slow to open and slow on every re-render after, so both
 * lists cap what they build — the flat list by page, the tree by growing.
 */
console.log('\nLong lists stay short');
await page.setInputFiles('#file-input', MANY);
await page.waitForTimeout(1400);
await page.click('#import-ask button:has-text("New folder")').catch(() => {});
await page.waitForTimeout(900);

await showTab('waypoints');
await page.waitForTimeout(500);
const firstPage = await page.locator('.waypoint-card').count();
check('the flat list renders one page, not the lot', firstPage <= 30 && firstPage > 0, true);
check('and says where you are in it',
  /1–30 of \d+/.test(await page.locator('.waypoint-pager').innerText()), true);

await page.locator('.waypoint-pager button', { hasText: 'Next' }).click();
await page.waitForTimeout(400);
check('Next advances', /31–60 of \d+/.test(await page.locator('.waypoint-pager').innerText()), true);

// Searching from page 3 must not land on an empty page.
await page.evaluate(() => {
  const box = document.querySelector('#waypoint-search');
  box.value = 'Creamery';
  box.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(400);
const found = await page.locator('.waypoint-card').count();
check('a search from a later page still shows results', found > 0, true);
check('and the cards carry the note that tells them apart',
  await page.locator('.waypoint-blurb').count() > 0, true);

await showTab('folders');
await page.waitForTimeout(500);
// Per folder, not across the panel: a second folder from an earlier step is
// still open below this one.
// Addressed by position, not by "the one with a show-more button": clicking
// that button is what removes it, so the locator would stop matching.
const big = page.locator('.folder').filter({ has: page.locator('.folder-more') }).first();
const bigId = await big.getAttribute('data-folder');
const folder = page.locator(`.folder[data-folder="${bigId}"]`);
const rows = await folder.locator('.folder-item').count();
check('the tree caps what it builds', rows <= 40 && rows > 0, true);
const more = folder.locator('.folder-more');
check('and offers the rest', await more.count(), 1);
await more.click();
await page.waitForTimeout(400);
check('which grows it', await folder.locator('.folder-item').count() > rows, true);

console.log('\nA folder is shown or hidden with an eye, not a checkbox');
const eye = page.locator('.folder-eye').first();
check('the eye is there', await eye.count(), 1);
check('and starts visible', await eye.getAttribute('aria-pressed'), 'true');
await eye.click();
await page.waitForTimeout(300);
check('clicking hides the folder', await page.locator('.folder-eye').first().getAttribute('aria-pressed'), 'false');
await page.locator('.folder-eye').first().click();
await page.waitForTimeout(300);

console.log('\nA pin is edited on the map, not by hunting for its row');
await showTab('waypoints');
await page.waitForTimeout(400);
await page.locator('.waypoint-edit').first().click();
await page.waitForTimeout(700);
check('the editor opens on the pin', await page.locator('.popup-edit').count(), 1);
await page.locator('.popup-edit-name').fill('Renamed on the map');
await page.locator('.popup-edit button', { hasText: 'Save' }).click();
await page.waitForTimeout(600);

// Searched for rather than looked for in place: the list is sorted by name and
// paged, so a rename moves the pin to a different page by definition.
await page.evaluate(() => {
  const box = document.querySelector('#waypoint-search');
  box.value = 'Renamed on the map';
  box.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(400);
check('and the new name reaches the list',
  await page.locator('.waypoint-card', { hasText: 'Renamed on the map' }).count(), 1);

/*
 * The two national shields, checked as pixels.
 *
 * Their silhouettes are the whole recognition and neither can be asserted from
 * Node — they are drawn on a canvas. Both were wrong for a long time with
 * nothing noticing: the interstate was a symmetric lens that read as a blue
 * pill with a bar across it, and the US shield had a straight line across the
 * top where its two peaks belong.
 *
 * Measured as a profile — the first filled row in each column — rather than by
 * sampling fixed points, which is how the first version of this check went
 * wrong: it probed where the peaks ought to be rather than looking for them.
 * A shield "has peaks" if the top edge rises on both sides of a dip, wherever
 * they happen to fall.
 */
console.log('\nThe national shields have the right silhouettes');
const profiles = await page.evaluate(async () => {
  const shields = await import('./assets/js/lib/route-shields.js');
  const read = (design) => {
    const data = shields.rasterizeShield(design, 2, { pixelRatio: 2 });
    const columns = [];
    for (let x = 0; x < data.width; x += 1) {
      let first = -1;
      for (let y = 0; y < data.height; y += 1) {
        if (data.data[(y * data.width + x) * 4 + 3] > 40) { first = y; break; }
      }
      columns.push(first);
    }
    // Filled columns only: the outermost are empty at every row.
    const filled = columns.map((row, x) => ({ row, x })).filter((entry) => entry.row >= 0);
    const mid = Math.round(data.width / 2);
    const half = Math.round(data.width * 0.15);
    const lowest = (from, to) => Math.min(...filled.filter((e) => e.x >= from && e.x <= to).map((e) => e.row));

    return {
      height: data.height,
      centre: columns[mid],
      leftCrest: lowest(half, mid - 2),
      rightCrest: lowest(mid + 2, data.width - half),
      // Widths at fixed heights rather than a function: this object is
      // serialised on its way out of the page, and a method does not survive
      // that crossing.
      widths: [0.15, 0.5, 0.9].map((fraction) => {
        const y = Math.min(data.height - 1, Math.max(0, Math.round(data.height * fraction)));
        let count = 0;
        for (let x = 0; x < data.width; x += 1) {
          if (data.data[(y * data.width + x) * 4 + 3] > 40) count += 1;
        }
        return count / data.width;
      }),
      footWidth: (() => {
        // How wide the shape still is near the bottom, as a fraction.
        const y = Math.round(data.height * 0.9);
        let count = 0;
        for (let x = 0; x < data.width; x += 1) {
          if (data.data[(y * data.width + x) * 4 + 3] > 40) count += 1;
        }
        return count / data.width;
      })(),
    };
  };
  return { interstate: read('interstate'), us: read('us'), forest: read('forest') };
});

const us = profiles.us;
check('the US shield rises to a peak left of centre', us.leftCrest < us.centre - 2, true);

/*
 * The forest marker is a trapezoid, and the shape is most of its job.
 *
 * The real USFS sign carries "National Forest" in script across its foot,
 * which is illegible at twenty pixels - so the silhouette has to say what the
 * lettering would. Checked by measuring it, because the registration check
 * above only asks whether an image exists: deleting the drawing branch left a
 * rounded rectangle registered under the same name, and that check passed.
 */
{
  const [top, middle, foot] = profiles.forest.widths;
  check('the forest marker is wider at the top than the foot', top - foot > 0.08, true);
  check('and tapers rather than stepping', top > middle && middle > foot, true);
}
check('and to another on the right', us.rightCrest < us.centre - 2, true);

const inter = profiles.interstate;
check('the interstate top is flat instead',
  Math.abs(inter.centre - Math.min(inter.leftCrest, inter.rightCrest)) <= 1, true);

/*
 * Both national shields narrow toward the foot rather than bottoming out square.
 *
 * Named rather than looped over everything in `profiles`: this range was
 * measured from the interstate and US silhouettes, and adding the forest
 * trapezoid to that object enrolled it in a check written about two other
 * shapes. It failed on a foot width of 0.78 - which is what the real USFS sign
 * has, so the shape was right and the assertion was borrowed. The trapezoid
 * has its own taper checks above.
 */
for (const name of ['interstate', 'us']) {
  const shape = profiles[name];
  check(`the ${name} tapers`, shape.footWidth > 0.15 && shape.footWidth < 0.75, true);
}

/*
 * State shields come from the real sign blanks, which are PNGs — so they load
 * asynchronously, through the same styleimagemissing hook that covers the
 * drawn ones. The whole feature is silent when it fails: a shield that never
 * arrives is a road with no marker on it.
 */
/*
 * Texas is the one drawn marker that carries a word, and a word is the kind of
 * thing that renders as nothing without anybody noticing — the canvas does not
 * throw for a font it cannot find, it just draws no ink.
 */
console.log('\nThe Texas marker carries its own name');
const lettering = await page.evaluate(async () => {
  const shields = await import('./assets/js/lib/route-shields.js');
  const ink = (code) => {
    const data = shields.rasterizeShield(`st-${code}`, 2, { pixelRatio: 4 });
    if (!data) return null;
    const canvas = document.createElement('canvas');
    canvas.width = data.width;
    canvas.height = data.height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(data, 0, 0);
    // The foot of the marker, inside its frame.
    const band = ctx.getImageData(6, Math.round(data.height * 0.72), data.width - 12, Math.round(data.height * 0.16));
    let dark = 0;
    for (let i = 0; i < band.data.length; i += 4) {
      if (band.data[i + 3] > 100 && band.data[i] < 120) dark += 1;
    }
    return dark;
  };
  return { texas: ink('TX'), plain: ink('NY') };
});
check('there is ink where the name goes', lettering.texas > 60, true);
check('and a plain square has none there', lettering.plain < lettering.texas / 3, true);

console.log('\nA state shield loads from its blank');
const blank = await page.evaluate(async () => {
  const shields = await import('./assets/js/lib/route-shields.js');
  const added = [];
  const fake = { hasImage: () => false, addImage: (id) => added.push(id) };

  const ok = await shields.loadShieldBlank(fake, 'abmap-shield-st-TN-2', { base: './' });
  const missing = await shields.loadShieldBlank(fake, 'abmap-shield-st-KY-2', { base: './' });
  const national = await shields.loadShieldBlank(fake, 'abmap-shield-interstate-2', { base: './' });
  const wide = await shields.loadShieldBlank(fake, 'abmap-shield-us-3', { base: './' });

  return {
    ok, missing, national, wide, added,
    // The interstate number has to clear the red band across the top.
    interstate: shields.shieldTextOffset('interstate', 2),
    // Tennessee's name runs along the bottom of its marker, so its number sits
    // high; Illinois's runs along the top, so its number sits low. If both come
    // back zero the measurement step did not happen.
    tennessee: shields.shieldTextOffset('st-TN', 2),
    illinois: shields.shieldTextOffset('st-IL', 2),
  };
});

check('a state with a blank loads it', blank.ok, true);
check('a state without one falls through to the drawing', blank.missing, false);
check('the interstate has a blank of its own now', blank.national, true);
check('and a wide one for three digits', blank.wide, true);
check('all four register under the ids the style asks for', blank.added, [
  'abmap-shield-st-TN-2', 'abmap-shield-interstate-2', 'abmap-shield-us-3',
]);
check('a name along the top pushes the number down', blank.illinois[1] > 0.1, true);
check('and one along the bottom pushes it up', blank.tennessee[1] < -0.1, true);

console.log('\nThe build stamp is readable');
const stamp = (await page.locator('#build-stamp').innerText().catch(() => '')).trim();
check('build stamp is shown', stamp.length > 0, true);

/*
 * The stale-page notice. Last of everything, because it reloads.
 *
 * A page can be running code older than what is deployed for ten minutes after
 * every push — Pages caches HTML and there is no header to change that — and
 * because the asset URLs are content-hashed, stale HTML pins the whole bundle.
 * That state is indistinguishable from a deploy that did not run, which is what
 * it was mistaken for twice.
 */
console.log('\nA page running older code than the server says so');
check('nothing is claimed while the page is current',
  await page.locator('.build-newer').count(), 0);

pretendNewerBuild = true;
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.build-newer', { timeout: 5000 }).catch(() => {});
check('and it offers a reload once the server has moved on',
  await page.locator('.build-newer').count(), 1);

/*
 * The dropped-pin card.
 *
 * It carries a lot now — a symbol, field notes and a folder name are all set
 * before the pin is saved rather than after — and every one of them has to
 * survive into the folder or the extra fields are decoration.
 */
console.log('\nA dropped pin is described before it is saved');
/*
 * Reached by its own button, not by tapping the map.
 *
 * Tapping now asks what is under the finger, because that is the thing you do
 * over and over. The pin is deliberate, so it has a control — which also drops
 * it at the centre of the screen, where you can put it precisely by panning
 * rather than by hitting a spot with a thumb.
 */
await page.locator('.map-tool').nth(1).click();
await page.waitForTimeout(400);

check('the card opens', await page.locator('.drop-pin').count(), 1);
check('elevation is not on it — it is the slowest lookup and the Details tab has it',
  (await page.locator('.drop-pin').innerText()).includes('Elevation'), false);
check('the forecast is, being the reason to pin a place you have not driven to',
  (await page.locator('.drop-pin').innerText()).includes('Weather'), true);

// Details and Close sit together at the foot rather than a bare glyph in the
// corner, so both are labelled and both are a real target for a thumb.
const footer = (await page.locator('.popup-bar').innerText()).replace(/\s+/g, ' ').trim();
check('Details and Close are side by side at the foot', footer, 'Details Close');

/*
 * The symbol is picked from the symbols.
 *
 * It was a <select> of names, which on iOS is a full-height native wheel of
 * forty words — and "Plain pin" says nothing about the mark that lands on the
 * map.
 */
check('the symbol is a button, not a list of names',
  await page.locator('.drop-pin-symbol').count(), 1);
check('showing the mark itself', await page.locator('.drop-pin-symbol svg').count(), 1);
check('the choices are closed until asked for',
  await page.locator('.drop-pin-symbols').isVisible(), false);
await page.locator('.drop-pin-symbol').click();
check('and open as a grid of marks', await page.locator('.drop-pin-symbols').isVisible(), true);
const choices = await page.locator('.drop-pin-symbol-choice').count();
check('with every symbol in it', choices > 12, true);

const wanted = page.locator('.drop-pin-symbol-choice').nth(2);
const symbol = await wanted.getAttribute('title');
await wanted.click();
check('choosing one closes the grid again',
  await page.locator('.drop-pin-symbols').isVisible(), false);

/*
 * Saving asks nothing until it is asked for.
 *
 * A folder select and an unlabelled name box used to sit on the card at all
 * times, so a pin nobody had asked to save showed "New folder" above a box
 * reading "Saved places" with no way to tell what either was.
 */
check('the folder choice is collapsed behind one button',
  await page.locator('.popup-save-panel').isVisible(), false);
await page.locator('.popup-save-open').click();
check('which opens it', await page.locator('.popup-save-panel').isVisible(), true);
check('and both fields are labelled',
  (await page.locator('.popup-save-panel').innerText()).includes('SAVE INTO')
    || (await page.locator('.popup-save-panel').innerText()).toUpperCase().includes('SAVE INTO'), true);

await page.locator('.drop-pin-name').fill('Cave spring');
await page.locator('.drop-pin-note').fill('Water here in August. Write-up at https://example.org/spring, worth a read.');

const folderSelect = page.locator('.popup-folder');
await folderSelect.selectOption(await folderSelect.locator('option').first().getAttribute('value'));
check('naming is hidden while an existing folder is the choice',
  await page.locator('.popup-new-folder').isVisible(), false);
await folderSelect.selectOption('__new__');
check('and appears inline for a new one, rather than as a system prompt',
  await page.locator('.popup-new-folder').isVisible(), true);

await page.locator('.popup-new-folder').fill('Field notes');
await page.locator('.popup-save-confirm button').first().click();
await page.waitForTimeout(500);

const saved = await page.evaluate(async () => {
  const list = await window.__readFolders();
  const folder = list.find((entry) => entry.name === 'Field notes');
  const item = folder?.items?.[0]?.feature?.properties;
  return { folder: folder?.name, name: item?.name, note: item?.description, icon: item?.icon };
});
check('the folder is created with the name that was typed', saved.folder, 'Field notes');
check('the pin keeps the name it was given', saved.name, 'Cave spring');
check('the field notes reach the saved pin', saved.note,
  'Water here in August. Write-up at https://example.org/spring, worth a read.');
check('and the symbol that was chosen is the one that was saved',
  typeof saved.icon === 'string' && saved.icon.length > 0 && symbol !== null, true);

/*
 * Opening a saved pin.
 *
 * Two things that were both wrong here. The engine focuses the first focusable
 * thing in a popup when it opens; on iOS a focused <select> opens its picker,
 * so tapping a saved pin threw a full-screen wheel of folder names over the
 * map. And a web address typed into a note was text, when the reason somebody
 * writes one down is to follow it.
 */
await showTab('waypoints');
await page.waitForTimeout(300);
await page.locator('.waypoint-card', { hasText: 'Cave spring' }).first().click();
await page.waitForTimeout(900);

const opened = await page.evaluate(() => {
  const popup = document.querySelector('.maplibregl-popup-content, .mapboxgl-popup-content');
  const anchor = popup?.querySelector('.popup-desc a');
  return {
    focused: document.activeElement?.tagName || '',
    inPopup: Boolean(popup && document.activeElement && popup.contains(document.activeElement)),
    href: anchor?.getAttribute('href') || '',
    text: anchor?.textContent || '',
    target: anchor?.getAttribute('target') || '',
    rel: anchor?.getAttribute('rel') || '',
    selects: popup ? popup.querySelectorAll('select').length : -1,
  };
});
check('a saved pin has a folder picker on its popup', opened.selects > 0, true);
check('but opening the popup does not put focus into it', opened.inPopup, false);
check('so no native picker is thrown over the map', opened.focused === 'SELECT', false);
check('the address in the note is a link', opened.href, 'https://example.org/spring');
check('showing the address itself, not a label over it', opened.text, 'https://example.org/spring');
check('and it opens away from the map, safely',
  `${opened.target} ${opened.rel}`, '_blank noopener noreferrer');
// Shut it again, or the checks below count this card as well as their own.
// The close control is the app's own, on the popup's action bar.
await page.evaluate(() => {
  const popup = document.querySelector('.maplibregl-popup, .mapboxgl-popup');
  const close = popup?.querySelector('.maplibregl-popup-close-button, .mapboxgl-popup-close-button');
  if (close) close.click(); else popup?.remove();
});
await page.waitForTimeout(300);
check('and it shuts again', await page.locator('.maplibregl-popup, .mapboxgl-popup').count(), 0);

/*
 * The table editor.
 *
 * The panel is a column beside a map: one pin at a time, read on a phone.
 * Editing a hundred wants rows and columns, so this is a full-screen view over
 * everything, with the bulk bar appearing only once something is ticked.
 */
await showTab('waypoints');
await page.waitForTimeout(300);
await page.locator('#open-table').click();
await page.waitForTimeout(500);
check('the table opens over the map', await page.locator('#table-editor').isVisible(), true);
const columns = await page.locator('#table-editor thead th').evaluateAll(
  (nodes) => nodes.map((node) => node.textContent.trim()).filter(Boolean));
check('with a column for everything a pin wears',
  // Name carries the sort arrow, since the table opens sorted by it.
  columns.map((label) => label.replace(/\s*[\u2191\u2193]$/, '')),
  ['Pin', 'Name', 'Symbol', 'Color', 'Folder', 'Note', 'Link']);
check('and a row for the saved pin', await page.locator('#table-editor tbody tr').count() >= 1, true);
check('the bulk bar waits to be given something to act on',
  (await page.locator('.table-bulk-count').textContent()).includes('Tick rows'), true);

await page.locator('#table-editor tbody tr .table-tick input').first().check();
await page.waitForTimeout(250);
check('ticking a row brings it out', await page.locator('.table-bulk-count').textContent(), '1 selected');
const bulkControls = await page.locator('.table-bulk select').evaluateAll(
  (nodes) => nodes.map((node) => node.options[node.selectedIndex]?.textContent));
check('offering symbol, colour and folder, each starting on a label rather than a value',
  bulkControls, ['Set symbol…', 'Set color…', 'Move to…']);

// The colour menu is words, because eighteen identical circles is not a menu.
const colourWords = await page.locator('.table-bulk-color option').evaluateAll(
  (nodes) => nodes.map((node) => node.textContent));
check('and the colours are named', colourWords.includes('Yellow') && colourWords.includes('Brown'), true);

await shot(page.locator('#table-editor'), 'table-editor');
await page.locator('.table-bulk button', { hasText: 'Clear' }).click();
await page.waitForTimeout(200);

/*
 * Finding the pins that need the work.
 *
 * The menus are built from what the collection actually holds, with counts:
 * a menu of a hundred and twenty symbols, of which four are used, is a worse
 * way to find the four. "No color" is in there because "show me the plain
 * ones" is the question this was asked for.
 */
const facetMenus = await page.evaluate(() => ({
  symbols: [...document.querySelectorAll('.table-filter-symbol option')].map((o) => o.textContent),
  colors: [...document.querySelectorAll('.table-filter-color option')].map((o) => o.textContent),
}));
check('the symbol menu lists only what is in use, counted',
  facetMenus.symbols.length > 1 && facetMenus.symbols.every((t) => /\(\d+\)$/.test(t)), true);
check('and the colour menu offers the ones with none',
  facetMenus.colors.some((t) => t.startsWith('No color (')), true);

const rowCount = () => page.locator('#table-editor tbody tr').count();
const everything = await rowCount();
await page.selectOption('.table-filter-color', '__none__');
await page.waitForTimeout(300);
const plain = await rowCount();
check('filtering to the uncoloured ones narrows the table', plain > 0 && plain <= everything, true);
await page.selectOption('.table-filter-color', '');
await page.waitForTimeout(250);

// The search reads what a pin wears, so a colour word finds pins by colour.
await page.locator('.table-search').click();
await page.keyboard.type('no color', { delay: 25 });
await page.waitForTimeout(350);
check('and searching a colour word does the same', await rowCount(), plain);
await page.fill('.table-search', '');
await page.waitForTimeout(250);

/*
 * Sorting. The table opens sorted by name, so the first press of that heading
 * reverses it rather than doing nothing - which is what somebody pressing an
 * already-sorted column means.
 */
const names = () => page.locator('#table-editor tbody tr .table-name')
  .evaluateAll((nodes) => nodes.map((node) => node.value));
const ascending = await names();
check('the table opens sorted by name',
  await page.locator('.table-grid th[aria-sort="ascending"] .table-sort').textContent(), 'Name \u2191');

await page.locator('.table-sort', { hasText: 'Name' }).click();
await page.waitForTimeout(300);
check('pressing that heading reverses it',
  await page.locator('.table-grid th[aria-sort="descending"] .table-sort').textContent(), 'Name \u2193');
const descending = await names();
check('and the rows turn round with it', descending[0] !== ascending[0], true);

await page.locator('.table-sort', { hasText: 'Color' }).click();
await page.waitForTimeout(300);
check('a different heading starts over ascending',
  await page.locator('.table-grid th[aria-sort="ascending"] .table-sort').textContent(), 'Color \u2191');
check('and only one heading claims the sort',
  await page.locator('.table-grid th[aria-sort="ascending"], .table-grid th[aria-sort="descending"]').count(), 1);
await shot(page.locator('#table-editor'), 'table-sorted');

// Typing in the search must not lose the caret: every keystroke redraws the
// table, and a redraw that drops focus makes the search unusable.
await page.locator('.table-search').click();
await page.keyboard.type('cave', { delay: 40 });
await page.waitForTimeout(300);
check('typing in the search keeps the caret', await page.evaluate(
  () => document.activeElement?.classList.contains('table-search')), true);
check('and filters as it goes', await page.locator('.table-search').inputValue(), 'cave');

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Escape closes the table', await page.locator('#table-editor').isVisible(), false);
await showTab('folders');
await page.waitForTimeout(200);

await showTab('layers');
await page.waitForTimeout(200);

// A second card, to check the close button rather than the save button.
await page.locator('.map-tool').nth(1).click();
await page.waitForTimeout(300);
await page.locator('.popup-bar button').nth(1).click();
await page.waitForTimeout(200);
check('Close closes it', await page.locator('.drop-pin').count(), 0);

/*
 * Tapping a road to find out what it is.
 *
 * Both layers are server-rendered images, so there is nothing in the browser
 * to click — the answer comes from asking each service what is under the
 * point, and the card has to hold two agencies that use the same words to mean
 * different things.
 */
console.log('\nA tap can ask what a road is');
// Earlier sections leave another tab showing, and a checkbox in a hidden tab
// panel is present but unclickable.
await showTab('layers');
await page.waitForTimeout(300);
await openGroup('Land & access');
for (const name of ['Forest roads (MVUM)', 'BLM routes']) {
  await page.locator('.layer-row', { hasText: name }).locator('input[type=checkbox]').check();
}
await page.waitForTimeout(700);

const tools = page.locator('.map-tool');
check('there are two map tools under the zoom controls', await tools.count(), 2);
// Inspecting is what you do repeatedly — every road you consider driving —
// so the tap does that by default and the button is lit to say so. A mode
// with no visible state is a trap.
check('the inspector is on from the start, and says so',
  await tools.nth(0).evaluate((node) => node.classList.contains('is-on')), true);
check('and it is the first of the two, above the pin',
  await tools.nth(0).getAttribute('aria-pressed'), 'true');

/*
 * A lake and a forest road under the same tap, from the basemap's own tiles.
 *
 * Staged rather than mocked over the network on purpose: these come out of
 * vector tiles already drawn on the screen, so the feature has to work with
 * the radio off, and there is no request to intercept.
 */
await page.evaluate(() => {
  window.__rendered = [
    { sourceLayer: 'water', properties: { name: 'Fish Lake', class: 'lake' } },
    { sourceLayer: 'water', properties: { name: 'Fish Lake', class: 'lake' } },
    { sourceLayer: 'road', properties: { class: 'track', surface: 'unpaved', ref: 'FR 640' } },
    { sourceLayer: 'landuse', properties: { name: 'Fishlake National Forest', class: 'national_park' } },
    { sourceLayer: 'contour', properties: { ele: 2600 } },
    { sourceLayer: 'landuse', properties: { class: 'grass' } },
  ];
});

await page.evaluate(() => window.__map.fire('click', {
  lngLat: { lng: -111.5, lat: 38.5 }, point: { x: 400, y: 400 },
  originalEvent: { pointerType: 'touch', width: 40, height: 40 },
}));
await page.waitForTimeout(900);

// A mode, not a one-shot: you look at one road, then the one it joins. Having
// to re-arm between each would make the common case the awkward one.
check('and it stays on after answering, so the next road is one tap away',
  await page.locator('.map-tool.is-on').count(), 1);

const card = await page.evaluate(() => {
  const node = document.querySelector('.identify-card');
  if (!node) return null;
  const rows = {};
  for (const group of node.querySelectorAll('.identify-group')) {
    const source = group.querySelector('.identify-source')?.textContent.trim();
    const pairs = [...group.querySelectorAll('dt')].map((dt, i) => [
      dt.textContent.trim(), group.querySelectorAll('dd')[i]?.textContent.trim(),
    ]);
    rows[source] = { designation: group.querySelector('.identify-designation')?.textContent.trim(),
      pairs: Object.fromEntries(pairs) };
  }
  // Keyed by source for the checks below, but the raw list too: a duplicate
  // group would collapse into one key and a check on the keys could not see it.
  rows.__sources = [...node.querySelectorAll('.identify-source')].map((n) => n.textContent.trim());
  return rows;
});

check('both agencies answer into one card, and the basemap with them',
  card.__sources.slice().sort(),
  ['BLM travel management', 'Forest Service MVUM', 'Land', 'Road', 'Water']);
check('the lake is named from the tile it is drawn from', card.Water.designation, 'Fish Lake');
check('and it is listed once, however many times it was drawn',
  card.__sources.filter((source) => source === 'Water').length, 1);
check('a nameless road still answers, because its surface is the answer',
  card.Road.pairs.Surface, 'Unpaved');
check('and its class is spelled as a word', card.Road.designation, 'Track');

/*
 * One tap, one card, and the save on the card that did the naming.
 *
 * Reported from the phone: tapping a trailhead with a recreation layer on
 * opened two cards over each other. This one named the place and listed its
 * attributes; a second, from that overlay's own layer, knew almost nothing
 * about it and had the only save button on screen. The reader had to notice
 * that the useful card and the actionable card were different cards.
 *
 * Both halves are checked, because fixing either alone still leaves it wrong:
 * a single card with no way to save it, or a save button on a card that has
 * gone back to being one of two.
 */
check('one tap leaves one card, not a queried overlay opening a second',
  await page.locator('.identify-card, .feature-popup, .drop-pin').count(), 1);
check('and the card that named the place is the one offering to keep it',
  await page.locator('.identify-card .popup-save-open').count(), 1);

await page.locator('.identify-card .popup-save-open').click();
check('which opens the folder picker in place, on the same card',
  await page.locator('.identify-card .popup-save-panel').isVisible(), true);

await page.locator('.identify-card .popup-folder').selectOption('__new__');
await page.locator('.identify-card .popup-new-folder').fill('From the map');
await page.locator('.identify-card .popup-save-confirm button').first().click();
await page.waitForTimeout(500);

const fromIdentify = await page.evaluate(async () => {
  const list = await window.__readFolders();
  return list.find((entry) => entry.name === 'From the map')?.items?.[0]?.feature?.properties?.name;
});
/*
 * The name is the point. A pin saved off this card used to be impossible, and
 * the obvious way to add it - hand the save a bare point - would file
 * "Dropped pin" over a place the card had just named on screen.
 */
check('and the pin is named after what the card identified, not "Dropped pin"',
  fromIdentify, 'Fish Lake');

/*
 * Saving closes the card and moves to Folders, which is right for somebody who
 * just saved something and wrong for the checks below, which go on reading
 * this card and its layer switches. Put both back.
 */
await showTab('layers');
await page.evaluate(() => window.__map.fire('click', {
  lngLat: { lng: -111.5, lat: 38.5 }, point: { x: 400, y: 400 },
  originalEvent: { pointerType: 'touch', width: 40, height: 40 },
}));
await page.waitForTimeout(900);
check('the forest around it is named too', card.Land.designation, 'Fishlake National Forest');

// The mark stays under the card: "on this spot" with nothing marking the spot
// is a riddle, and a tap that finds nothing then looks like a tap that never
// happened.
check('the tapped spot is marked on the map',
  await page.evaluate(() => {
    const data = window.__map.getSource('scratch-cursor')?._d;
    return data?.geometry?.type === 'Point';
  }), true);
check('BLM\'s designation comes from the sublayer name, where it lives',
  card['BLM travel management'].designation, 'Roads Managed for Limited Public Motorized Use');
check('and the limit is spelled out rather than left as the word "Limited"',
  card['BLM travel management'].pairs['The limit'], 'Street-legal vehicles only; no OHV use.');
/*
 * The agency's vocabulary, said the way a person would say it.
 *
 * Read straight out these mislead. "yearlong" sounds like a year-long
 * restriction rather than a road open all year; "2 - HIGH CLEARANCE VEHICLES"
 * is a maintenance level whose number means nothing without the handbook; and
 * a road called GILFORD is shouting.
 */
const mvum = card['Forest Service MVUM'].pairs;
check('a shouted road name is said normally', mvum.Road, 'Gilford');
check('"yearlong" is spelled out as open all year', mvum.Open, 'All year');
check('a surface code becomes the surface', mvum.Surface, 'Dirt — native material, no surfacing');
check('and a maintenance level says what it needs',
  mvum['Road standard'], 'Level 2 — high clearance needed');
check('the managing agency loses its abbreviation', mvum['Managed by'], 'Forest Service');

// Trimmed to what decides whether you drive it. GTLF publishes about thirty
// columns; showing eleven of them was a wall on a phone.
const blm = card['BLM travel management'].pairs;
check('the BLM card stays short enough to read', Object.keys(blm).length <= 7, true);
check('and drops the paperwork rather than the answer',
  Object.keys(blm).some((k) => /nepa|distribution|admin|authority|ownership/i.test(k)), false);
check('while keeping what the limit actually is', Boolean(blm['The limit']), true);

check('internal bookkeeping is not shown',
  Object.keys(card['BLM travel management'].pairs).some((k) => /object|global|shape/i.test(k)), false);
check('nor are the service\'s own nulls',
  JSON.stringify(card['BLM travel management'].pairs).includes('Null'), false);

// The Forest Service spreads permission over a column per vehicle. Listed raw
// that is a dozen rows of "yes"; the card pairs each with its dates instead.
check('the MVUM vehicle columns fold into one line',
  card['Forest Service MVUM'].pairs['Open to'], 'Motorcycle, Otherwheeled ohv (05/15-10/31)');
check('a class with no dates and no value is not listed as open',
  card['Forest Service MVUM'].pairs['Open to'].includes('Tracked'), false);

/*
 * What the card says when nothing is designated.
 *
 * On a Motor Vehicle Use Map the designation IS the permission, so a route
 * with no class designated is a closed one. Anything softer than saying so —
 * "no restrictions noted", say — inverts the meaning and could put somebody
 * down a road they may not drive.
 */
await page.evaluate(() => {
  window.__identifyNothingOpen = true;
  window.__map.fire('click', { lngLat: { lng: -84.1, lat: 35.6 }, point: { x: 300, y: 300 },
    originalEvent: { pointerType: 'mouse' } });
});
await page.waitForTimeout(900);
const closed = await page.evaluate(() => {
  const group = [...document.querySelectorAll('.identify-group')]
    .find((n) => /Forest Service/.test(n.textContent));
  const pairs = [...(group?.querySelectorAll('dt') || [])].map((dt, i) => [
    dt.textContent.trim(), group.querySelectorAll('dd')[i]?.textContent.trim()]);
  return Object.fromEntries(pairs)['Open to'] || '';
});
check('an undesignated route is called closed, not unrestricted',
  /closed to motor vehicles/i.test(closed), true);
check('and it never claims the absence of a rule is permission',
  /no restriction|unrestricted|permitted/i.test(closed), false);

await shot(page.locator('.identify-card .popup-tail'), 'identify-full');

await page.locator('.identify-card .identify-close').click();
await page.waitForTimeout(200);
for (const name of ['Forest roads (MVUM)', 'BLM routes']) {
  await page.locator('.layer-row', { hasText: name }).locator('input[type=checkbox]').uncheck();
}
await page.waitForTimeout(400);

/*
 * The card with nothing on it, and the way out of it.
 *
 * This card is the one that draws none of the lines a found feature draws - no
 * title, no source, no designation, just a paragraph saying nothing was there.
 * A close mark in the corner had nothing to sit beside on it and landed in the
 * middle of the first sentence; a labelled Close on the last row cannot, and
 * matches the bar a dropped pin has always had.
 *
 * Measured as geometry rather than as a class list. Two buttons of the same
 * width on one line is the whole of what was asked for, and a grid that has
 * quietly gone back to thirds still has both buttons present and both classes
 * on the row.
 */
await page.evaluate(() => {
  window.__rendered = [];
  window.__identifyNothingOpen = false;
  window.__map.fire('click', { lngLat: { lng: -111.2, lat: 38.2 }, point: { x: 380, y: 380 },
    originalEvent: { pointerType: 'touch', width: 40, height: 40 } });
});
await page.waitForTimeout(900);
const empty = await page.evaluate(() => {
  const card = document.querySelector('.identify-card');
  const text = card?.querySelector('.identify-body > p');
  const row = [...(card?.querySelectorAll('.popup-row') || [])].pop();
  if (!text || !row) return { found: false };
  const buttons = [...row.children].map((node) => ({
    label: node.textContent.trim(),
    width: Math.round(node.getBoundingClientRect().width),
  }));
  const range = document.createRange();
  range.selectNodeContents(text);
  const lines = [...range.getClientRects()];
  // Nothing is allowed to sit on the sentence, whatever it is.
  const covered = [...card.querySelectorAll('button, a')].some((node) => {
    const box = node.getBoundingClientRect();
    return lines.some((line) => line.right > box.left + 1 && line.left < box.right - 1
      && line.bottom > box.top + 1 && line.top < box.bottom - 1);
  });
  return { found: true, buttons, covered, lines: lines.length };
});
check('a tap that finds nothing still says so', empty.found, true);
check('and offers the two ways on from it, labelled',
  empty.buttons?.map((b) => b.label), ['Details', 'Close']);
check('as two boxes of the same width',
  empty.buttons?.[0].width === empty.buttons?.[1].width, true);
check('with nothing sitting on the sentence above them', empty.covered, false);
check('which takes more than one line, so the card is laid out at a card\'s width',
  empty.lines > 1, true);

await shot(page.locator('.identify-card'), 'identify-empty');

await page.locator('.identify-card .identify-close').click();
await page.waitForTimeout(200);

/*
 * The engine's own stylesheet must not win against ours.
 *
 * Both define `.mapboxgl-popup-content` at the same specificity, so whichever
 * loads last takes the background — and the engine's was being appended at
 * runtime, after ours. In dark mode that handed the popup card back to #fff
 * while the panel behind it stayed dark. Reported twice before it was found,
 * because a synthetic card in a page with no engine CSS looks perfectly fine.
 */
console.log('\nThe engine\'s chrome styles lose to ours, not the other way round');
check('the engine stylesheet is inserted ahead of the app\'s', await page.evaluate(() => {
  const sheets = [...document.head.querySelectorAll('link[rel="stylesheet"], style')];
  const engine = sheets.findIndex((n) => /mapbox-gl\.css|maplibre-gl\.css/.test(n.getAttribute('href') || ''));
  const app = sheets.findIndex((n) => /viewer\.css/.test(n.getAttribute('href') || ''));
  // -1 for the engine means it never loaded, which this check cannot speak to.
  return engine === -1 || app === -1 || engine < app;
}), true);

/*
 * And the consequence, which is the part anybody actually sees.
 *
 * Checked on `color` rather than `background`: this suite runs in the default
 * light scheme, where the app's popup background and the engine's are both
 * #fff and a background check cannot tell a win from a loss. The engine sets
 * `color:#000`; the app sets --ink, which is #1c1815. Those differ in every
 * scheme, so the check means something in the one this suite runs in.
 */
check('so a popup card keeps the app\'s ink, not the engine\'s',
  await page.evaluate(() => {
    const card = document.createElement('div');
    card.className = 'mapboxgl-popup-content';
    document.body.append(card);
    const ink = getComputedStyle(card).color;
    card.remove();
    return ink;
  }), 'rgb(28, 24, 21)');

/*
 * A layer whose key comes from the service, not from the catalogue.
 *
 * Three layers have carried a `legendJSON` since they were added and nothing
 * read it, so BLM routes showed its note and no key at all. The fetcher for it
 * existed and was never called.
 */
console.log('\nA service-published key reaches the panel');
await openGroup('Land & access');
await page.waitForTimeout(900);
const blmKey = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.layer-row')]
    .find((node) => node.textContent.includes('BLM routes'));
  // The row and its description are appended as a pair, so they are adjacent
  // siblings inside the group — not nested in a wrapper of their own. Asking
  // the parent for ".layer-desc" returns the FIRST layer's description in the
  // whole group, which is how this check reported an empty key for a key that
  // was being filled correctly.
  const desc = row?.nextElementSibling?.classList.contains('layer-desc')
    ? row.nextElementSibling
    : null;
  const slot = desc?.querySelector('.legend-slot');
  return {
    found: !!row,
    rows: [...(slot?.querySelectorAll('.legend-item') || [])].map((n) => n.textContent.trim()),
    swatches: slot?.querySelectorAll('img.legend-swatch').length || 0,
  };
});
check('the BLM routes row is there', blmKey.found, true);
check('and its key is filled from the service', blmKey.rows, ['Open to all vehicles', 'Open seasonally']);
check('each class drawn with the swatch the service published', blmKey.swatches, 2);

/*
 * The eclipse tab.
 *
 * The times are the same for the whole planet — a lunar eclipse is the moon
 * crossing one shadow — so the only thing this place decides is whether the
 * moon is above the horizon for it, which is what turns a date in a table into
 * a reason to drive somewhere.
 */
console.log('\nThe next eclipse, and whether this spot will see it');
await showTab('waypoints');
await page.waitForTimeout(300);
await page.locator('.waypoint-card').first().click();
await page.waitForTimeout(700);
await openGroup('Photography');
await page.waitForTimeout(300);

const eclipseTab = page.locator('.sky-tab', { hasText: 'Eclipse' });
check('there is an eclipse tab under Photography', await eclipseTab.count(), 1);
await eclipseTab.click();
await page.waitForTimeout(600);

const eclipse = await page.evaluate(() => {
  const panel = document.querySelector('.sky-panel');
  const hero = panel.querySelector('.eclipse-now');
  return {
    kind: hero?.className || '',
    short: panel.querySelector('.eclipse-short')?.textContent.trim() || '',
    when: panel.querySelector('.eclipse-when')?.textContent.trim() || '',
    headline: panel.querySelector('.eclipse-headline')?.textContent.trim() || '',
    verdict: panel.querySelector('.eclipse-verdict')?.textContent.trim() || '',
    stages: [...panel.querySelectorAll('.eclipse-chip-when')].map((n) => n.textContent.trim()),
    alts: [...panel.querySelectorAll('.eclipse-chip-alt')].map((n) => n.textContent.trim()),
    // The shadow's centre in each chip, so the sequence can be checked as a
    // sequence rather than as five unrelated pictures.
    shadows: [...panel.querySelectorAll('.eclipse-chip .eclipse-umbra')]
      .map((n) => Number(n.getAttribute('cx'))),
    // The clip path holds a copy of the moon disc; it is machinery rather than
    // one of the drawn circles, and it has no class, which is how it is told
    // apart here.
    circles: [...panel.querySelectorAll('.eclipse-now .eclipse-diagram circle')]
      .filter((n) => n.getAttribute('class'))
      .map((n) => ({ r: Number(n.getAttribute('r')), cls: n.getAttribute('class') })),
    // The curved terminator is the clip, not a drawn path: without it the
    // shadow is a full circle sitting over the moon rather than across it.
    clipped: !!panel.querySelector('.eclipse-now .eclipse-diagram g[clip-path]'),
  };
});

check('the headline card is built like the weather one', /eclipse-now/.test(eclipse.kind), true);
check('and carries the kind in its wash',
  /is-(total|partial|penumbral)/.test(eclipse.kind), true);
check('it names the kind of eclipse', /lunar eclipse/.test(eclipse.short), true);
check('and dates it', eclipse.when.length > 8, true);
check('with one number at size', eclipse.headline.length > 0, true);
check('the verdict says whether the moon is up for it here',
  /visible|below the horizon|edges of it/i.test(eclipse.verdict), true);
check('greatest eclipse is always one of the stages',
  eclipse.stages.includes('GREATEST') || eclipse.stages.includes('Greatest'), true);
check('and every stage says whether the moon is up at that moment',
  eclipse.alts.length, eclipse.stages.length);

/*
 * The strip has to read as a sequence.
 *
 * Each chip draws the shadow where it actually is at that moment — the offset
 * along the chord — so the bite grows and shrinks across the row. If every
 * chip drew the same picture the strip would be decoration.
 */
check('the shadow crosses the face left to right across the strip',
  eclipse.shadows.every((cx, i) => i === 0 || cx > eclipse.shadows[i - 1]), true);
check('and it is centred on the moon in the middle',
  eclipse.shadows.length >= 3
    && Math.abs(eclipse.shadows[Math.floor(eclipse.shadows.length / 2)] - 14) < 1,
  true);

/*
 * The picture has to agree with the physics, and it did not.
 *
 * The first version used Meeus's contact distances as the shadow radii; those
 * already contain a moon radius each, so both circles came out one moon too
 * big and a partial eclipse drew as a total one. It looked entirely plausible.
 *
 * The draw order is the picture: the lit face, then the two shadows clipped to
 * it, then the rim over the top. Drawn in any other order the shadow is either
 * buried under the face or spilled outside the disc.
 */
const [face, penumbra, umbra, rim] = eclipse.circles;
check('the diagram is drawn face, shadow, shadow, rim',
  [face.cls, penumbra.cls, umbra.cls, rim.cls],
  ['eclipse-face', 'eclipse-penumbra', 'eclipse-umbra', 'eclipse-rim']);
check('the umbra sits inside the penumbra', umbra.r < penumbra.r, true);
check('and the moon is smaller than the shadow it crosses', face.r < umbra.r, true);
check('the rim traces the face exactly', rim.r, face.r);
check('and the shadows are clipped to the face', eclipse.clipped, true);

/*
 * The eclipse on the map, and the slider across it.
 *
 * Same drawing the "Everything" tab uses, deliberately: switching this on has
 * to REPLACE the Milky Way lines rather than add six more spokes over them,
 * because "it is cluttered with the drawing feature" is the reason this button
 * exists at all.
 */
console.log('\nDrawing the eclipse on the map');

/*
 * Guarded, because which half of the planet sees the next eclipse is a fact
 * about the calendar rather than about this code. Half the year the Smokies
 * are on the wrong side of it, and a check that failed then would be reporting
 * the date, not a bug — so an eclipse nobody here can see is checked for the
 * one thing that is true of it: nothing is offered to draw.
 */
const eclipseToggle = page.locator('[data-toggle="eclipse-lines"]');
if (/^Not from here/.test(eclipse.verdict)) {
  check('an eclipse below the horizon here offers nothing to draw',
    await eclipseToggle.count(), 0);
} else {
  check('the eclipse tab offers to draw it on the map', await eclipseToggle.count(), 1);

  await eclipseToggle.first().click();
  await page.waitForTimeout(500);

  const drewEclipse = await page.evaluate(() => {
    const panel = document.querySelector('.sky-panel');
    const features = window.__map.getSource('light-directions')?._d?.features || [];
    return {
      label: panel.querySelector('[data-toggle="eclipse-lines"]')?.textContent.trim() || '',
      scrubber: panel.querySelector('.scrub-label')?.textContent.trim() || '',
      readout: panel.querySelector('.scrub-time')?.textContent.trim() || '',
      marks: [...panel.querySelectorAll('.scrub-mark-label')].map((node) => node.textContent.trim()),
      bodies: [...new Set(features.map((feature) => feature.properties.body))],
      kinds: [...new Set(features.map((feature) => feature.properties.kind
        || (feature.properties.now ? 'now' : 'bearing')))],
    };
  });

  check('the button turns into its own off switch', /hide the eclipse/i.test(drewEclipse.label), true);
  check('a slider appears, scaled to the eclipse rather than to the night',
    drewEclipse.scrubber, 'Eclipse');
  check('and it reports the moon, not the galactic core',
    /moon/i.test(drewEclipse.readout), true);
  check('greatest eclipse is marked along it', drewEclipse.marks.includes('greatest'), true);
  check('and nothing is crowded onto it beyond the contacts',
    drewEclipse.marks.length <= 3, true);
  check('only the moon is drawn, so the map is not the Milky Way panel again',
    drewEclipse.bodies, ['moon']);
  // The track always; the contact marks and the "now" spoke only for the part
  // of it the moon is actually above the horizon, which at a place that sees
  // half an eclipse can be none of them.
  check('as a path across the whole eclipse', drewEclipse.kinds.includes('track'), true);
  check('and nothing on it that is not part of that picture',
    drewEclipse.kinds.every((kind) => ['track', 'hour', 'now'].includes(kind)), true);

  await page.locator('.sky-tab', { hasText: /^Draw$/ }).first().click();
  await page.waitForTimeout(700);

  const swapped = await page.evaluate(() => {
    const features = window.__map.getSource('light-directions')?._d?.features || [];
    return [...new Set(features.map((feature) => feature.properties.body))].sort();
  });
  check('and opening Draw replaces the eclipse rather than stacking on it',
    swapped.includes('core'), true);

  await page.locator('.sky-tab', { hasText: /^Draw$/ }).first().click();
  await page.waitForTimeout(400);
  check('closing it takes the lines off again',
    await page.evaluate(() => (window.__map.getSource('light-directions')?._d?.features || []).length),
    0);
}

/*
 * Every sky tab draws its own subject.
 *
 * One drawing with everything on it is the aggregate, and on a phone over a
 * valley it is unreadable. Each tab now puts its own body on the map with a
 * slider scaled to that body's window — the sun's day, the moon's rise to set
 * — and switching one on has to switch the last one off.
 */
console.log('\nEach sky tab puts its own subject on the map');

const drawOne = async (tab, toggle) => {
  await page.locator('.sky-tab', { hasText: tab }).first().click();
  await page.waitForTimeout(300);
  if (!await page.locator(`[data-toggle="${toggle}"]`).count()) return null;
  await page.locator(`[data-toggle="${toggle}"]`).first().click();
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const panel = document.querySelector('.sky-panel');
    const features = window.__map.getSource('light-directions')?._d?.features || [];
    return {
      scrubber: panel.querySelector('.scrub-label')?.textContent.trim() || '',
      readout: panel.querySelector('.scrub-time')?.textContent.trim() || '',
      marks: [...panel.querySelectorAll('.scrub-mark-label')].map((node) => node.textContent.trim()),
      rows: [...panel.querySelectorAll('.sky-rows .core-row-label')].map((node) => node.textContent.trim()),
      bodies: [...new Set(features.map((feature) => feature.properties.body))].sort(),
      kinds: [...new Set(features.map((feature) => feature.properties.kind || 'bearing'))].sort(),
    };
  });
};

const sun = await drawOne(/Light/, 'sun-lines');
check('the Light tab draws the sun and only the sun', sun.bodies, ['sun']);
check('with its rise and set bearings and its path across the day',
  sun.kinds, ['bearing', 'hour', 'track']);
check('and a slider scaled to the day rather than the night', sun.scrubber, 'Today');
check('reporting the sun', /sun/i.test(sun.readout), true);
check('with noon marked along it', sun.marks.includes('noon'), true);
check('and the bearings listed under it', sun.rows.length > 0, true);

const moon = await drawOne(/Moon/, 'moon-lines');
check('the Moon tab replaces it with the moon', moon.bodies, ['moon']);
check('scaled to the stretch the moon is up', moon.scrubber, 'Moon up');
check('reporting the moon', /moon/i.test(moon.readout), true);

const core = await drawOne(/Milky Way/, 'core-lines');
check('the Milky Way tab draws the band alone', core.bodies, ['core']);
check('the band and its night track among them',
  core.kinds.includes('arc') && core.kinds.includes('track'), true);
check('scaled to the night', core.scrubber, 'Tonight');

/*
 * The two lines that carry no label of their own.
 *
 * "What is the light purple line?" is the question the drawing kept prompting,
 * because the band and the track are curves and a label repeated along a
 * sampled curve is a mess. So they are named beside the toggle instead.
 */
const key = await page.evaluate(() => [...document.querySelectorAll('.line-key-row')]
  .map((row) => ({
    swatch: row.querySelector('.line-key-swatch')?.className || '',
    name: row.querySelector('.line-key-name')?.textContent.trim() || '',
  })));
check('the violet lines are named in a key', key.length, 3);
check('the band, the hour ring, then the bearing to the core',
  key.map((row) => row.swatch.replace('line-key-swatch ', '')), ['is-band', 'is-track', 'is-spoke']);
check('and each is named in words', key.every((row) => row.name.length > 5), true);

/*
 * "Moon now" is only true while the slider sits on the present.
 *
 * Dragged to two in the morning it is the moon at two in the morning, and a
 * line labelled "now" is then saying something false about a bearing you are
 * standing under.
 */
await page.locator('.sky-tab', { hasText: /^Draw$/ }).first().click();
await page.waitForTimeout(700);

const scrubbedNames = await (async () => {
  const range = page.locator('.scrub-range').first();
  const { min, max } = await range.evaluate((node) => ({ min: node.min, max: node.max }));
  await range.evaluate((node, value) => {
    node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(Number(min) + (Number(max) - Number(min)) * 0.2));
  await new Promise((resolve) => setTimeout(resolve, 400));
  return page.evaluate(() => {
    const features = window.__map.getSource('light-directions')?._d?.features || [];
    return {
      map: features.filter((feature) => feature.properties.now).map((feature) => feature.properties.label),
      rows: [...document.querySelectorAll('.sky-rows .core-row-label')].map((node) => node.textContent.trim()),
    };
  });
})();
check('a line drawn for another moment is not labelled "now"',
  scrubbedNames.map.some((label) => /now/i.test(label)), false);
check('it is labelled with the moment it is drawn for',
  scrubbedNames.map.every((label) => /\d:\d\d/.test(label)), true);
check('and the rows under the slider say the same',
  scrubbedNames.rows.some((row) => /now/i.test(row)), false);

await page.locator('.sky-tab', { hasText: /^Draw$/ }).first().click();
await page.waitForTimeout(300);

/*
 * A trip is a folder with dates on it.
 *
 * "Temporary pins for a duration" cannot mean deleting them: a trip is over
 * exactly when you get home with photographs to match to the places, and an
 * app that had tidied the pins away by then would have destroyed the record.
 * So a finished trip comes off the map and stays in the folder.
 */
console.log('\nA trip is a folder with dates on it');
await showTab('folders');
await page.waitForTimeout(300);
await page.click('#new-trip');
await page.waitForTimeout(500);

const trip = await page.evaluate(() => {
  const bar = document.querySelector('.trip-bar');
  return {
    present: !!bar,
    standing: bar?.className || '',
    words: bar?.querySelector('.trip-standing')?.textContent.trim() || '',
    dates: [...(bar?.querySelectorAll('.trip-date') || [])].map((node) => node.value),
    actions: [...(bar?.querySelectorAll('.trip-actions button') || [])].length,
  };
});
check('a new trip carries a date strip', trip.present, true);
check('starting today and running a long weekend, not blank',
  trip.dates.length === 2 && trip.dates[0] < trip.dates[1], true);
check('and it is on now, because it starts today', /is-on/.test(trip.standing), true);
check('said in words rather than as arithmetic to do', /on now|last day/.test(trip.words), true);
check('with nothing to clean up yet', trip.actions, 0);

/*
 * What the queue actually costs.
 *
 * The complaint this answers, in the words it was reported in: "I put too much
 * in my queue and forget how far everything is between each other. And then I
 * don't add time in to eat, refuel, and sleep."
 */
/*
 * Built the way a queue really gets built: drop a pin, press once to send it.
 *
 * Through the card rather than through the store, because the one-press path
 * IS the feature — a folder picker can reach the same trip in three presses,
 * and three is enough to stop bothering, which is how a queue ends up half
 * built.
 */
/*
 * Clear the staged basemap features first.
 *
 * The identify section leaves a lake and a forest road staged in the map stub,
 * and the click handler reads `queryRenderedFeatures` to decide whether a
 * saved pin owns the click. Left there, every click below lands on somebody
 * else's fixture and no pin is ever dropped.
 */
await page.evaluate(() => { window.__rendered = []; });

/*
 * Tapping asks what is under the finger by default; the pin is the other mode.
 * Switched off only if it is on — an earlier section may have left it either
 * way, and a blind toggle would arm the wrong one and probe instead of pin.
 */
if (await page.locator('.map-tool').first().evaluate((node) => node.classList.contains('is-on'))) {
  await page.locator('.map-tool').first().click();
  await page.waitForTimeout(300);
}

const places = [
  ['Nashville', -86.78, 36.16],
  ['Asheville', -82.55, 35.60],
  ['Chattanooga', -85.31, 35.05],
  ['Knoxville', -83.92, 35.96],
];
for (const [name, lon, lat] of places) {
  await page.evaluate(({ lng, lat: latitude }) => window.__map.fire('click', {
    lngLat: { lng, lat: latitude }, point: { x: 300, y: 300 },
    originalEvent: { pointerType: 'mouse' },
  }), { lng: lon, lat });
  await page.waitForTimeout(400);
  await page.fill('.drop-pin-name', name);
  await page.locator('.popup-send-trip').first().click();
  await page.waitForTimeout(400);
}
check('a dropped pin offers one press into the trip being planned',
  places.length, 4);
await showTab('folders');
await page.waitForTimeout(500);
await page.evaluate(() => { document.querySelector('.trip-plan').open = true; });
await page.waitForTimeout(300);

const drive = await page.evaluate(() => {
  const plan = document.querySelector('.trip-plan');
  return {
    headline: plan.querySelector('.trip-plan-headline')?.textContent.trim() || '',
    verdict: plan.querySelector('.trip-verdict')?.textContent.trim() || '',
    verdictClass: plan.querySelector('.trip-verdict')?.className || '',
    days: [...plan.querySelectorAll('.trip-day')].map((day) => ({
      cost: day.querySelector('.trip-day-cost')?.textContent.trim(),
      route: day.querySelector('.trip-day-route')?.textContent.trim(),
      all: day.querySelector('.trip-day-total')?.textContent.trim(),
      night: day.querySelector('.trip-day-night')?.textContent.trim(),
    })),
    queue: [...plan.querySelectorAll('.trip-stop-name')].map((node) => node.textContent.trim()),
    gaps: [...plan.querySelectorAll('.trip-stop-gap')].map((node) => node.textContent.trim()),
  };
});

check('the queue reports miles and driving time', /\d+ mi · \d/.test(drive.headline), true);
check('and breaks into days rather than one undifferentiated blob',
  drive.days.length > 1, true);
check('each day says how far and how long it drives',
  drive.days.every((day) => /\d+ mi · /.test(day.cost)), true);
check('and which stops it covers', drive.days[0].route.includes('→'), true);
check('the whole day is reported, not just the wheel time',
  /out, all in/.test(drive.days[0].all) && /eating/.test(drive.days[0].all), true);
check('with somewhere to sleep at the end of it', /^Overnight near /.test(drive.days[0].night), true);
check('every stop is in the queue, in order', drive.queue,
  ['Nashville', 'Asheville', 'Chattanooga', 'Knoxville']);
check('each carrying the gap to the next one', drive.gaps.slice(0, 3).every((gap) => /\d+ mi/.test(gap)), true);
check('and the last one saying it is the last', drive.gaps.at(-1), 'last');

/*
 * The verdict against the dates, which is the whole point.
 *
 * The trip is a long weekend and this queue is not a long weekend. Saying so
 * is the difference between the feature and a table of numbers.
 */
check('the plan is judged against the days you booked',
  /Needs about|Fits/.test(drive.verdict), true);

/*
 * Queued in the order they were thought of, the drive crosses the state twice.
 * One press should unpick that without losing a stop.
 */
const before = await page.evaluate(() => document.querySelector('.trip-plan-headline').textContent.trim());
await page.locator('.trip-optimise').click();
await page.waitForTimeout(600);
await page.evaluate(() => { document.querySelector('.trip-plan').open = true; });
await page.waitForTimeout(300);
const after = await page.evaluate(() => ({
  headline: document.querySelector('.trip-plan-headline').textContent.trim(),
  queue: [...document.querySelectorAll('.trip-stop-name')].map((node) => node.textContent.trim()),
}));
check('reordering keeps every stop', after.queue.slice().sort(),
  ['Asheville', 'Chattanooga', 'Knoxville', 'Nashville']);
check('and does not move the one you start from', after.queue[0], 'Nashville');
check('and shortens the drive', Number(after.headline.match(/(\d+) mi/)[1])
  < Number(before.match(/(\d+) mi/)[1]), true);

/*
 * Moving one stop by hand, because the order is a judgement — light at one
 * place, a booking at another — and the optimiser knows about neither.
 */
const moved = await (async () => {
  const second = after.queue[1];
  await page.locator('.trip-stop').nth(1).locator('.trip-move').first().click();
  await page.waitForTimeout(500);
  await page.evaluate(() => { document.querySelector('.trip-plan').open = true; });
  await page.waitForTimeout(200);
  return { second, queue: await page.evaluate(() => [...document.querySelectorAll('.trip-stop-name')].map((n) => n.textContent.trim())) };
})();
check('a stop can be moved earlier by hand', moved.queue[0], moved.second);
check('and the first stop cannot be moved earlier than first',
  await page.locator('.trip-stop').first().locator('.trip-move').first().isDisabled(), true);

/*
 * The vehicle, and the advisory that has to come with one.
 *
 * Truck costing reads OpenStreetMap, and most low bridges in the United States
 * carry no maxheight tag — so the whole feature turns on the panel saying that
 * out loud rather than presenting a clean route as a checked one. Which is why
 * the caveat is checked here by its content and not by its presence: a notice
 * that had been softened into "data may be incomplete" would still be an
 * element with the right class on it.
 */
check('a car is the default, and says nothing about clearances',
  await page.locator('.rv-advisory').count(), 0);

await page.evaluate(() => {
  const knobs = [...document.querySelectorAll('.trip-knobs-summary')]
    .find((node) => /What you are driving/.test(node.textContent));
  knobs.parentElement.open = true;
});
await page.waitForTimeout(200);
await page.locator('.settings-choice', { hasText: 'RV or towing' }).click();
await page.waitForTimeout(500);
await page.evaluate(() => { document.querySelector('.trip-plan').open = true; });
await page.waitForTimeout(300);

const rv = await page.evaluate(() => ({
  advisory: document.querySelector('.rv-advisory')?.textContent || '',
  dims: [...document.querySelectorAll('.rv-dim')].map((node) => node.textContent.trim()),
  fields: [...document.querySelectorAll('.trip-knob')]
    .map((node) => node.querySelector('.trip-knob-label')?.textContent.trim()),
}));
check('choosing an RV puts the advisory on the trip',
  /advisory only/i.test(rv.advisory), true);
check('which names where the gap is', /OpenStreetMap/.test(rv.advisory), true);
check('and says a clear route is not a clear bridge',
  /not a promise of clearance/.test(rv.advisory), true);
check('and points at the sign rather than at itself',
  /the sign at the structure as the authority/.test(rv.advisory), true);
/*
 * Spelled back out so it can be checked against the door sticker, which is when
 * a wrong number gets caught — before the trip rather than under the bridge.
 */
check('the numbers the router was given are on the card',
  rv.dims.map((text) => text.split(' ')[0]), ['Height', 'Width', 'Length', 'Weight']);
check('in feet and inches, as the sticker has them',
  rv.dims.every((text) => /\d+' ?\d*"?|tons/.test(text)), true);
check('and the fields to correct them are there',
  ['Height', 'Width', 'Length', 'Weight'].every((label) => rv.fields.includes(label)), true);

/*
 * A height a decimal place out is a vehicle 34 metres tall, and the router
 * answers that with a confident refusal that reads like a road problem. The
 * field puts the old value back rather than storing something that would be
 * silently swapped for a default at routing time.
 */
/*
 * Still open, which is the point of the check as much as the height is.
 *
 * Changing the vehicle re-renders the folders tab, and a <details> rebuilt from
 * markup comes back shut — so choosing RV used to close the block holding the
 * four fields you chose RV in order to fill in.
 */
check('the block you are working in stays open across the change',
  await page.locator('.trip-knobs').filter({ hasText: 'What you are driving' })
    .evaluate((node) => node.open), true);

const heightField = page.locator('.trip-knob').filter({ hasText: 'Height' }).locator('input');
const wasHeight = await heightField.inputValue();
await heightField.fill('340');
await heightField.blur();
await page.waitForTimeout(400);
await page.evaluate(() => { document.querySelector('.trip-plan').open = true; });
await page.waitForTimeout(200);
check('an impossible height is refused rather than routed on',
  await page.locator('.trip-knob').filter({ hasText: 'Height' }).locator('input').inputValue(),
  wasHeight);

await shot(page.locator('.rv-advisory'), 'rv-advisory');

// Back to a car, because everything after this is about a car.
await page.locator('.settings-choice', { hasText: 'Car or truck' }).click();
await page.waitForTimeout(400);
await page.evaluate(() => { document.querySelector('.trip-plan').open = true; });
await page.waitForTimeout(200);
check('and switching back to a car takes the advisory away',
  await page.locator('.rv-advisory').count(), 0);

/*
 * Wound forward past its end, the same trip stands itself down — once.
 * A trip you deliberately switch back on must not be switched off again by
 * the next render, which is what the retired flag is for.
 */
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
// Wound back through the date fields rather than through the store, because
// the fields are how anyone actually moves a trip — and `readTrip` reorders a
// backwards window, so the start has to move first or the trip stays on.
const setDate = async (which, value) => {
  await page.locator('.trip-date').nth(which).fill(value);
  await page.locator('.trip-date').nth(which).dispatchEvent('change');
  await page.waitForTimeout(400);
};
await setDate(0, day(-9));
await setDate(1, day(-2));

/*
 * Waited for rather than slept through.
 *
 * Standing a trip down is three store writes and three re-renders of a panel
 * that by this point in the suite holds a couple of thousand rows, and a fixed
 * pause long enough for that is either flaky or slow. This reports the same
 * failure either way — the condition never arrives — without guessing at how
 * long the render takes on the machine it is running on.
 */
await page.waitForFunction(
  () => document.querySelector('.trip-bar')?.closest('.folder')
    ?.querySelector('.folder-eye')?.classList.contains('is-hidden') === true,
  null,
  { timeout: 10000 },
).catch(() => {});

const ended = await page.evaluate(() => {
  const bar = document.querySelector('.trip-bar');
  // The trip's own folder, not whichever one is first in the list — the suite
  // has several by this point and they are not in creation order.
  const eye = bar?.closest('.folder')?.querySelector('.folder-eye');
  return {
    standing: bar?.className || '',
    words: bar?.querySelector('.trip-standing')?.textContent.trim() || '',
    actions: [...(bar?.querySelectorAll('.trip-actions button') || [])].map((node) => node.textContent.trim()),
    hidden: eye?.classList.contains('is-hidden') ?? null,
  };
});

check('a finished trip says so', /ended/.test(ended.words), true);
check('and is marked as over', /is-over/.test(ended.standing), true);
check('its pins come off the map', ended.hidden, true);
check('and it offers what to do about them',
  ended.actions.some((label) => /clear/i.test(label))
    && ended.actions.some((label) => /keep/i.test(label)), true);

/*
 * Switched back on by hand, it stays on.
 *
 * Standing a finished trip down is a one-off, not a rule the render enforces
 * every pass — otherwise the eye on a finished trip would be a button that
 * does nothing, which is the worst kind.
 */
await page.locator('.folder:has(.trip-bar) .folder-eye').first().click();
await page.waitForTimeout(400);
await showTab('layers');
await page.waitForTimeout(200);
await showTab('folders');
await page.waitForTimeout(400);
check('switching it back on sticks, rather than being undone on the next render',
  await page.locator('.folder:has(.trip-bar) .folder-eye').first()
    .evaluate((node) => node.classList.contains('is-hidden')),
  false);

/*
 * Typing a place and going there.
 *
 * The map could answer "what is this" about somewhere you had already found,
 * and had no answer at all for "take me to Elkmont" short of pinching across
 * three states.
 */
console.log('\nSearching for a place');
await page.fill('#place-search', 'elkmont');
await page.waitForTimeout(900);

const searchList = await page.evaluate(() => [...document.querySelectorAll('.map-search-result')].map((row) => ({
  name: row.querySelector('.map-search-name')?.textContent.trim(),
  where: row.querySelector('.map-search-where')?.textContent.trim() || '',
  kind: row.querySelector('.map-search-kind')?.textContent.trim(),
})));
check('the box offers what it found', searchList.length, 2);
check('each result says what it is called', searchList[0].name, 'Elkmont Campground');
check('and where that is, so three Elkmonts are three choices', searchList[0].where, 'Gatlinburg, Tennessee');
check('and which kind of thing it is', searchList.map((row) => row.kind), ['Place', 'Town']);

/*
 * Your own places, before the geocoder's.
 *
 * A saved waypoint is the thing most often being looked for — you named it,
 * you know it is there — and it is in memory, so it can answer in the time it
 * takes to type rather than in a network round trip.
 */
await page.fill('#place-search', 'creamery');
await page.waitForTimeout(900);
const mine = await page.evaluate(() => [...document.querySelectorAll('.map-search-result')].map((row) => ({
  name: row.querySelector('.map-search-name')?.textContent.trim(),
  where: row.querySelector('.map-search-where')?.textContent.trim() || '',
  kind: row.querySelector('.map-search-kind')?.textContent.trim(),
  mine: row.classList.contains('is-mine'),
})));
// The suite imports the fixture more than once, so names carry a de-duplicating
// suffix by this point. Matching on the stem is the check; the suffix is the
// import machinery's business.
check('a saved waypoint is found by name', /^Creamery Falls/.test(mine[0]?.name || ''), true);
check('named as a waypoint rather than a place', mine[0]?.kind, 'Waypoint');
check('with the folder it is in', mine[0]?.where.length > 0, true);
check('and marked as yours, so it is not confused with a town of that name',
  mine[0]?.mine, true);
check('the geocoder\u2019s answers are still under it', mine.length > 1, true);

await page.locator('.map-search-result').first().click();
await page.waitForTimeout(600);
check('choosing it opens the waypoint rather than a card about the ground under it',
  (await page.locator('#tab-details').innerText()).includes('Creamery Falls'), true);

await page.fill('#place-search', 'elkmont');
await page.waitForTimeout(900);

await page.locator('.map-search-result').first().click();
await page.waitForTimeout(500);

const landed = await page.evaluate(() => ({
  card: document.querySelector('.identify-card .identify-designation')?.textContent.trim() || '',
  source: document.querySelector('.identify-card .identify-source')?.textContent.trim() || '',
  marked: window.__map.getSource('scratch-cursor')?._d?.geometry?.coordinates || null,
  list: document.getElementById('place-results')?.hidden,
}));
check('choosing one names it on the map rather than landing silently', landed.card, 'Elkmont Campground');
check('in the same card a tap on the map would open', landed.source, 'Place');
check('with the spot marked', landed.marked, [-83.58, 35.65]);
check('and the list put away', landed.list, true);

await page.evaluate(() => { document.querySelector('.identify-card .identify-close')?.click(); });
await page.fill('#place-search', '');
await page.waitForTimeout(200);

/*
 * Nothing may be wider than the screen, at any phone width.
 *
 * `.app` had no explicit grid column, so it got an implicit `auto` one that
 * sized to the max-content of its widest item — the header. On a 440pt phone
 * the header wanted 582px, the column became 582, and .app-body and
 * .map-surface went with it: the map was 142px wider than the screen and
 * everything at its right edge, the zoom controls and the map tools included,
 * was off it. 430 and below never showed it, which is why a 402pt simulator
 * did not, and why this is checked at several widths rather than one.
 */
console.log('\nNothing is wider than the screen it is on');
/*
 * Landscape is in the list because it fails differently.
 *
 * A phone on its side is 844 wide and 390 tall — wider than the breakpoint the
 * phone rules key off, so it gets the desktop layout in a window with 390
 * pixels of height, sixty of which were header. Nothing overflowed sideways;
 * everything was squeezed vertically instead.
 */
for (const { width, height } of [
  { width: 402, height: 900 }, { width: 430, height: 900 }, { width: 440, height: 900 },
  { width: 480, height: 900 }, { width: 768, height: 900 },
  { width: 844, height: 390 }, { width: 926, height: 428 },
]) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(250);
  const fits = await page.evaluate((w) => {
    const doc = document.documentElement;
    const over = [...document.querySelectorAll('body *')]
      .filter((node) => node.getBoundingClientRect().right > w + 1)
      // A popup deliberately hanging off the edge is the engine's business.
      .filter((node) => !node.closest('.mapboxgl-popup, .maplibregl-popup'))
      .map((node) => (typeof node.className === 'string' && node.className
        ? `.${node.className.split(' ')[0]}` : node.tagName));
    /*
     * The panel is allowed to be the whole screen on a phone in portrait —
     * it is an overlay with a close button — but only when it is open. With
     * it shut, the map is what the app is, at every size.
     */
    const surface = document.querySelector('.map-surface')?.getBoundingClientRect();
    return {
      scrolls: doc.scrollWidth > doc.clientWidth,
      over: [...new Set(over)].slice(0, 4),
      mapShare: surface ? (surface.width * surface.height) / (w * window.innerHeight) : 0,
    };
  }, width);
  check(`at ${width}\u00d7${height} the page does not scroll sideways`, fits.scrolls, false);
  check(`and nothing hangs off the right at ${width}\u00d7${height}`, fits.over, []);
  check(`and the map is still most of the screen at ${width}\u00d7${height}`,
    fits.mapShare > 0.5, true);
}
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(250);

/*
 * The name, on a screen too narrow for the header to carry it.
 *
 * Measured rather than assumed: at 402px the header's visible children already
 * come to 323px with 120px of gaps inside a 370px content box, and the title
 * wants 143 more. It cannot go up there without dropping the navigation, so
 * the panel carries it and opening the menu is where you see it.
 */
console.log('\nThe name is somewhere, at every width');
await page.setViewportSize({ width: 402, height: 874 });
await page.waitForTimeout(300);
check('the header drops the title on a phone', await page.locator('.brand-text').isVisible(), false);

// Open it only if it is not already. Below 820px the hamburger is hidden while
// the panel is up — clicking it unconditionally waits on a control that is
// deliberately not there, which is a timeout rather than a failure.
if (await page.locator('#panel-toggle').isVisible()) await page.locator('#panel-toggle').click();
await page.waitForTimeout(350);
check('and the menu carries it instead', await page.locator('.panel-brand').isVisible(), true);
check('spelled from the one source both copies read',
  (await page.locator('#panel-brand-name').innerText()).trim(),
  (await page.locator('#brand-name').innerText()).trim());

/*
 * Asked of the app, not of the pixels.
 *
 * A closing panel slides out over 180ms and only becomes `visibility: hidden`
 * at the end of it, so `isVisible()` is true through the whole slide and the
 * click lands on whatever is behind the button by the time it arrives. The
 * class is the app's own answer to "is the panel open", and it flips at once.
 */
if (await page.locator('.app.is-panel-open').count()) await page.locator('#panel-close').click();
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(300);
check('while a wide header keeps the title and the menu does not repeat it',
  [await page.locator('.brand-text').isVisible(), await page.locator('.panel-brand').isVisible()],
  [true, false]);

/*
 * Offline.
 *
 * A service worker that registers but does not actually answer a request is
 * indistinguishable from one that works, right up until somebody drives out of
 * signal. This is the only check that sees the difference, and it does it in a
 * clean context so nothing above is affected by a worker taking control.
 *
 * Also worth stating what is NOT expected to work offline: basemap tiles come
 * from Mapbox and the others, the worker passes cross-origin requests straight
 * through, and caching somebody else's tiles here would be both unbounded and
 * against their terms. The app shell comes back; the map is grey until an
 * offline pack is loaded.
 */
if (!external) {
/*
 * The archive is read through the worker without being mangled by it.
 *
 * This reads a real tile out of a real archive over HTTP, from inside a page
 * that has an activated service worker - which is the whole configuration the
 * bug lives in. The worker used to fall through to its cache-first catch-all
 * for anything it did not recognise, and for a file read by byte range that is
 * wrong twice: `cache.put` rejects a 206, and `cache.match` ignores Range, so
 * a cached slice comes back for a request about a different offset. The second
 * failure is the dangerous one - it returns bytes rather than an error, and
 * the reader decodes the header where it expected a tile.
 *
 * Reading two different tiles is what makes that visible. One tile passes even
 * when every range answer is the same sixteen kilobytes.
 */
{
  console.log('\nThe map archive is read by range, not through the cache');
  /*
   * Its own context, for two reasons. The main one blocks service workers on
   * purpose, and a worker in control is half of what is under test here. And
   * the third-party stubbing is load-bearing rather than tidiness: the map
   * library is fetched from a CDN, a failed load rejects inside the viewer's
   * init, and the worker is registered from the end of that init - so without
   * it this reports "no worker" and points at the wrong thing entirely.
   */
  const archiveContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await archiveContext.route('**/*', (route) => {
    const target = route.request().url();
    if (target.startsWith(new URL(URL_UNDER_TEST).origin)) return route.continue();
    if (route.request().resourceType() === 'image') {
      return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    }
    if (/\.css($|\?)/.test(target)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: GL });
  });
  const archivePage = await archiveContext.newPage();
  await archivePage.addInitScript(GL);
  await archivePage.goto(MAP_URL, { waitUntil: 'load' });
  for (let i = 0; i < 60; i += 1) {
    const state = await archivePage.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state || 'none');
    if (state === 'activated') break;
    await archivePage.waitForTimeout(100);
  }
  check('a worker is in control', await archivePage.evaluate(
    async () => (await navigator.serviceWorker.getRegistration())?.active?.state || 'none',
  ), 'activated');

  const read = await archivePage.evaluate(async () => {
    const { PMTilesArchive } = await import('./assets/js/lib/pmtiles.js');
    const archive = new PMTilesArchive('./tiles/byways.pmtiles');
    const decode = async (z, x, y) => {
      const bytes = await archive.tile(z, x, y);
      return bytes ? new TextDecoder().decode(bytes).trim() : null;
    };
    try {
      return {
        header: (await archive.header()).maxZoom,
        first: await decode(12, 1088, 1600),
        second: await decode(12, 1089, 1601),
        absent: await decode(12, 1200, 1600),
      };
    } catch (error) {
      return { error: error.message };
    }
  });
  check('the header reads', read.header, 12);
  check('a tile reads', read.first, 'tile 12/1088/1600');
  check('and a different tile is a different tile', read.second, 'tile 12/1089/1601');
  check('while ground the archive does not cover is absent', read.absent, null);
  if (read.error) console.log(`        ${read.error}`);

  /*
   * And from a host that ignores Range, which is the case that has a cost.
   *
   * Under one of those the whole archive comes back 200 to every request, and
   * a worker that caches what it serves writes the entire file into the app
   * cache - silently, and again on the next build. Reading works either way,
   * so the read is not the check: what is in the cache afterwards is.
   */
  const whole = await archivePage.evaluate(async () => {
    const { PMTilesArchive } = await import('./assets/js/lib/pmtiles.js');
    const archive = new PMTilesArchive('./tiles/byways-no-range.pmtiles');
    const bytes = await archive.tile(12, 1088, 1600);
    const stored = await Promise.all((await caches.keys()).map(async (name) => (
      await (await caches.open(name)).match('./tiles/byways-no-range.pmtiles') ? name : null
    )));
    return {
      tile: bytes ? new TextDecoder().decode(bytes).trim() : null,
      cachedIn: stored.filter(Boolean),
    };
  });
  check('a host that ignores Range still yields the tile', whole.tile, 'tile 12/1088/1600');
  check('and the archive was not written into the app cache', whole.cachedIn.length, 0);
  if (whole.cachedIn.length) console.log(`        found in ${whole.cachedIn.join(', ')}`);
  await archiveContext.close();
}

  console.log('\nThe app comes back with no network');
  const offlineContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  /*
   * The same third-party stubbing the main context gets, and it is load-bearing
   * rather than tidiness. `engine.js` appends the Mapbox GL script tag whether
   * or not a `mapboxgl` global is already there, and a failed load rejects
   * inside the viewer's init — so aborting that one request stops the app
   * before it ever reaches the line that registers the worker. Which is what
   * this check then reports as "no worker installed", pointing at the wrong
   * thing entirely.
   */
  await offlineContext.route('**/*', (route) => {
    const target = route.request().url();
    if (target.startsWith(new URL(URL_UNDER_TEST).origin)) return route.continue();
    if (route.request().resourceType() === 'image') {
      return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    }
    if (/\.css($|\?)/.test(target)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: GL });
  });
  const offlinePage = await offlineContext.newPage();
  await offlinePage.addInitScript(GL);
  await offlinePage.goto(MAP_URL, { waitUntil: 'load' });

  /*
   * Polled to a deadline rather than sampled once, for two reasons that both
   * bit: `serviceWorker.ready` never settles at all when nothing registers, so
   * an unraced await would hang the suite instead of failing it — and `ready`
   * resolves as soon as a registration HAS an active worker, which can be while
   * that worker is still 'activating', because the activate handler sweeps old
   * caches before it claims. Asserting 'activated' on the first tick reported a
   * working worker as broken.
   */
  const state = await offlinePage.evaluate(async () => {
    const deadline = Date.now() + 20000;
    let last = 'never registered';
    while (Date.now() < deadline) {
      const registration = await navigator.serviceWorker.getRegistration();
      last = registration?.active?.state || registration?.installing?.state || last;
      if (last === 'activated') return last;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return last;
  });
  check('a worker installs and activates', state, 'activated');

  /*
   * Wait for the precache to finish, and for ALL of it.
   *
   * The first version of this settled for "more than 100 of the 127", which
   * meant it could go offline mid-install and blame the app for the missing
   * files. Read the count out of the worker itself so the test cannot drift
   * from what is actually being cached.
   */
  const expected = (await readFile(path.join(ROOT, 'dist', 'sw.js'), 'utf8'))
    .match(/const PRECACHE = \[([\s\S]*?)\];/)[1]
    .split(',').filter((entry) => entry.trim()).length;

  const cached = await offlinePage.evaluate(async (want) => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const name = (await caches.keys()).find((key) => key.startsWith('abmap-'));
      if (name) {
        const keys = await (await caches.open(name)).keys();
        if (keys.length >= want) return keys.length;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return -1;
  }, expected);
  check(`and precaches all ${expected} files`, cached, expected);

  /*
   * And that it cached them under the URLs the app will really ask for.
   *
   * Only the few files a page names directly carry a `?v=`; the ES modules
   * viewer.js imports, the shield images and the catalogue are all fetched by
   * their plain path. Precaching those versioned made every one a miss with no
   * network — the module graph never loaded, the app never started, and the
   * failure looked like a broken service worker rather than a wrong list.
   */
  const addressable = await offlinePage.evaluate(async () => {
    const name = (await caches.keys()).find((key) => key.startsWith('abmap-'));
    const keys = (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname
      + new URL(request.url).search);
    const has = (suffix) => keys.some((key) => key.endsWith(suffix));
    return {
      module: has('/assets/js/lib/engine.js'),
      catalogue: has('/data/catalog.json'),
      shield: keys.some((key) => /\/assets\/shields\/[^?]+\.png$/.test(key)),
      entryIsVersioned: keys.some((key) => /\/assets\/js\/viewer\.js\?v=/.test(key)),
    };
  });
  check('the imported modules are cached by their plain path', addressable.module, true);
  check('so is the catalogue', addressable.catalogue, true);
  check('and the shield images', addressable.shield, true);
  check('while the entry script keeps the ?v= the page asks for', addressable.entryIsVersioned, true);

  /*
   * Offline twice over: Playwright's emulation, and the real server shut down
   * underneath it.
   *
   * The emulation alone is not enough. It did not cover requests made by the
   * service worker in the local Playwright build, so a cache miss quietly
   * succeeded against the live server and this whole section passed while the
   * precache list was wrong — CI, on a different build, failed it correctly.
   * Closing the server (and its keep-alive sockets) makes a miss a miss
   * everywhere. Safe to do here because nothing runs after this.
   */
  await offlineContext.setOffline(true);
  hosted.server.closeAllConnections?.();
  await new Promise((resolve) => hosted.server.close(resolve));

  try {
    await offlinePage.reload({ waitUntil: 'load' });
    check('the map page loads with the network down',
      await offlinePage.locator('#map').count(), 1);

    // The inspector is exposed at the end of the viewer's init, so it is the
    // one global that means the whole startup path ran — not merely that the
    // HTML came back. Waited for, because init is asynchronous and reading it
    // on the load event reads it before it exists.
    const ran = await offlinePage.waitForFunction(
      () => typeof globalThis.abmapOverlays === 'function', null, { timeout: 20000 },
    ).then(() => true).catch(() => false);
    /*
     * This check is the offline downloader's regression test.
     *
     * Its first version had the worker intercept every cross-origin request to
     * look for a cached tile, which meant respondWith took over the style
     * fetch, the token check and the worker script too - and the app never
     * finished initialising with the network down. This is what failed, and
     * reverting the worker is what made it pass again; only tile-shaped URLs
     * may be intercepted now.
     */
    check('its scripts came back too, so the app actually ran', ran, true);
    check('and the layer panel built itself from the cached catalogue',
      await offlinePage.locator('.layer-row').count() > 0, true);

    /*
     * The homepage and the help page have to survive offline for the same
     * reason the map does: a precache is only worth having if it covers the
     * pages somebody reaches for.
     *
     * #roadmap rather than #catalog-grid, which is what this used to look for.
     * The catalogue is commented out of index.html now, so that locator would
     * count 0 whether the page came out of the cache or never arrived at all -
     * a check that cannot fail for the right reason and cannot pass for it
     * either. #roadmap is markup the page always ships.
     */
    await offlinePage.goto(new URL('./', URL_UNDER_TEST).href, { waitUntil: 'load' });
    check('and so does the homepage, which was never visited online',
      await offlinePage.locator('#roadmap').count(), 1);

    /*
     * Deliberately after the homepage, because the order is the test.
     *
     * Visiting the homepage used to tear the worker down: it registers one,
     * and registerServiceWorker unregisters when ABMAP_BUILD is missing -
     * which it was, because only the map page loaded build.js. Every cache
     * went with it and the next navigation died. Reordering these two made it
     * pass and would have shipped a homepage that switched off offline mode
     * for the whole site.
     */
    await offlinePage.goto(new URL('faq.html', URL_UNDER_TEST).href, { waitUntil: 'load' });
    check('and the help page, still reachable after the homepage has loaded',
      await offlinePage.locator('.faq-section').count() > 0, true);
    check('and the caches the homepage could have torn down are still there',
      await offlinePage.evaluate(async () => (await caches.keys()).some((n) => /^abmap-\d|^abmap-[a-f0-9]/.test(n))), true);
  } catch (error) {
    // A navigation that cannot be served offline throws rather than returning
    // a page, and an uncaught throw here would take every check after it with
    // it — including the report of what actually failed.
    check(`offline navigation (${error.message.split('\n')[0]})`, false, true);
  }

  await offlineContext.setOffline(false);
  await offlineContext.close();
}

await browser.close();
// Already closed by the offline section when it ran; close() twice is an error.
if (hosted?.server.listening) hosted.server.close();

if (consoleErrors.length) {
  console.error('\nConsole errors:');
  for (const error of consoleErrors) console.error(`  ${error}`);
  failures.push('console was not clean');
}

console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAll checks passed.');
process.exit(failures.length ? 1 : 0);
