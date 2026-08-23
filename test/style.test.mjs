/**
 * Tests for the generated map style.
 *
 * These exist because of a real failure: buildRasterStyle emitted
 * `glyphs: undefined`, which MapLibre tolerated but Mapbox GL rejected as a
 * style-spec violation. Mapbox GL aborts style loading on any validation error,
 * so the map stayed blank and every later addSource threw "Style is not done
 * loading" — with nothing obvious in the console.
 *
 * The checks below are deliberately dependency-free rather than pulling in the
 * official validator, so `npm test` still runs with nothing installed. They
 * assert the invariants that actually broke: no undefined values anywhere, and
 * a structurally valid version-8 style.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRasterStyle } from '../assets/js/lib/engine.js';
import { BASEMAPS, OVERLAYS, DEFAULT_BASEMAP, DEFAULT_BASEMAP_WITH_TOKEN } from '../assets/js/config.js';

const rasterBasemaps = BASEMAPS.filter((b) => b.tiles);
const overlays = () => OVERLAYS.map((o) => ({ ...o }));

/** Walk every value in a style, reporting the path of anything not serialisable. */
function findBadValues(node, path = 'style', found = []) {
  if (node === undefined) { found.push(`${path} is undefined`); return found; }
  if (node === null || typeof node !== 'object') {
    if (typeof node === 'number' && !Number.isFinite(node)) found.push(`${path} is ${node}`);
    return found;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => findBadValues(item, `${path}[${i}]`, found));
    return found;
  }
  for (const [key, value] of Object.entries(node)) findBadValues(value, `${path}.${key}`, found);
  return found;
}

test('style: no key ever holds undefined', () => {
  // The exact regression: `glyphs: undefined` was a present key with no value,
  // which fails spec validation even though it reads as "absent" in JavaScript.
  for (const basemap of rasterBasemaps) {
    const style = buildRasterStyle(basemap, overlays());
    assert.deepEqual(findBadValues(style), [], `${basemap.id} produced unserialisable values`);
  }
});

test('style: optional keys are absent rather than undefined', () => {
  const style = buildRasterStyle(rasterBasemaps[0], []);
  for (const key of ['glyphs', 'sprite', 'terrain', 'fog']) {
    assert.equal(key in style, false, `"${key}" must be omitted entirely, not set to undefined`);
  }
});

test('style: survives a JSON round-trip unchanged', () => {
  // If a round-trip loses anything, some key held undefined.
  for (const basemap of rasterBasemaps) {
    const style = buildRasterStyle(basemap, overlays());
    assert.deepEqual(JSON.parse(JSON.stringify(style)), style, `${basemap.id} does not round-trip`);
  }
});

test('style: is a well-formed version 8 document', () => {
  const style = buildRasterStyle(rasterBasemaps[0], overlays());
  assert.equal(style.version, 8);
  assert.equal(typeof style.sources, 'object');
  assert.ok(Array.isArray(style.layers));
});

test('style: every layer points at a source that exists', () => {
  for (const basemap of rasterBasemaps) {
    const style = buildRasterStyle(basemap, overlays());
    for (const layer of style.layers) {
      assert.ok(style.sources[layer.source], `${basemap.id}: layer "${layer.id}" references missing source "${layer.source}"`);
    }
  }
});

