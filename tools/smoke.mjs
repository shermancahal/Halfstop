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
 * Requires the site served at http://127.0.0.1:8799/Map/ (see the README).
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const URL_UNDER_TEST = process.env.SMOKE_URL || 'http://127.0.0.1:8799/Map/';
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'smoke.gpx');

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
setStyle(s){this._ready=false;this._apply(s);
  setTimeout(()=>{this.fire('style.load');setTimeout(()=>{this._ready=true;this.fire('styledata');this.fire('idle')},30)},0)}
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

await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('http://127.0.0.1')) return route.continue();
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

console.log('\nThe build stamp is readable');
const stamp = (await page.locator('#build-stamp').innerText().catch(() => '')).trim();
check('build stamp is shown', stamp.length > 0, true);

await browser.close();

if (consoleErrors.length) {
  console.error('\nConsole errors:');
  for (const error of consoleErrors) console.error(`  ${error}`);
  failures.push('console was not clean');
}

console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAll checks passed.');
process.exit(failures.length ? 1 : 0);
