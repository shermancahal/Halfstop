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
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

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

/**
 * Build dist and serve it under /Map/, the subpath GitHub Pages uses, so the
 * relative asset paths resolve the same way they do in production.
 */
async function serveFreshBuild() {
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-dist.mjs')], { stdio: 'ignore' });
  const dist = path.join(ROOT, 'dist');

  const server = createServer(async (request, response) => {
    let name = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    name = name.startsWith('/Map/') ? name.slice(5) : name.replace(/^\//, '');
    if (name === '' || name.endsWith('/')) name += 'index.html';
    const file = path.join(dist, name);
    if (!file.startsWith(dist)) return response.writeHead(403).end();
    try {
      const body = await readFile(file);
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
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

const GL = `class E{constructor(){this._h={}}on(e,a,b){const f=b||a;
if(typeof a==='string'){(this._h[e+':'+a]||=[]).push(f)}else{(this._h[e]||=[]).push(f)}return this}
once(e,f){const g=(a)=>{this.off(e,g);f(a)};return this.on(e,g)}
off(e,f){const k=this._h[e];if(k){const i=k.indexOf(f);if(i>=0)k.splice(i,1)}return this}
fire(e,a){[...(this._h[e]||[])].forEach(f=>f(a))}}
class Bounds{constructor(w,s,e,n){this.w=w;this.s=s;this.e=e;this.n=n}
getWest(){return this.w}getSouth(){return this.s}getEast(){return this.e}getNorth(){return this.n}
extend(){return this}isEmpty(){return false}}
class Src{constructor(d){this._d=d}setData(d){this._d=d}}
class Popup{setLngLat(){return this}setDOMContent(n){document.body.appendChild(n);return this}addTo(){return this}remove(){return this}}
class M extends E{constructor(o){super();this._s=new Map();this._l=new Map();this._img=new Map();
this._ready=false;window.__map=this;this._apply(o.style);
setTimeout(()=>{this.fire('style.load');           // sources NOT loaded yet
  setTimeout(()=>{this._ready=true;this.fire('styledata');this.fire('idle');this.fire('load')},30)},0)}
_apply(s){this._l.clear();this._s.clear();this._img.clear();if(s&&s.layers)for(const l of s.layers)this._l.set(l.id,l)}
loaded(){return this._ready}isStyleLoaded(){return this._ready}
addControl(){return this}getCanvas(){return{style:{}}}getContainer(){return document.getElementById('map')}
addImage(i,d){this._img.set(i,d)}hasImage(i){return this._img.has(i)}imageIds(){return [...this._img.keys()]}
addSource(i,c){this._s.set(i,new Src(c.data))}getSource(i){return this._s.get(i)}removeSource(i){this._s.delete(i)}
addLayer(l,b){if(b&&!this._l.has(b))throw new Error('before missing '+b);this._l.set(l.id,l)}
getLayer(i){return this._l.get(i)}removeLayer(i){this._l.delete(i)}layerIds(){return [...this._l.keys()]}
moveLayer(){}setPaintProperty(){}setLayoutProperty(){}
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
project(){return{x:0,y:0}}unproject(){return{lng:0,lat:0}}queryRenderedFeatures(){return[]}resize(){}remove(){}}
window.maplibregl={Map:M,NavigationControl:class{},ScaleControl:class{},GeolocateControl:class{},
FullscreenControl:class{},Popup,LngLatBounds:Bounds,
Marker:class{setLngLat(){return this}addTo(){return this}remove(){return this}}};
window.mapboxgl=window.maplibregl;`;

const failures = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures.push(label);
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

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

await page.route('**/*', async (route) => {
  const url = route.request().url();
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
      body: JSON.stringify({ properties: { skyCover: { values: SKY_COVER } } }),
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
  if (url.startsWith(new URL(URL_UNDER_TEST).origin)) return route.continue();
  if (/\.css($|\?)/.test(url)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
  if (/api\.mapbox\.com\/geocoding/.test(url)) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ features: [{ place_type: ['region'], text: 'Tennessee', properties: { short_code: 'US-TN' } }] }),
    });
  }
  return route.fulfill({ status: 200, contentType: 'application/javascript', body: GL });
});

await page.goto(URL_UNDER_TEST, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const state = () => page.evaluate(() => {
  const map = window.__map;
  const ids = map.layerIds();
  return {
    folderFeatures: map.getSource('folders')?._d?.features?.length ?? null,
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
check('waypoints reached the map', afterImport.folderFeatures, 2);
check('folder layers present', afterImport.folderLayers, 5);
check('document layers present', afterImport.documentLayers > 0, true);

console.log('\nSwitch to a raster basemap and back');
await page.click('.panel-tab[data-tab="layers"]');
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
await page.click('.panel-tab[data-tab="waypoints"]');
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
await page.click('.panel-tab[data-tab="waypoints"]');
await page.waitForTimeout(300);
await page.locator('.waypoint-card').first().click();
await page.waitForTimeout(900);
check('the open panel survives a reload', await page.locator('.moon-card').count(), 1);

console.log('\nA warned storm reports its heading and draws it');
const stormText = await page.locator('.detail-block').filter({ hasText: 'Storm warnings' }).first().innerText();
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
console.log('\nA queried overlay loads features for the view');
await page.click('.panel-tab[data-tab="layers"]');
await page.waitForTimeout(300);
await page.locator('summary', { hasText: /Conditions/ }).first().click();
await page.waitForTimeout(200);
await page.locator('.layer-row', { hasText: /Wildfire perimeters/ }).locator('input[type=checkbox]').check();
await page.waitForTimeout(900);

const fire = await page.evaluate(() => {
  const map = window.__map;
  const ids = map.layerIds();
  return {
    fill: ids.includes('overlay-wildfire'),
    line: ids.includes('overlay-wildfire--1'),
    features: map.getSource('overlay-wildfire')?._d?.features?.length ?? null,
  };
});
check('the fill layer is added', fire.fill, true);
check('and the outline with it', fire.line, true);
check('and the perimeters reach the source', fire.features, 1);

// A raster basemap bakes its overlays into the style document, and a queried
// overlay cannot be baked into anything. It has to be added on that path too,
// or switching to USGS Topo quietly drops it.
await page.locator('.layer-row', { hasText: /^USGS Topo$/ }).locator('input[type=radio]').check();
await page.waitForTimeout(1100);
const fireOnRaster = await page.evaluate(() => ({
  fill: window.__map.layerIds().includes('overlay-wildfire'),
  features: window.__map.getSource('overlay-wildfire')?._d?.features?.length ?? null,
}));
check('it survives a switch to a raster basemap', fireOnRaster.fill, true);
check('with its features', fireOnRaster.features, 1);
await page.locator('.layer-row', { hasText: /^Byways Topo/ }).locator('input[type=radio]').check();
await page.waitForTimeout(1100);

await page.locator('.layer-row', { hasText: /Wildfire perimeters/ }).locator('input[type=checkbox]').uncheck();
await page.waitForTimeout(500);
const afterOff = await page.evaluate(() => window.__map.layerIds().filter((id) => id.startsWith('overlay-wildfire')));
check('switching it off takes both layers with it', afterOff, []);

console.log('\nThe Location section leads with decimal and hides the rest');
await page.click('.panel-tab[data-tab="waypoints"]');
await page.waitForTimeout(300);
await page.locator('.waypoint-card').first().click();
await page.waitForTimeout(900);

const locationSection = () => page.locator('.panel-section').filter({ hasText: 'Location' }).first();
check('decimal degrees are on screen without opening anything',
  await locationSection().locator('.detail-line-label', { hasText: /^Decimal$/ }).count(), 1);
check('the other formats start hidden',
  await page.locator('.coord-more').first().evaluate((node) => node.open), false);
await page.locator('.coord-more-summary').first().click();
await page.waitForTimeout(200);
check('opening it reveals UTM',
  await page.locator('.coord-more[open] .detail-line-label', { hasText: /^UTM$/ }).count(), 1);

// Land manager is the slowest lookup and the least often read, so it sits
// below everything that answers faster.
const sectionOrder = await page.evaluate(() => [...document.querySelectorAll('#details-body h2.panel-title, #details-body .detail-block-summary')]
  .map((node) => node.textContent.trim()));
check('land manager comes last',
  sectionOrder.filter((title) => /Land manager/.test(title)).length
    && sectionOrder.findIndex((title) => /Land manager/.test(title)) === sectionOrder.length - 1,
  true);

console.log('\nCollapsed Details sections survive a reload');
const sunMoon = () => page.locator('.detail-block').filter({ hasText: 'Photography' }).first();
await page.locator('.detail-block-summary', { hasText: /Photography/i }).click();
await page.waitForTimeout(300);
check('collapsing closes the section', await sunMoon().evaluate((node) => node.open), false);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.click('.panel-tab[data-tab="waypoints"]');
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

await page.click('.panel-tab[data-tab="waypoints"]');
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

await page.click('.panel-tab[data-tab="folders"]');
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
await page.click('.panel-tab[data-tab="waypoints"]');
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
  return { interstate: read('interstate'), us: read('us') };
});

const us = profiles.us;
check('the US shield rises to a peak left of centre', us.leftCrest < us.centre - 2, true);
check('and to another on the right', us.rightCrest < us.centre - 2, true);

const inter = profiles.interstate;
check('the interstate top is flat instead',
  Math.abs(inter.centre - Math.min(inter.leftCrest, inter.rightCrest)) <= 1, true);

// Both narrow toward the foot rather than bottoming out square.
for (const [name, shape] of Object.entries(profiles)) {
  check(`the ${name} tapers`, shape.footWidth > 0.15 && shape.footWidth < 0.75, true);
}

/*
 * State shields come from the real sign blanks, which are PNGs — so they load
 * asynchronously, through the same styleimagemissing hook that covers the
 * drawn ones. The whole feature is silent when it fails: a shield that never
 * arrives is a road with no marker on it.
 */
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

await browser.close();
hosted?.server.close();

if (consoleErrors.length) {
  console.error('\nConsole errors:');
  for (const error of consoleErrors) console.error(`  ${error}`);
  failures.push('console was not clean');
}

console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAll checks passed.');
process.exit(failures.length ? 1 : 0);