test('style: raster sources carry the fields the spec requires', () => {
  const style = buildRasterStyle(rasterBasemaps[0], overlays());
  for (const [id, source] of Object.entries(style.sources)) {
    assert.equal(source.type, 'raster', `${id} should be a raster source`);
    assert.ok(Array.isArray(source.tiles) && source.tiles.length, `${id} needs a non-empty tiles array`);
    assert.equal(typeof source.tileSize, 'number', `${id} needs a numeric tileSize`);
    assert.ok(source.tiles.every((url) => /^https:\/\//.test(url)), `${id} must use https tile URLs`);
    // Two valid forms: XYZ tile indices, or a WMS/ArcGIS-export bounding box.
    // Both are substituted by the GL libraries; a URL with neither is static.
    assert.ok(source.tiles.every((url) => {
      const xyz = url.includes('{z}') && url.includes('{x}') && url.includes('{y}');
      const bbox = url.includes('{bbox-epsg-3857}');
      return xyz || bbox;
    }), `${id} tile URLs need either {z}/{x}/{y} or {bbox-epsg-3857}`);
  }
});

test('style: bbox sources declare a square tile size', () => {
  // A bbox request hard-codes its output size in the URL; if that disagrees
  // with tileSize the tiles arrive stretched. The two dialects spell it
  // differently — ArcGIS export uses size=W,H and WMS uses width=&height= —
  // so accept either, but require one.
  const style = buildRasterStyle(rasterBasemaps[0], overlays());
  for (const [id, source] of Object.entries(style.sources)) {
    const bboxUrl = source.tiles.find((url) => url.includes('{bbox-epsg-3857}'));
    if (!bboxUrl) continue;

    const arcgis = /[?&]size=(\d+),(\d+)/.exec(bboxUrl);
    const wms = [/[?&]width=(\d+)/.exec(bboxUrl), /[?&]height=(\d+)/.exec(bboxUrl)];
    const size = arcgis ? [Number(arcgis[1]), Number(arcgis[2])]
      : wms[0] && wms[1] ? [Number(wms[0][1]), Number(wms[1][1])]
        : null;

    assert.ok(size, `${id} bbox URL must declare an output size (size=W,H or width=&height=)`);
    assert.equal(size[0], source.tileSize, `${id} width should match tileSize`);
    assert.equal(size[1], source.tileSize, `${id} height should match tileSize`);
  }
});

test('style: layer ids are unique', () => {
  const style = buildRasterStyle(rasterBasemaps[0], overlays());
  const ids = style.layers.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate layer ids');
});

test('style: overlays are drawn above the basemap, in configuration order', () => {
  const style = buildRasterStyle(rasterBasemaps[0], overlays());
  assert.equal(style.layers[0].id, 'basemap');
  assert.deepEqual(style.layers.slice(1).map((l) => l.id), OVERLAYS.map((o) => `overlay-${o.id}`));
});

test('style: opacity is carried through to raster paint', () => {
  const custom = [{ ...OVERLAYS[0], opacity: 0.42 }];
  const style = buildRasterStyle(rasterBasemaps[0], custom);
  assert.equal(style.layers[1].paint['raster-opacity'], 0.42);
});

test('style: a basemap with no overlays still yields one layer', () => {
  const style = buildRasterStyle(rasterBasemaps[0], []);
  assert.equal(style.layers.length, 1);
});

/* ------------------------------------------------------------------ config */

test('config: both default basemaps name real entries', () => {
  assert.ok(BASEMAPS.some((b) => b.id === DEFAULT_BASEMAP), `DEFAULT_BASEMAP "${DEFAULT_BASEMAP}" is not in BASEMAPS`);
  assert.ok(BASEMAPS.some((b) => b.id === DEFAULT_BASEMAP_WITH_TOKEN),
    `DEFAULT_BASEMAP_WITH_TOKEN "${DEFAULT_BASEMAP_WITH_TOKEN}" is not in BASEMAPS`);
});

test('config: the no-token default does not require a token', () => {
  const fallback = BASEMAPS.find((b) => b.id === DEFAULT_BASEMAP);
  assert.equal(Boolean(fallback.requiresToken), false, 'the default basemap must work without a Mapbox account');
  assert.ok(fallback.tiles, 'the default basemap must be a raster source');
});

test('config: every basemap is either raster tiles or a token-gated style', () => {
  for (const basemap of BASEMAPS) {
    if (basemap.style) {
      assert.equal(basemap.requiresToken, true, `"${basemap.id}" has a style URL so it must be marked requiresToken`);
    } else {
      assert.ok(Array.isArray(basemap.tiles) && basemap.tiles.length, `"${basemap.id}" has neither tiles nor a style`);
    }
  }
});

test('config: basemaps and overlays have unique ids and attribution', () => {
  const ids = [...BASEMAPS, ...OVERLAYS].map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate basemap/overlay id');
  for (const entry of [...BASEMAPS, ...OVERLAYS]) {
    assert.ok(entry.attribution, `"${entry.id}" is missing attribution, which the providers require`);
  }
});
