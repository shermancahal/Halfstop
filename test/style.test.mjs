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

import { buildRasterStyle, overlayParts, overlayIdFromLayer, styleFor } from '../assets/js/lib/engine.js';
import { BASEMAPS, OVERLAYS, DEFAULT_BASEMAP, DEFAULT_BASEMAP_WITH_TOKEN } from '../assets/js/config.js';
import { bywaysStyle, PALETTE, shieldLayerUpdates } from '../assets/js/lib/byways-style.js';
import { previewFor, tileFor, tileURL, swatchSVG } from '../assets/js/lib/preview.js';
import {
  shieldTextOffset, shieldTextSize, shieldDisplayWidth, shieldBlankFor,
  SHIELD_SCALE, BLANK_PIXEL_RATIO, MIN_TEXT,
} from '../assets/js/lib/route-shields.js';
import { SHIELD_BOXES } from '../assets/js/lib/shield-boxes.js';
import { formatTemperature, convertTemperature } from '../assets/js/lib/geo.js';
import {
  shieldDesign,
  shieldImageId,
  shieldImageIds,
  shieldImageExpression,
  rasterizeShield,
  SHIELD_DESIGNS,
  SHIELD_TEXT_COLOUR,
  SHAPE_NAMES,
  STATE_SHIELDS,
  stateDesign,
  statesWithShields,
  shieldTextColour,
  shieldImageIdFor,
  shieldDesignsFor,
} from '../assets/js/lib/route-shields.js';

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
  assert.deepEqual(
    style.layers.slice(1).map((l) => l.id),
    // A queried overlay is deliberately not here: its data depends on where the
    // map is looking, so it cannot be baked into a style document and is added
    // at runtime on both engines instead.
    OVERLAYS.filter((o) => !o.query).flatMap((o) => overlayParts(o).map((part) => part.layerId)),
  );
});

test('style: a queried overlay is two layers over one source, and no tiles', () => {
  const queried = {
    id: 'test-queried',
    name: 'Queried',
    opacity: 0.6,
    attribution: 'test',
    query: { url: 'https://example.org/query?geometry={bbox}&f=geojson', minzoom: 6 },
  };

  const parts = overlayParts(queried);
  assert.equal(parts.length, 2, 'a fill and the outline that makes it findable');
  assert.equal(parts[0].layerId, 'overlay-test-queried');
  assert.equal(parts[1].layerId, 'overlay-test-queried--1');
  assert.ok(parts.every((part) => !part.tiles), 'there are no tiles to fetch');

  // Tearing the overlay down by its id has to find both halves, or the outline
  // is left behind on the map with nothing under it.
  assert.ok(parts.every((part) => overlayIdFromLayer(part.layerId) === queried.id));

  // And it must not reach the style document, where a source with no tiles
  // would be a spec violation and Mapbox GL would abort the whole style.
  const style = buildRasterStyle(rasterBasemaps[0], [queried]);
  assert.equal(style.layers.length, 1, 'only the basemap');
  assert.deepEqual(Object.keys(style.sources), ['basemap']);
});

test('config: a state-scoped overlay names real states', () => {
  /*
   * Some of the best data is one state's own and stops at its line — Kentucky
   * publishes five-foot lidar hillshade for the whole commonwealth, which no
   * national service comes near. Fifty states of those in one flat list would
   * be unusable, so an overlay names the states it covers and the panel only
   * offers it inside them.
   *
   * Vacuous until the first one lands, and that is the point: it is the guard
   * that catches a lowercase code or a full state name the day one is written.
   */
  for (const overlay of OVERLAYS.filter((entry) => entry.states)) {
    assert.ok(Array.isArray(overlay.states) && overlay.states.length,
      `${overlay.id} declares an empty states list`);
    for (const code of overlay.states) {
      assert.match(code, /^[A-Z]{2}$/,
        `${overlay.id}: "${code}" is not a two-letter state code`);
    }
    // The panel groups these under the state's name rather than the subject
    // heading, so a group of their own would never be shown.
    assert.ok(!overlay.group || overlay.states,
      `${overlay.id} cannot be both state-scoped and in a subject group`);
  }
});

test('config: a queried overlay carries a bbox placeholder and a floor', () => {
  for (const overlay of OVERLAYS.filter((o) => o.query)) {
    assert.ok(overlay.query.url.includes('{bbox}'),
      `${overlay.id} has nowhere to put the view`);
    assert.match(overlay.query.url, /f=geojson/, `${overlay.id} does not ask for GeoJSON`);
    assert.ok(overlay.query.minzoom >= 1,
      `${overlay.id} would query the whole country at once`);
    assert.ok(!overlay.tiles, `${overlay.id} cannot be both queried and tiled`);
  }
});

test('style: a combined overlay contributes one layer per source', () => {
  // Tested against a constructed overlay rather than whichever config entry
  // happens to use several sources today — the machinery is what has to keep
  // working, and config churns. (The recreation overlay used two until the
  // second endpoint turned out to draw fire stations.)
  const combined = {
    id: 'test-combined',
    name: 'Combined',
    tileSize: 256,
    maxzoom: 14,
    opacity: 0.8,
    attribution: 'test',
    sources: [
      { name: 'A', tiles: ['https://example.org/a/{z}/{x}/{y}.png'] },
      { name: 'B', tiles: ['https://example.org/b/{z}/{x}/{y}.png'] },
    ],
  };

  const parts = overlayParts(combined);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].layerId, 'overlay-test-combined', 'the first part keeps the plain id');
  assert.notEqual(parts[1].layerId, parts[0].layerId, 'later parts need distinct ids');

  // Per-source settings inherit from the overlay unless the source overrides.
  assert.equal(parts[1].tileSize, 256);
  assert.deepEqual(parts[1].tiles, combined.sources[1].tiles);

  // Everything keyed on the overlay id must still find all of its layers.
  assert.ok(parts.every((part) => overlayIdFromLayer(part.layerId) === combined.id));

  const style = buildRasterStyle(rasterBasemaps[0], [combined]);
  assert.deepEqual(style.layers.slice(1).map((l) => l.id), parts.map((p) => p.layerId));
  assert.ok(style.layers.slice(1).every((l) => l.paint['raster-opacity'] === 0.8), 'one opacity for all parts');
});

test('style: any configured multi-source overlay is well formed', () => {
  for (const overlay of OVERLAYS.filter((o) => Array.isArray(o.sources))) {
    assert.ok(overlay.sources.length >= 1, `${overlay.id} declares an empty sources array`);
    for (const part of overlayParts(overlay)) {
      assert.ok(Array.isArray(part.tiles) && part.tiles.length, `${overlay.id}: a source has no tiles`);
    }
  }
});

test('style: a single-source overlay is unchanged by the parts machinery', () => {
  /*
   * Chosen by what it is, not by where it sits in the list.
   *
   * This used to take the first overlay with no `sources`, which was a plain
   * raster until a queried one was added at the top — and then the test failed
   * for a layer it was never about. A positional pick is a test that breaks
   * whenever the catalogue is reordered.
   */
  const plain = OVERLAYS.find((o) => !o.sources && !o.query && o.tiles);
  const parts = overlayParts(plain);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].layerId, `overlay-${plain.id}`);
  assert.deepEqual(parts[0].tiles, plain.tiles);
});

test('style: opacity is carried through to raster paint', () => {
  // A raster overlay, explicitly: a queried one has no raster paint to carry
  // an opacity into, and buildRasterStyle correctly skips it.
  const raster = OVERLAYS.find((o) => !o.query && (o.tiles || o.sources));
  const custom = [{ ...raster, opacity: 0.42 }];
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

test('units: a temperature converts from whatever scale it arrived in', () => {
  // The NWS publishes Fahrenheit for the United States and says so in every
  // period, so the conversion reads that rather than assuming it.
  assert.equal(formatTemperature(85, 'F', 'C'), '29\u00b0C');
  assert.equal(formatTemperature(85, 'F', 'F'), '85\u00b0F');
  assert.equal(formatTemperature(0, 'C', 'F'), '32\u00b0F');
  assert.equal(formatTemperature(100, 'C', 'C'), '100\u00b0C');

  // Round trips, because an off-by-one on the way back is a real bug that
  // shows up as a forecast that drifts a degree every time you toggle.
  for (const value of [-40, 0, 32, 72, 212]) {
    const there = convertTemperature(value, 'F', 'C');
    assert.ok(Math.abs(convertTemperature(there, 'C', 'F') - value) < 1e-9);
  }

  assert.equal(formatTemperature(null, 'F', 'C'), '\u2014');
  assert.equal(formatTemperature(60, 'F', 'C', { withScale: false }), '16\u00b0');
});

test('preview: every basemap can show one, and Byways is drawn rather than fetched', () => {
  const token = 'pk.test';
  for (const basemap of BASEMAPS) {
    const preview = previewFor(basemap, { lon: -84.28, lat: 35.96, zoom: 10, token });
    assert.ok(preview, `${basemap.id} has no preview`);
    if (basemap.custom === 'byways') {
      // Nothing renders this style but the browser it is built in, and its
      // raster `tiles` are the no-token fallback — a different map entirely, so
      // previewing with them would advertise the wrong thing.
      assert.equal(preview.kind, 'swatch', 'byways should be drawn, not fetched');
      continue;
    }
    assert.equal(preview.kind, 'image');
    assert.match(preview.src, /^https:\/\//, `${basemap.id} preview is not https`);
    assert.ok(!/\{[a-z-]+\}/.test(preview.src), `${basemap.id} preview left a placeholder in: ${preview.src}`);
  }
});

test('preview: the tile is the one under the point asked for', () => {
  // z10 over the Smokies. Getting y inverted is the classic tile-maths bug and
  // it fails silently — you get a tile, just of somewhere else.
  const tile = tileFor(-84.28, 35.96, 10);
  assert.deepEqual(tile, { x: 272, y: 402, z: 10 });

  // North is the larger latitude and the smaller y.
  assert.ok(tileFor(-84.28, 40, 10).y < tile.y, 'further north should have a smaller y');
  assert.ok(tileFor(-80, 35.96, 10).x > tile.x, 'further east should have a larger x');

  const url = tileURL('https://example.org/{z}/{x}/{y}.png', tile);
  assert.equal(url, 'https://example.org/10/272/402.png');
});

test('preview: the drawn swatch is one line, so it adds no text to its row', () => {
  // innerHTML keeps the whitespace between tags as text nodes, which put ten
  // blank lines ahead of the basemap's name in the row's textContent.
  const svg = swatchSVG({ paper: '#fff' });
  assert.ok(!/\n/.test(svg), 'the swatch should be a single line');
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
});

test('config: the weather group is a group, and every layer in it is a forecast source', () => {
  const weather = OVERLAYS.filter((entry) => entry.group === 'Weather');
  assert.ok(weather.length >= 5, 'the weather group should be more than the radar');
  assert.ok(weather.some((entry) => entry.id === 'radar'), 'radar belongs with the weather');

  for (const entry of weather) {
    assert.ok(entry.tiles?.length, `${entry.id} has no tiles`);
    assert.match(entry.tiles[0], /^https:\/\/[^/]*noaa\.gov\//, `${entry.id} should come from NOAA`);
    assert.ok(entry.attribution, `${entry.id} has no attribution`);
  }

  // A continuous ramp with no key is decoration. Every layer here carries
  // either a hand-written key or one fetched from the service that draws it.
  for (const entry of weather) {
    const explained = entry.legendScale || entry.legendImage || entry.legendJSON
      || (Array.isArray(entry.legend) && entry.legend.length);
    assert.ok(explained, `${entry.id} has no colour key`);
  }
});

test('config: a JSON legend is a legend request, and names a sublayer or none', () => {
  /*
   * `layer` picks one sublayer's key out of a service that describes all of
   * them — without it, a depth map would be captioned with a boundary's key.
   *
   * It is optional rather than required, though, and that is not a loosening:
   * a service whose export renders several sublayers at once has no single
   * key, and naming one of them would describe a fraction of what is drawn.
   * Omitting it means "all of them", which is the honest answer there.
   */
  for (const entry of [...BASEMAPS, ...OVERLAYS]) {
    if (!entry.legendJSON) continue;
    assert.match(entry.legendJSON.url, /^https:\/\/.*legend/, `${entry.id} legend is not a legend request`);
    if ('layer' in entry.legendJSON) {
      assert.equal(typeof entry.legendJSON.layer, 'number', `${entry.id} names a sublayer that is not a number`);
    }
  }
});

test('config: a fetched colour scale asks GeoServer for JSON, not a picture', () => {
  /*
   * The point of the JSON form is that the swatch list is drawn in the panel's
   * own type from the service's own colours. Asking for `format=image/png` here
   * would still return a legend and still render — as a picture of somebody
   * else's typography, which is what this replaced.
   */
  for (const entry of [...BASEMAPS, ...OVERLAYS]) {
    if (!entry.legendScale) continue;
    assert.match(entry.legendScale, /^https:\/\//, `${entry.id} scale is not https`);
    assert.match(entry.legendScale, /GetLegendGraphic/, `${entry.id} scale is not a legend request`);
    assert.match(entry.legendScale, /format=application\/json/, `${entry.id} scale asks for a picture`);
  }
});

test('config: a legend image is a real https URL asking for an image', () => {
  for (const entry of [...BASEMAPS, ...OVERLAYS]) {
    if (!entry.legendImage) continue;
    assert.match(entry.legendImage, /^https:\/\//, `${entry.id} legend is not https`);
    assert.match(entry.legendImage, /GetLegendGraphic/, `${entry.id} legend is not a legend request`);
    assert.match(entry.legendImage, /format=image\//, `${entry.id} legend does not ask for an image`);
  }
});

test('config: basemaps and overlays have unique ids and attribution', () => {
  const ids = [...BASEMAPS, ...OVERLAYS].map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate basemap/overlay id');
  for (const entry of [...BASEMAPS, ...OVERLAYS]) {
    assert.ok(entry.attribution, `"${entry.id}" is missing attribution, which the providers require`);
  }
});

/* ==========================================================================
   Byways Topo — the one style this project owns
   ========================================================================== */

test('byways: no token means no vector style, and the raster fallback is used', () => {
  // The style draws Mapbox's vector tiles. With no token there is nothing to
  // draw, so the basemap has to fall back rather than render an empty map.
  assert.equal(bywaysStyle(''), null);
  assert.equal(bywaysStyle(undefined), null);

  const byways = BASEMAPS.find((b) => b.id === 'byways-topo');
  assert.ok(byways, 'the custom basemap should exist');
  assert.ok(Array.isArray(byways.tiles) && byways.tiles.length, 'it needs a raster fallback');

  const result = styleFor(byways, []);
  assert.equal(result.vector, false, 'without a token this must be the raster path');
  assert.equal(result.style.layers[0].id, 'basemap');
});

test('byways: glyphs and sprite are present and are real strings', () => {
  // Learned the hard way: Mapbox GL validates the style and aborts loading on
  // any error, and `glyphs: undefined` is an error. A style with label layers
  // and no glyphs URL renders no labels at all, silently.
  const style = bywaysStyle('pk.test');
  assert.equal(typeof style.glyphs, 'string');
  assert.ok(style.glyphs.includes('{fontstack}') && style.glyphs.includes('{range}'));
  assert.equal(typeof style.sprite, 'string');
  assert.ok(style.sprite.length > 0);

  const symbolLayers = style.layers.filter((l) => l.type === 'symbol');
  assert.ok(symbolLayers.length > 0, 'a topo without labels is not finished');
});

test('byways: every URL is https, never the mapbox:// scheme', () => {
  // Only Mapbox GL resolves mapbox://. MapLibre would fail on it, and which
  // engine runs is a deployment decision rather than this file's.
  const style = bywaysStyle('pk.test');
  const urls = [
    style.glyphs, style.sprite,
    ...Object.values(style.sources).flatMap((s) => s.tiles || []),
  ];
  for (const url of urls) {
    assert.ok(url.startsWith('https://'), `expected https, got ${url}`);
    assert.ok(!url.includes('mapbox://'), `mapbox:// will not resolve: ${url}`);
  }
});

test('byways: the token reaches every source, and is URL-encoded', () => {
  const style = bywaysStyle('pk.abc+def/ghi');
  const encoded = encodeURIComponent('pk.abc+def/ghi');
  const urls = [style.glyphs, style.sprite, ...Object.values(style.sources).flatMap((s) => s.tiles)];
  for (const url of urls) {
    assert.ok(url.includes(`access_token=${encoded}`), `token missing or raw in ${url}`);
  }
});

test('byways: every layer points at a source that exists', () => {
  const style = bywaysStyle('pk.test');
  const names = new Set(Object.keys(style.sources));
  for (const layer of style.layers) {
    if (layer.type === 'background') continue;
    assert.ok(names.has(layer.source), `${layer.id} references missing source ${layer.source}`);
    assert.ok(layer['source-layer'], `${layer.id} needs a source-layer on a vector source`);
  }
});

test('byways: layer ids are unique and ordering puts labels above roads', () => {
  const style = bywaysStyle('pk.test');
  const ids = style.layers.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate layer ids');

  const lastRoad = ids.findLastIndex((id) => id.startsWith('road-') && !id.includes('label') && !id.includes('shield'));
  const firstLabel = ids.findIndex((id) => id.startsWith('label-'));
  assert.ok(firstLabel > lastRoad, 'labels must draw over the roads they name');
});

test('byways: road casings all draw before road fills', () => {
  // One pass each, not casing-then-fill per class: otherwise a junction shows
  // each road's outline cutting through its neighbour instead of one road
  // passing over the other.
  const ids = bywaysStyle('pk.test').layers.map((l) => l.id);
  const lastCasing = ids.findLastIndex((id) => id.endsWith('-casing'));
  const fills = ids.filter((id) => /^road-(motorway|trunk|primary|secondary|tertiary)$/.test(id));
  assert.ok(fills.length >= 5, 'expected the full road hierarchy');
  for (const fill of fills) {
    assert.ok(ids.indexOf(fill) > lastCasing, `${fill} draws before a casing`);
  }
});

test('byways: route shields build their image name from the feature', () => {
  // The thing raster tiles cannot do. Mapbox Streets tags each road with the
  // shield design and how many characters the number has; the sprite carries an
  // image per combination. Concatenating them is what makes an I-40 marker look
  // like an interstate marker.
  const shield = bywaysStyle('pk.test').layers.find((l) => l.id === 'road-shield');
  assert.ok(shield, 'no shield layer');
  assert.equal(shield.type, 'symbol');

  const image = JSON.stringify(shield.layout['icon-image']);
  assert.ok(image.includes('shield'), 'the image name should come from the shield field');
  assert.ok(image.includes('reflen'), 'and from how long the number is');
  assert.ok(image.includes('coalesce'), 'an unknown design should fall back, not vanish');

  assert.deepEqual(shield.layout['text-field'], ['get', 'ref'], 'the shield shows the route number');
  assert.ok(shield.filter.flat(3).includes('ref'), 'only roads with a number get a shield');
});

test('byways: a concurrency gets two shields, not one hyphenated one', () => {
  // US 23 and US 60 running together arrive as one feature with ref "23-60".
  // Drawn as a single marker that reads 23-60 — a sign that exists nowhere —
  // so the pair is split across two layers and the combined one stands down.
  // What the split actually evaluates to is checked in tools/validate-style.mjs,
  // which has the real expression evaluator; this is the structure it needs.
  const layers = bywaysStyle('pk.test').layers;
  const ids = layers.map((layer) => layer.id);
  for (const id of ['road-shield', 'road-shield-first', 'road-shield-second']) {
    assert.ok(ids.includes(id), `${id} is missing`);
  }

  const plain = layers.find((layer) => layer.id === 'road-shield');
  const first = layers.find((layer) => layer.id === 'road-shield-first');
  const second = layers.find((layer) => layer.id === 'road-shield-second');

  assert.ok(JSON.stringify(plain.filter).includes('"!"'), 'the combined shield should exclude concurrencies');
  assert.ok(JSON.stringify(first.filter).includes('duplex'), 'a half shield is only for a concurrency');

  // Opposite ways, or the two markers sit on top of each other.
  const [firstX] = first.layout['icon-offset'];
  const [secondX] = second.layout['icon-offset'];
  assert.ok(firstX < 0 && secondX > 0, 'the halves should sit either side of the line');
  assert.equal(firstX, -secondX, 'and the same distance from it');

  // The number moves with its shield. Text offsets are in ems and icon offsets
  // in pixels, so these are different numbers for the same shift — the failure
  // this guards is one of them being left at zero.
  const textX = (layer) => JSON.stringify(layer.layout['text-offset']);
  assert.notEqual(textX(first), textX(second), 'each half puts its number over its own shield');
  assert.notEqual(textX(first), JSON.stringify(plain.layout['text-offset']));
});

test('byways: state routes get shields, which means tertiary roads do', () => {
  // The bug this is here for: the shield layers covered motorway through
  // secondary, and Mapbox classes a road by what it carries rather than by who
  // numbered it. A two-lane state highway is `tertiary` as often as not, so
  // across whole states the only markers drawn were the interstates and US
  // routes — which is indistinguishable from the feature being broken.
  const layers = bywaysStyle('pk.test').layers;
  for (const id of ['road-shield', 'road-shield-first', 'road-shield-second']) {
    const filter = JSON.stringify(layers.find((layer) => layer.id === id).filter);
    assert.ok(filter.includes('tertiary'), `${id} skips tertiary roads`);
    assert.ok(filter.includes('secondary'), `${id} skips secondary roads`);
  }
});

test('byways: a state change updates every shield layer, halves included', () => {
  const updates = shieldLayerUpdates('TN');
  assert.deepEqual(updates.map((u) => u.id),
    ['road-shield', 'road-shield-first', 'road-shield-second']);

  // The halves sit either side of the line and the plain shield sits on it, so
  // their text offsets cannot all be the same — that equality is exactly what
  // updating only 'road-shield' used to produce.
  const offsets = updates.map((u) => JSON.stringify(u.layout['text-offset']));
  assert.notEqual(offsets[1], offsets[0]);
  assert.notEqual(offsets[1], offsets[2]);

  // And each update has to carry the state, or a border crossing changes
  // nothing.
  const tennessee = JSON.stringify(shieldLayerUpdates('TN'));
  const arizona = JSON.stringify(shieldLayerUpdates('AZ'));
  assert.notEqual(tennessee, arizona);
});

test('byways: unpaved roads are marked, and say so in their label', () => {
  // Mapbox Streets carries surface as paved/unpaved and nothing finer, so this
  // is the whole of what the tiles know about what a road is made of. It is
  // still the difference between a drive and a decision.
  const layers = bywaysStyle('pk.test').layers;
  const unpaved = layers.find((layer) => layer.id === 'road-unpaved');
  assert.ok(unpaved, 'no unpaved layer');
  assert.ok(JSON.stringify(unpaved.filter).includes('surface'), 'it should key on the surface field');
  assert.ok(unpaved.paint['line-dasharray'], 'and be dashed, or it is just another road');

  // Drawn over the fills rather than under them: a dash beneath the road it
  // describes is invisible.
  const at = (id) => layers.findIndex((layer) => layer.id === id);
  assert.ok(at('road-unpaved') > at('road-primary'), 'the dashes go on top of the road');
  assert.ok(at('road-unpaved') < at('label-road'), 'but under the labels');

  const label = layers.find((layer) => layer.id === 'label-road');
  assert.ok(JSON.stringify(label.layout['text-field']).includes('unpaved'),
    'the road label should carry the surface');

  const trail = layers.find((layer) => layer.id === 'label-trail');
  assert.ok(trail, 'no trail label layer');
  assert.ok(trail.minzoom > label.minzoom, 'trail names come in later than road names');
});

test('byways: the road hierarchy is coloured by class, not uniformly', () => {
  const style = bywaysStyle('pk.test');
  const colourOf = (id) => style.layers.find((l) => l.id === id).paint['line-color'];
  assert.notEqual(colourOf('road-motorway'), colourOf('road-trunk'));
  assert.notEqual(colourOf('road-trunk'), colourOf('road-primary'));
  assert.equal(colourOf('road-motorway'), PALETTE.interstate);
  assert.equal(colourOf('road-trunk'), PALETTE.usRoute);
});

test('byways: tracks and paths are drawn, and drawn differently from streets', () => {
  // The whole point of the map: it is for finding the road that is not paved.
  const style = bywaysStyle('pk.test');
  const track = style.layers.find((l) => l.id === 'road-track');
  const path = style.layers.find((l) => l.id === 'road-path');
  assert.ok(track && path);
  assert.ok(track.paint['line-dasharray'], 'an unpaved track should not read as sealed');
  assert.ok(path.paint['line-dasharray']);
  assert.notEqual(track.paint['line-color'], PALETTE.minor);
});

test('byways: contours are present, with index lines heavier than the rest', () => {
  const style = bywaysStyle('pk.test');
  const plain = style.layers.find((l) => l.id === 'contour');
  const index = style.layers.find((l) => l.id === 'contour-index');
  assert.ok(plain && index, 'a topo needs contours');
  assert.equal(plain.source, 'terrain');
  assert.deepEqual(index.filter, ['==', ['get', 'index'], 5], 'index lines are every fifth');
  assert.ok(index.minzoom < plain.minzoom, 'index lines should appear first when zooming in');
});

/* ---- route shields ---- */

test('shields: Mapbox shield values collapse onto four designs', () => {
  // Mapbox ships a long tail of variants. A variant drawn as its parent design
  // is far better than a variant drawn as nothing, which is what the first
  // version did when it asked the sprite for a name the sprite did not have.
  assert.equal(shieldDesign('us-interstate'), 'interstate');
  assert.equal(shieldDesign('us-interstate-duplex'), 'interstate');
  assert.equal(shieldDesign('us-highway'), 'us');
  assert.equal(shieldDesign('us-highway-business'), 'us');
  assert.equal(shieldDesign('us-state'), 'state');
  assert.equal(shieldDesign('something-unheard-of'), 'default');
  assert.equal(shieldDesign(''), 'default');
  assert.equal(shieldDesign(undefined), 'default');
});

test('shields: image ids clamp to the widths actually generated', () => {
  // A seven-character reference must land on the widest image rather than on
  // `abmap-shield-us-7`, which nothing would have registered.
  const ids = new Set(shieldImageIds());
  for (const length of [0, 1, 2, 3, 4, 5, 9, 40]) {
    assert.ok(ids.has(shieldImageId('us', length)), `length ${length} produced an unregistered id`);
  }
  assert.equal(shieldImageId('us', 1), shieldImageId('us', 2), 'below the minimum clamps up');
  assert.equal(shieldImageId('us', 9), shieldImageId('us', 4), 'above the maximum clamps down');
});

test('shields: every design and width has an id, and they are unique', () => {
  const ids = shieldImageIds();
  assert.equal(ids.length, SHIELD_DESIGNS.length * 3, 'four designs at three widths');
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id.startsWith('abmap-shield-')));
});

test('shields: the style names only images this module registers', () => {
  // The failure being guarded against: a style referring to an image nobody
  // registered draws nothing and reports nothing.
  const registered = new Set(shieldImageIds());
  const expression = shieldImageExpression();
  assert.equal(expression[0], 'concat');
  assert.equal(expression[1], 'abmap-shield-');

  // Pull the literal design names out of the match expression and confirm every
  // design/width combination it can produce was generated.
  const match = expression[2];
  assert.equal(match[0], 'match');
  const designs = match.slice(3).filter((item) => typeof item === 'string');
  for (const design of designs) {
    for (const length of [2, 3, 4]) {
      assert.ok(registered.has(`abmap-shield-${design}-${length}`), `unregistered: ${design}-${length}`);
    }
  }
});

test('shields: interstate numbers are white, everything else dark', () => {
  const colour = SHIELD_TEXT_COLOUR;
  assert.equal(colour[0], 'match');
  assert.equal(colour[colour.length - 1], '#1c1c1c', 'the fallback should be dark on light');
  assert.ok(JSON.stringify(colour).includes('#ffffff'), 'interstates are white on blue');
});

test('shields: rasterizing is skipped rather than thrown without a canvas', () => {
  // These tests run in Node. The module must degrade rather than explode, so
  // that importing it anywhere is safe.
  assert.equal(rasterizeShield('interstate', 2), null);
});

/* ---- per-state shields ---- */

test('shields: a state with no entry falls back rather than guessing', () => {
  // Territories and anything unrecognised get the generic marker rather than a
  // guess. (This used to check KY, which now has a shield of its own — the
  // example had to move, not the rule.)
  assert.equal(stateDesign('CA'), 'st-CA');
  assert.equal(stateDesign('ca'), 'st-CA', 'case should not matter');
  assert.equal(stateDesign('PR'), 'state');
  assert.equal(stateDesign('GU'), 'state');
  assert.equal(stateDesign(''), 'state');
  assert.equal(stateDesign(undefined), 'state');
  assert.equal(stateDesign('XX'), 'state');
});

test('shields: every listed state has a shape the renderer knows how to draw', () => {
  // Taken from the renderer itself rather than restated here, so adding a shape
  // to the table without adding a way to draw it fails loudly.
  const drawable = new Set(SHAPE_NAMES);
  for (const [code, entry] of Object.entries(STATE_SHIELDS)) {
    assert.ok(drawable.has(entry.shape), `${code} uses unknown shape "${entry.shape}"`);
    assert.match(entry.bg, /^#[0-9a-f]{6}$/i, `${code} needs a background colour`);
    assert.match(entry.fg, /^#[0-9a-f]{6}$/i, `${code} needs a number colour`);
  }
});

test('shields: only the state branch of the expression varies', () => {
  // Interstates and US routes look the same everywhere; swapping states must
  // not disturb them.
  const ca = JSON.stringify(shieldImageExpression('CA'));
  const ut = JSON.stringify(shieldImageExpression('UT'));
  assert.notEqual(ca, ut);
  assert.ok(ca.includes('st-CA') && !ca.includes('st-UT'));
  assert.ok(ut.includes('st-UT'));
  for (const expression of [ca, ut]) {
    assert.ok(expression.includes('us-interstate'), 'the interstate branch must survive');
    assert.ok(expression.includes('"interstate"'));
  }
});

test('shields: an unlisted state produces the same expression as no state at all', () => {
  assert.equal(
    JSON.stringify(shieldImageExpression('PR')),
    JSON.stringify(shieldImageExpression('')),
  );
});

test('shields: a drawn marker with lettering moves its number off the lettering', () => {
  // Texas is the one drawn design that carries a word. Without accounting for
  // it the number lands on TEXAS, which is what happens on the blanks whose
  // states put their name across the top — solved there by measuring the clear
  // space, and there is no image to measure here.
  const [, lifted] = shieldTextOffset('st-TX', 2);
  assert.ok(lifted < 0, 'the number should sit above the lettering');
  assert.ok(shieldTextSize('st-TX', 2) < shieldTextSize('st-NY', 2),
    'and be smaller, because it has less room');

  // A plain marker is unaffected.
  assert.deepEqual(shieldTextOffset('st-NY', 2), [0, 0]);
});

test('shields: every number is readable on the marker it sits on', () => {
  /*
   * Asserted by contrast rather than by a list of states.
   *
   * The list version named Idaho and Louisiana as dark markers, and when the
   * reference sheet said otherwise and they were corrected to white, the test
   * failed for having memorised the bug. What actually has to hold is that the
   * number contrasts with what is behind it — for every state, including ones
   * added later — so that is what is checked.
   */
  const luminance = (hex) => {
    const value = hex.replace('#', '');
    const parts = value.length === 3
      ? [...value].map((c) => parseInt(c + c, 16))
      : [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
    const [r, g, b] = parts.map((channel) => {
      const linear = channel / 255;
      return linear <= 0.03928 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  for (const [code, entry] of Object.entries(STATE_SHIELDS)) {
    // 4.5:1 is the ordinary text threshold. A route number is large and bold,
    // but it is also read at speed on a busy map, so it does not get the
    // large-text discount.
    const ratio = contrast(entry.fg, entry.bg);
    assert.ok(ratio >= 4.5, `${code}: ${entry.fg} on ${entry.bg} is only ${ratio.toFixed(1)}:1`);

    // And the expression has to actually carry that colour, not merely have it
    // written in the table.
    const expression = shieldTextColour(code);
    assert.equal(expression[expression.length - 1], entry.fg, `${code} number colour`);
  }

  /*
   * The interstate arm is always white regardless of the state, so a check that
   * merely looked for white somewhere in the expression would always pass. Both
   * examples are found in the table rather than named: this test used to name
   * Kentucky as the dark one, and when Kentucky turned out to be a white disc
   * like the other five circle states, the test failed for having memorised the
   * bug — two lines under a comment about exactly that.
   */
  const codes = Object.keys(STATE_SHIELDS);
  const lightMarker = codes.find((code) => STATE_SHIELDS[code].fg === '#1c1c1c');
  const darkMarker = codes.find((code) => STATE_SHIELDS[code].fg === '#ffffff');

  assert.ok(lightMarker, 'no light marker in the table at all');
  const light = shieldTextColour(lightMarker);
  assert.equal(light[light.length - 1], '#1c1c1c', `${lightMarker} takes a dark number`);

  if (darkMarker) {
    const dark = shieldTextColour(darkMarker);
    assert.equal(dark[dark.length - 1], '#ffffff', `${darkMarker} takes a white number`);
  }
});

test('shields: every state and DC has a marker, listed in a stable order', () => {
  const listed = statesWithShields();
  assert.deepEqual(listed, [...listed].sort(), 'listed in a stable order');
  assert.equal(listed.length, 51, 'fifty states plus the District of Columbia');

  // Spot-checks against the reference sheet, chosen because the first pass from
  // memory got each of these wrong.
  assert.equal(STATE_SHIELDS.FL.shape, 'outline', 'Florida is a state outline, not a circle');
  assert.equal(STATE_SHIELDS.OH.shape, 'square', 'Ohio is a square, not an outline');
  assert.equal(STATE_SHIELDS.AZ.bg, '#ffffff', 'Arizona is white, not black');
  assert.equal(STATE_SHIELDS.TX.shape, 'square', 'Texas is a square with lettering, not an outline');
});

test('route shields paint over the road names, and still always draw', () => {
  /*
   * Two properties that have to hold together, because each alone is a trap.
   *
   * Layer order is both paint order and placement order in GL: later paints on
   * top, earlier wins collisions. This used to put shields first, to stop them
   * giving way to every water name on the map — the right fix for the wrong
   * lever, because these layers allow overlap and were never going to give way
   * on collision. What it cost was the paint order, and a road name drawn
   * across a route marker is what got reported.
   *
   * So shields go last, and the allow-overlap flags are what make that safe.
   * Assert both: last alone would be a regression the moment somebody
   * "tidied" those flags away.
   */
  const style = bywaysStyle('pk.test');
  const symbols = style.layers.filter((layer) => layer.type === 'symbol').map((layer) => layer.id);
  const shield = symbols.indexOf('road-shield');

  assert.ok(shield >= 0, 'the shield layer exists');
  assert.ok(symbols.slice(0, shield).includes('label-road'),
    'road names must be painted before shields, so the shield lands on top');
  assert.ok(!symbols.slice(shield + 1).some((id) => id.startsWith('label-')),
    `these labels paint over the shields: ${symbols.slice(shield + 1)}`);

  for (const id of ['road-shield', 'road-shield-first', 'road-shield-second']) {
    const { layout } = style.layers.find((layer) => layer.id === id);
    assert.equal(layout['icon-allow-overlap'], true, `${id} would give way on collision`);
    assert.equal(layout['text-allow-overlap'], true, `${id}'s number would give way on collision`);
  }
});

test('a shield and the number on it obey the same collision rules', () => {
  // A number set to ignore collisions while its shield is not is how shields
  // "turn into text labels": the icon is dropped and the bare ref stays.
  const style = bywaysStyle('pk.test');
  const { layout } = style.layers.find((layer) => layer.id === 'road-shield');

  assert.equal(layout['icon-allow-overlap'], layout['text-allow-overlap']);
  assert.equal(layout['icon-ignore-placement'], layout['text-ignore-placement']);
  assert.equal(layout['text-optional'], false);
  assert.equal(layout['icon-optional'], false);
});

test('the diagnostic and the style agree on every image id', () => {
  /*
   * These were two hand-written copies of one mapping, and they disagreed: the
   * diagnostic built its ids from the raw Mapbox `shield` value while the style
   * collapsed that value to a design first. Every road would have been reported
   * as missing an image it never asked for. Both are now generated from one
   * table; this walks the expression by hand to prove it.
   */
  const state = 'TN';
  // ['concat', 'abmap-shield-', <match>, '-', <reflen>]
  const expression = shieldImageExpression(state);
  const match = expression[2];

  const evaluate = (shield) => {
    for (let i = 2; i < match.length - 1; i += 2) {
      if (match[i].includes(shield)) return match[i + 1];
    }
    return match[match.length - 1];
  };

  for (const shield of [
    'us-interstate', 'us-interstate-duplex', 'us-highway', 'us-highway-business',
    'us-state', 'us-state-duplex', 'something-unknown', '',
    // What the Tilequery API actually returns for a state route. `us-state` is
    // the documented value; `circle-white` is the one on the wire.
    'circle-white', 'rectangle-white', 'diamond-white',
  ]) {
    const fromStyle = `abmap-shield-${evaluate(shield)}-3`;
    assert.equal(shieldImageIdFor(shield, 3, state), fromStyle, `disagreement on "${shield}"`);
  }
});

test('a real state route gets its state marker, not the generic one', () => {
  /*
   * Straight from the wire. Asking Mapbox what it puts on KY 677 came back:
   *
   *   class=tertiary type=tertiary ref=677 shield=circle-white reflen=3
   *
   * Not `us-state`, which is the value the documentation names and the value
   * every test here had been written around. Mapbox names the shield after the
   * shape a state's marker resembles, so this is what has to resolve to
   * Kentucky's circle — and there is no test worth having that only exercises
   * a value the data never contains.
   */
  assert.equal(shieldImageIdFor('circle-white', 3, 'KY'), 'abmap-shield-st-KY-3');
  assert.equal(shieldImageIdFor('circle-white', 2, 'TN'), 'abmap-shield-st-TN-2');
  // And it must not drag the nationals along with it: those look the same in
  // every state and are named by route system, not by shape.
  assert.equal(shieldImageIdFor('us-interstate', 2, 'KY'), 'abmap-shield-interstate-2');
  assert.equal(shieldImageIdFor('us-highway', 2, 'KY'), 'abmap-shield-us-2');
});

test('every image the style can ask for is one the module can draw', () => {
  // A shield the expression names and nothing registers renders as a bare
  // number — the exact "shields turned into text labels" failure.
  const registrable = new Set(shieldImageIds({ state: 'TN' }));
  for (const shield of ['us-interstate', 'us-highway', 'us-state', 'circle-white', 'unknown']) {
    for (const length of [2, 3, 4]) {
      const id = shieldImageIdFor(shield, length, 'TN');
      assert.ok(registrable.has(id), `${id} is asked for but never registered`);
    }
  }
});

test('the id list and the registrar walk the same designs', () => {
  /*
   * These two kept their own copies of the design list and the copies
   * disagreed: the registrar added the current state's own marker, the
   * enumeration did not. Nothing broke visibly — a missing image self-heals
   * through styleimagemissing — but any check written against the enumeration
   * was blind to exactly the state shields the feature exists for. One shared
   * list now, and this asserts the enumeration is built from it.
   */
  for (const state of ['', 'TN', 'CA', 'ZZ']) {
    const designs = shieldDesignsFor(state);
    const ids = shieldImageIds({ state });

    assert.equal(ids.length, designs.length * 3, `state "${state}": three widths per design`);
    for (const design of designs) {
      for (const length of [2, 3, 4]) {
        assert.ok(ids.includes(shieldImageId(design, length)),
          `state "${state}": ${design} at width ${length} is registered but not listed`);
      }
    }
  }

  // A state with its own marker gets one more design than one without.
  assert.equal(shieldDesignsFor('TN').length, shieldDesignsFor('').length + 1);
  assert.equal(shieldDesignsFor('ZZ').length, shieldDesignsFor('').length);
});

test('byways: every road class draws its ramps too', () => {
  /*
   * Mapbox Streets tags a slip road as its own class — `motorway_link` and so
   * on — and these layers matched the class exactly. Every ramp in the country
   * was therefore missing from this style while showing correctly on Street,
   * which is how an interchange ends up drawn as two roads crossing.
   */
  const style = bywaysStyle('pk.test');
  for (const className of ['motorway', 'trunk', 'primary', 'secondary', 'tertiary']) {
    for (const id of [`road-${className}`, `road-${className}-casing`]) {
      const layer = style.layers.find((entry) => entry.id === id);
      assert.ok(layer, `${id} exists`);
      const filter = JSON.stringify(layer.filter);
      assert.ok(filter.includes(`"${className}_link"`), `${id} does not match its ramps: ${filter}`);
    }
  }
});

test('byways: a zoom expression is never nested where GL will reject it', () => {
  /*
   * `zoom` is only legal as the input to a top-level `step` or `interpolate`.
   * Nested anywhere else the style fails validation, and GL's response to an
   * invalid style is to abort loading and render nothing while reporting
   * success — so this is a blank map, not a wrong colour.
   */
  const offenders = [];
  const walk = (node, path, depth) => {
    if (!Array.isArray(node)) return;
    if (node[0] === 'zoom' && depth > 1) offenders.push(path);
    const nested = node[0] === 'interpolate' || node[0] === 'step' ? 0 : depth + 1;
    node.forEach((child, index) => walk(child, `${path}[${index}]`, nested));
  };

  for (const layer of bywaysStyle('pk.test').layers) {
    for (const group of ['paint', 'layout']) {
      for (const [property, value] of Object.entries(layer[group] || {})) {
        walk(value, `${layer.id}.${group}.${property}`, 0);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('a drawn shield and a real blank land at the same size on screen', () => {
  /*
   * The invariant that makes SHIELD_SCALE a single knob rather than three.
   *
   * A marker's size is set two different ways depending on where it comes
   * from. A drawn one is canvassed at a CSS size, so it grows when that size
   * grows. A blank is a PNG of fixed pixel dimensions, so it grows only when
   * the ratio it is registered at falls. Change one and not the other and half
   * the country's markers are a different size from the other half — which
   * reads as a rendering bug rather than a constant somebody edited.
   *
   * Narrow blanks are 44x40 device pixels; the length-2 drawn shield is the
   * one they have to match.
   */
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(
    near(44 / BLANK_PIXEL_RATIO, shieldDisplayWidth(2)),
    `a narrow blank draws ${44 / BLANK_PIXEL_RATIO}px wide, a drawn shield ${shieldDisplayWidth(2)}px`,
  );
  assert.ok(near(40 / BLANK_PIXEL_RATIO, 20 * SHIELD_SCALE), 'the heights have to agree too');
});

test('the number still fits its clear space at whatever scale', () => {
  /*
   * Growing the marker is only half of growing the marker: the number is sized
   * from a rectangle measured in the blank's own pixels, and if that
   * measurement stops being converted by the ratio the blank is registered at,
   * the text grows at a different rate from the shield behind it and runs off
   * the edge. Nothing about that is visible in a unit test of either one alone.
   */
  for (const design of ['us', 'interstate', ...statesWithShields().map((code) => `st-${code}`)]) {
    for (const length of [2, 3, 4]) {
      const blank = shieldBlankFor(design, length);
      if (!blank) continue;
      const box = SHIELD_BOXES[blank.key];
      if (!box) continue;

      const size = shieldTextSize(design, length);
      const room = box.h / BLANK_PIXEL_RATIO;
      // Or it is at the readability floor, which a handful of markers with very
      // little clear space sit at deliberately — see MIN_TEXT.
      assert.ok(
        size <= room || size === MIN_TEXT,
        `${design}/${length}: ${size}px of type in ${room}px of space, and not at the floor`,
      );
    }
  }
});
