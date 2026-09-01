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

import {
  buildRasterStyle, overlayParts, overlayIdFromLayer, overlayLinks, overlayRows, styleFor,
  labelExpression, viewNeedsFetch,
} from '../assets/js/lib/engine.js';
import {
  BASEMAPS, OVERLAYS, DEFAULT_BASEMAP, DEFAULT_BASEMAP_WITH_TOKEN, STATE_NAMES, STATE_GROUP,
} from '../assets/js/config.js';
import { bywaysStyle, PALETTE, shieldLayerUpdates } from '../assets/js/lib/byways-style.js';
import { previewFor, tileFor, tileURL, swatchSVG } from '../assets/js/lib/preview.js';
import { saveBlob } from '../assets/js/lib/ui.js';
import {
  shieldTextOffset, shieldTextSize, shieldDisplayWidth, shieldBlankFor,
  SHIELD_SCALE, BLANK_PIXEL_RATIO, MIN_TEXT,
} from '../assets/js/lib/route-shields.js';
import { SHIELD_BOXES } from '../assets/js/lib/shield-boxes.js';
import { bodyOf, applySaved } from '../assets/js/lib/editable.js';
import { declared } from '../tools/check-fields.mjs';
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

test('style: a queried overlay is five layers over one source, and no tiles', () => {
  const queried = {
    id: 'test-queried',
    name: 'Queried',
    opacity: 0.6,
    attribution: 'test',
    query: { url: 'https://example.org/query?geometry={bbox}&f=geojson', minzoom: 6 },
  };

  const parts = overlayParts(queried);
  /*
   * Three, not two. The third is a dot, and it exists because a fill and a
   * line draw literally nothing over point geometry - which is what a good
   * many services answer with regardless of what their titles promise. Six
   * shipped layers were invisible for exactly this reason and said nothing
   * about it, so the dot is unconditional rather than opt-in.
   */
  /*
   * Four, and the order is the drawing order. The casing sits under the core
   * because that is what makes a road legible over terrain, and a part list in
   * the wrong order would put the pale line on top of the coloured one.
   */
  assert.equal(parts.length, 5, 'a fill, a casing, the core line, a dot, and the name');
  assert.deepEqual(parts.map((part) => part.role), ['fill', 'casing', 'line', 'dot', 'label']);
  assert.equal(parts[0].layerId, 'overlay-test-queried');
  assert.equal(parts[1].layerId, 'overlay-test-queried--1');
  assert.equal(parts[2].layerId, 'overlay-test-queried--2');
  assert.equal(parts[3].layerId, 'overlay-test-queried--3');
  assert.equal(parts[4].layerId, 'overlay-test-queried--4');
  assert.ok(parts.every((part) => !part.tiles), 'there are no tiles to fetch');

  // Tearing the overlay down by its id has to find every part, or a layer is
  // left behind on the map with nothing under it.
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
    /*
     * The panel writes the state's name onto the row from its code, so a code
     * with no name would show as "Aerial (3 in) — WV" and read like a bug. The
     * table is where a new state gets spelled, and this is what says so on the
     * day somebody adds a layer and forgets it.
     */
    for (const code of overlay.states) {
      assert.ok(STATE_NAMES[code], `${overlay.id}: ${code} has no name in STATE_NAMES`);
    }
    // Every state's data sits under one heading, so a subject group of its own
    // would never be shown.
    assert.ok(!overlay.group,
      `${overlay.id} cannot be both state-scoped and in a subject group`);
  }

  assert.ok(STATE_GROUP.length > 2, 'the state heading has to say something');
});

test('config: a queried overlay carries a bbox placeholder and a floor', () => {
  for (const overlay of OVERLAYS.filter((o) => o.query)) {
    assert.ok(overlay.query.url.includes('{bbox}'),
      `${overlay.id} has nowhere to put the view`);
    /*
     * A sublayer bringing its own URL has to bring the placeholder too.
     *
     * Without {bbox} the request asks for the whole country, which either
     * times out or comes back truncated - and a truncated restriction layer
     * has gaps in it that look like open airspace.
     */
    for (const kind of overlay.query.uses || []) {
      if (!kind.url) continue;
      assert.ok(kind.url.includes('{bbox}'),
        `${overlay.id}: the ${kind.use} sublayer would query the whole country`);
      assert.match(kind.url, /f=geojson/, `${overlay.id}: the ${kind.use} sublayer does not ask for GeoJSON`);
    }
    assert.match(overlay.query.url, /f=geojson/, `${overlay.id} does not ask for GeoJSON`);
    assert.ok(overlay.query.minzoom >= 1,
      `${overlay.id} would query the whole country at once`);
    assert.ok(!overlay.tiles, `${overlay.id} cannot be both queried and tiled`);
  }
});

test('style: a named column is a column the query actually asks for', () => {
  /*
   * A label for a field the request never fetches is a row that never appears.
   *
   * Nothing else can catch it: the config is valid, the panel is correct, and
   * the row is simply always absent - which reads as a service that stopped
   * publishing the column rather than as a typo three lines away in the same
   * object.
   */
  for (const overlay of OVERLAYS.filter((o) => o.query?.fields)) {
    const outFields = decodeURIComponent(
      overlay.query.url.match(/outFields=([^&]*)/)?.[1] || '',
    ).split(',').map((name) => name.trim());
    assert.ok(outFields.length > 0, `${overlay.id} names columns but fetches none`);
    for (const key of Object.keys(overlay.query.fields)) {
      assert.ok(outFields.includes(key) || outFields.includes('*'),
        `${overlay.id} labels ${key} but never asks the service for it`);
    }
  }
});

test('style: a coded column reads as words, not as digits', () => {
  const fields = {
    CEILING: { label: 'Ceiling', suffix: ' ft AGL', values: { 0: '0 ft — no instant approval' } },
    APT1_NAME: { label: 'Airport' },
    APT1_LAANC: { label: 'LAANC', values: { 1: 'Airport participates', 0: 'Airport does not participate' } },
    HIDDEN: { label: 'Hidden', values: { 7: '' } },
  };

  // What this pins: `values` beats `suffix`, the declared order is the read
  // order, and a blank drops its row. (Not the number/text key question - a
  // JavaScript property lookup coerces the key by itself, so that one cannot
  // fail here the way it failed in the Mapbox expression.)
  assert.deepEqual(
    overlayRows(fields, { CEILING: 0, APT1_NAME: 'Blue Grass', APT1_LAANC: 1 }),
    [['Ceiling', '0 ft — no instant approval'],
      ['Airport', 'Blue Grass'],
      ['LAANC', 'Airport participates']],
  );

  // A value with no entry in the table falls through to the suffix.
  assert.deepEqual(
    overlayRows(fields, { CEILING: 400, APT1_LAANC: 0 }),
    [['Ceiling', '400 ft AGL'], ['LAANC', 'Airport does not participate']],
  );

  // Declared order, not the order the service happened to serialise them.
  assert.deepEqual(
    overlayRows(fields, { APT1_NAME: 'Yeager', CEILING: 200 }).map(([label]) => label),
    ['Ceiling', 'Airport'],
  );

  // Absent, empty and deliberately blanked all leave the panel alone.
  assert.deepEqual(overlayRows(fields, { APT1_NAME: '', CEILING: null, HIDDEN: 7 }), []);
});

test('style: a link with a hole in it is not shipped', () => {
  const links = [
    { label: 'Request authorisation', href: 'https://faadronezone-access.faa.gov/' },
    { label: 'This airport', href: 'https://example.gov/a?id={APT1_FAAID}' },
    { label: 'Call', href: 'tel:+18443596982' },
    { label: 'Script', href: 'javascript:alert(1)' },
  ];

  assert.deepEqual(overlayLinks(links, { APT1_FAAID: 'LEX' }), [
    { label: 'Request authorisation', href: 'https://faadronezone-access.faa.gov/' },
    { label: 'This airport', href: 'https://example.gov/a?id=LEX' },
    { label: 'Call', href: 'tel:+18443596982' },
  ]);

  /*
   * The templated link goes away when the field does, rather than shipping as
   * `?id=`. A URL with an empty parameter is worse than a missing link: it
   * looks like it worked, and the page it lands on is entitled to interpret
   * the blank however it likes.
   */
  assert.deepEqual(
    overlayLinks(links, {}).map((link) => link.label),
    ['Request authorisation', 'Call'],
  );

  // Values are escaped on the way into the URL, and only navigable schemes
  // survive - the catalogue is ours, but this is still data going into an href.
  assert.equal(
    overlayLinks([links[1]], { APT1_FAAID: 'a b&c' })[0].href,
    'https://example.gov/a?id=a%20b%26c',
  );
  assert.deepEqual(overlayLinks([links[3]], {}), []);
});

test('ui: a file goes out by whichever route the browser has', async () => {
  /*
   * The reason this exists: an iOS WKWebView - which is what the app is -
   * ignores the download attribute, so "Save as a picture" clicked, did
   * nothing, and reported success. Share is the route that works there.
   */
  const blob = new Blob(['x'], { type: 'image/png' });
  const original = { share: navigator.share, canShare: navigator.canShare, File: globalThis.File };
  const restore = () => {
    navigator.share = original.share;
    navigator.canShare = original.canShare;
    globalThis.File = original.File;
  };

  try {
    let shared = null;
    navigator.canShare = () => true;
    navigator.share = async (data) => { shared = data; };
    assert.equal(await saveBlob(blob, 'map.png'), 'shared');
    assert.equal(shared.files[0].name, 'map.png');

    // Cancelling is not a failure, and must not fall through to a download
    // the person just declined.
    navigator.share = async () => { const error = new Error('no'); error.name = 'AbortError'; throw error; };
    assert.equal(await saveBlob(blob, 'map.png'), 'cancelled');

    /*
     * No share support at all falls back to the anchor.
     *
     * Node has no DOM, so the anchor is built against the smallest stub that
     * can record what the real one would have been handed - which is the point
     * of the assertion: the fallback has to set `download` to the filename,
     * and a click that navigates instead of downloading is the bug this whole
     * function exists to route around.
     */
    let clicked = null;
    const node = () => ({
      attrs: {}, className: '', dataset: {},
      setAttribute(key, value) { this.attrs[key] = value; },
      addEventListener() {}, append() {}, remove() {},
      click() { clicked = this; },
    });
    globalThis.document = { createElement: node, body: { append() {} }, createTextNode: () => ({}) };
    globalThis.URL.createObjectURL = () => 'blob:x';
    globalThis.URL.revokeObjectURL = () => {};

    navigator.canShare = () => false;
    assert.equal(await saveBlob(blob, 'map.png'), 'downloaded');
    assert.equal(clicked?.attrs.download, 'map.png', 'the fallback has to actually ask for a download');
    assert.equal(clicked?.attrs.href, 'blob:x', 'and to point at the blob it was given');
  } finally {
    restore();
    delete globalThis.document;
  }
});

test('style: a hatched fillBy names a colour for every value it tags', () => {
  /*
   * A `match` on fill-pattern that names an image which was never registered
   * draws nothing at all - not the fallback, nothing. On a layer whose whole
   * job is showing where you may not fly, an area that silently stops drawing
   * is the worst possible failure, so every severity a sublayer can apply has
   * to have a colour waiting for it.
   */
  for (const overlay of OVERLAYS.filter((o) => o.query?.fillBy?.hatch)) {
    const by = overlay.query.fillBy;
    const tagged = new Set((overlay.query.uses || [])
      .map((kind) => kind.tag?.[by.field] ?? (by.field === 'use' ? kind.use : undefined))
      .filter((value) => value !== undefined));
    assert.ok(tagged.size > 0, `${overlay.id} hatches by ${by.field} but tags nothing with it`);
    for (const value of tagged) {
      assert.ok(Object.hasOwn(by.colors, value),
        `${overlay.id} tags features "${value}" but has no colour for it`);
    }
    // And the legend says what the colours mean, in the same words.
    for (const value of Object.keys(by.colors)) {
      assert.ok((overlay.legend || []).some((entry) => entry.label === value),
        `${overlay.id}: "${value}" is painted but never explained in the key`);
    }
  }
});

test('style: a gated basemap is never the default anyone lands on', () => {
  /*
   * `audience: 'editors'` keeps a basemap out of the picker for everyone else.
   * A default nobody can see is a map that loads and cannot be switched away
   * from by name, which is the one way this decluttering could become a fault.
   */
  const gated = BASEMAPS.filter((basemap) => basemap.audience === 'editors');
  assert.ok(gated.length > 0, 'nothing is gated, so this test is about nothing');
  for (const id of [DEFAULT_BASEMAP, DEFAULT_BASEMAP_WITH_TOKEN]) {
    const basemap = BASEMAPS.find((entry) => entry.id === id);
    assert.equal(basemap?.audience, undefined, `${id} is the default and must be visible to everyone`);
  }

  /*
   * And at least one drawn map stays public. Gating Byways Topo before its
   * Protomaps twin exists would leave the site with nothing but agency
   * rasters, which is the thing this project exists to improve on.
   */
  const publicDrawn = BASEMAPS.filter((basemap) => (basemap.style || basemap.custom) && basemap.audience !== 'editors');
  assert.ok(publicDrawn.length > 0, 'every drawn basemap is gated, leaving the public site with none');
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
  assert.ok(image.includes('coalesce'), 'an unknown design should fall back, not vanish');

  /*
   * Sized from the number that gets drawn, not from the tile's `reflen`.
   *
   * `reflen` is the length of the raw ref, and the raw ref carries the system
   * — "SR 61" is five characters holding two digits. Sizing the blank from it
   * puts a small number adrift in a wide sign.
   */
  assert.ok(!image.includes('reflen'), 'the blank is sized from the number, not the raw ref');
  assert.ok(image.includes('length'), 'which means measuring what is drawn');

  /*
   * And what is drawn is a number.
   *
   * The shape around it is what says which system issued it, so the prefix in
   * the ref is redundant at best — "SR 61" inside a state-route blank is a
   * sign that exists nowhere. Asserted as "not the raw ref" rather than by
   * matching the expression, which is checked properly by evaluating it in
   * tools/validate-style.mjs against the refs the tiles really produce.
   */
  const text = JSON.stringify(shield.layout['text-field']);
  assert.notDeepEqual(shield.layout['text-field'], ['get', 'ref'],
    'the raw ref carries the system prefix and the shield must not');
  assert.ok(text.includes('ref'), 'the number still comes from the ref');
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

test('shields: Mapbox shield values collapse onto a handful of designs', () => {
  // Mapbox ships a long tail of variants. A variant drawn as its parent design
  // is far better than a variant drawn as nothing, which is what the first
  // version did when it asked the sprite for a name the sprite did not have.
  assert.equal(shieldDesign('us-interstate'), 'interstate');
  assert.equal(shieldDesign('us-interstate-duplex'), 'interstate');
  assert.equal(shieldDesign('us-highway'), 'us');
  assert.equal(shieldDesign('us-highway-business'), 'us');
  assert.equal(shieldDesign('us-state'), 'state');

  /*
   * And an unrecognised value is a circle, not a state marker.
   *
   * Mapbox says `default` for the roads a state has not signed — probed two
   * miles apart in Leelanau County, where M-22 comes back `circle-white` and
   * the county road beside it comes back `default`. Sending the second to the
   * state's own design is how a county road came to wear Michigan's M.
   */
  assert.equal(shieldDesign('something-unheard-of'), 'circle');
  assert.equal(shieldDesign(''), 'circle');
  assert.equal(shieldDesign(undefined), 'circle');
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

test('the vector sources declare each tileset own depth', () => {
  /*
   * Read from the tilesets' TileJSON, not chosen. Both were 14, which is
   * neither one's real limit, and understating it degrades silently: past the
   * declared maxzoom GL stops fetching and stretches the last tile it holds.
   *
   * For symbols that is not merely soft. `symbol-spacing` is resolved at the
   * tile's own zoom and scaled with the tile, so 260px baked in at z14 is about
   * a thousand pixels apart on screen at z16 — a road can cross the viewport
   * without a shield landing on it, which is what "the route numbers disappear
   * when I zoom in" turned out to be.
   *
   * Overstating it is the worse error: GL would request tiles that 404 and no
   * roads would draw at all. So these numbers are pinned here, and changing one
   * should mean somebody asked the service again.
   */
  const style = bywaysStyle('pk.test');
  assert.equal(style.sources.composite.maxzoom, 16, 'mapbox-streets-v8 publishes z16');
  assert.equal(style.sources.terrain.maxzoom, 15, 'mapbox-terrain-v2 publishes z15');
});

test('shield spacing leaves room for the overzoom above the tileset', () => {
  // Above a source's maxzoom every remaining level doubles the effective
  // spacing. The top of the ramp is what that doubling starts from, so it is
  // held below the point where two levels of overzoom empties the screen.
  const style = bywaysStyle('pk.test');
  for (const id of ['road-shield', 'road-shield-first', 'road-shield-second']) {
    const spacing = style.layers.find((layer) => layer.id === id).layout['symbol-spacing'];
    const stops = spacing.slice(3);
    const top = stops[stops.length - 1];
    assert.ok(top <= 240, `${id} spacing tops out at ${top}, which quadruples badly past z16`);
  }
});

test('shields: the marker comes from the road, not from where the map is looking', async () => {
  /*
   * Reported from the New River valley, looking at West Virginia with Virginia
   * across the river: every state marker on screen wore West Virginia's shape,
   * Virginia's routes included, and the whole screen redrew as Virginia's the
   * moment the centre crossed over.
   *
   * The state arm resolved to the state under the viewport. That is the only
   * thing available under the shape-named schema — a road there says
   * `circle-white` and never says who signed it — and it was carried across to
   * the schema that does say, in the value `US:VA`, on the feature itself.
   *
   * Evaluated rather than inspected. An expression with a `st-VA` arm in it
   * looks correct while matching on the wrong input, which is precisely the
   * bug, so a structural assertion would have passed on it.
   */
  const { evaluate } = await import('./helpers/expression.mjs');
  const { shieldImageExpression, shieldTextColour, shieldTextOffsetExpression } =
    await import('../assets/js/lib/route-shields.js');

  // Built as the style builds it: the map is over West Virginia.
  const at = (net) => ({ properties: { network: net, shield_text: '460' } });
  const image = shieldImageExpression('WV', {
    length: ['length', ['coalesce', ['get', 'shield_text'], '']],
    network: 'network',
  });

  assert.equal(evaluate(image, at('US:WV')), 'abmap-shield-st-WV-3');
  assert.equal(evaluate(image, at('US:VA')), 'abmap-shield-st-VA-3',
    'a Virginia route drew West Virginia’s marker because the viewport was asked');

  // The nationals look the same in every state and must not be pulled in.
  assert.equal(evaluate(image, at('US:I')), 'abmap-shield-interstate-3');
  assert.equal(evaluate(image, at('US:US')), 'abmap-shield-us-3');

  /*
   * A banner is a component of the network, and the road underneath it is
   * still a US route.
   *
   * Reported from Lee County, Virginia: US 58 ALT drawn as a plain white box.
   * `US:US:Business` did not equal `US:US`, so it fell through to the state
   * arm, which sliced "US" out of it, found no state by that name and took the
   * generic fallback. The archive over that ground carries exactly `US:US`,
   * `US:US:Business`, `US:KY` and `US:VA:Secondary`, so these are the values
   * the tiles really hold rather than ones I supposed they would.
   */
  assert.equal(evaluate(image, at('US:US:Business')), 'abmap-shield-us-3',
    'a bannered US route fell back to the generic marker');
  assert.equal(evaluate(image, at('US:US:Alternate')), 'abmap-shield-us-3');
  assert.equal(evaluate(image, at('US:I:Business')), 'abmap-shield-interstate-3');
  // A state route with a banner already worked, and has to keep working: the
  // state arm slices two characters, so the third component never reached it.
  assert.equal(evaluate(image, at('US:VA:Alternate')), 'abmap-shield-st-VA-3');

  /*
   * Matched on the component boundary, not as a prefix.
   *
   * `US:USFS` is the Forest Service, a different system that happens to share
   * five characters with `US:US`. A `startsWith` would have given every forest
   * road a US highway shield, which is the same class of bug in the other
   * direction and would have looked like a fix.
   */
  assert.notEqual(evaluate(image, at('US:USFS')), 'abmap-shield-us-3',
    'a Forest Service route was drawn as a US highway');

  // A road nothing has claimed gets the plain circle, not the state's marker —
  // that is how a county road ends up wearing a state's letter.
  assert.equal(evaluate(image, at('CA:ON')), 'abmap-shield-circle-3');

  /*
   * A network can carry a third component, and slicing to the end of the
   * string rather than to two characters would look up a state called
   * "WV:Truck" and fall through to the generic rectangle.
   *
   * I first wrote this assertion with `US:WV:Secondary` and expected the
   * state's own square, having guessed at what the third component meant. The
   * tile says otherwise - see the county test below - so the case that
   * exercises the slice has to be one the county rule does not claim.
   */
  assert.equal(evaluate(image, at('US:WV:Truck')), 'abmap-shield-st-WV-3');

  // The clear space is measured from each state's own artwork, so the number
  // has to be placed for the marker actually drawn.
  assert.notDeepEqual(
    evaluate(shieldTextOffsetExpression('WV', 2, 0, { network: 'network' }), at('US:VA')),
    evaluate(shieldTextOffsetExpression('WV', 2, 0, { network: 'network' }), at('US:WV')),
    'two markers of different shapes cannot share one text offset',
  );

  /*
   * And the ink, which is the one that disappears rather than merely looking
   * wrong: several markers are dark, so a number drawn in a neighbour's ink
   * can come out dark on dark.
   */
  const ink = shieldTextColour('WV', { network: 'network' });
  assert.equal(evaluate(ink, at('US:CA')), '#ffffff', 'California’s green spade takes white numerals');
  assert.equal(evaluate(ink, at('US:NM')), '#b0202f', 'New Mexico’s Zia is red');
  assert.equal(evaluate(ink, at('US:WV')), '#1c1c1c');
  assert.equal(evaluate(ink, at('US:I')), '#ffffff');
});

test('shields: every state with a marker can be reached from its network value', async () => {
  /*
   * Stated over the whole table rather than the three states in the report.
   * The arms are generated from `STATE_SHIELDS`, so a state added to the table
   * and forgotten in the expression is the failure this catches — it would
   * draw the generic rectangle, which is a plausible-looking sign and not a
   * missing one.
   */
  const { evaluate } = await import('./helpers/expression.mjs');
  const { shieldImageExpression, statesWithShields } = await import('../assets/js/lib/route-shields.js');

  const image = shieldImageExpression('WV', { length: 2, network: 'network' });
  for (const code of statesWithShields()) {
    assert.equal(
      evaluate(image, { properties: { network: `US:${code}` } }),
      `abmap-shield-st-${code}-2`,
      `${code} does not reach its own marker`,
    );
  }
});

test('shields: a county route is a circle, and an oval when the number is a fraction', async () => {
  /*
   * Reported from Clay County: county routes were wearing West Virginia's
   * square. The tile over Clay carries both networks side by side —
   *
   *   network  US:WV, US:WV:County
   *
   * — so the two are separable, and taking two characters off each made them
   * the same. West Virginia signs its secondaries in circles and numbers them
   * in fractions, CR 11/5 hanging off CR 11, which is four characters in a
   * marker every other design would have shrunk to fit.
   */
  const { evaluate } = await import('./helpers/expression.mjs');
  const { shieldImageExpression, shieldTextSize, shieldDisplayWidth } =
    await import('../assets/js/lib/route-shields.js');

  const image = shieldImageExpression('WV', {
    length: ['length', ['coalesce', ['get', 'shield_text'], '']],
    network: 'network',
  });
  const at = (network, text) => ({ properties: { network, shield_text: text } });

  assert.equal(evaluate(image, at('US:WV', '16')), 'abmap-shield-st-WV-2',
    'a state route keeps the state marker');
  assert.equal(evaluate(image, at('US:WV:County', '11')), 'abmap-shield-county-2',
    'a county route was drawn as the state square');
  assert.equal(evaluate(image, at('US:WV:County', '11/5')), 'abmap-shield-county-4');

  // `Secondary` is the same idea under a different word, which other states use.
  assert.equal(evaluate(image, at('US:VA:Secondary', '617')), 'abmap-shield-county-3');

  // The nationals must not be caught by a rule about third components.
  assert.equal(evaluate(image, at('US:I', '77')), 'abmap-shield-interstate-2');

  /*
   * And the point of the oval: the marker widens, so the number must not
   * shrink to fit a width it no longer has. Four characters in the round
   * circle come out at 7.8px; here they keep the full size.
   */
  assert.ok(shieldDisplayWidth(4) > shieldDisplayWidth(2), 'the box has to widen for this to mean anything');
  assert.ok(shieldTextSize('county', 4) > shieldTextSize('circle', 4) * 1.5,
    'a fraction in an oval should not be shrunk like one in a circle');
  assert.equal(shieldTextSize('county', 2), shieldTextSize('circle', 2),
    'two characters read the same in both, which is what keeps it looking round');
});

test('layers: a sublayer filter reaches the service that is meant to apply it', async () => {
  /*
   * The failure this exists for is silence.
   *
   * A `where` on a sublayer whose URL has no `{where}` placeholder is
   * substituted into nothing: the request goes out unfiltered, the layer draws
   * everything it was meant to exclude, and there is no error anywhere. That
   * is the shape the MOA bug already had once — the config said in a comment
   * that military operating areas were not drawn, while the query said
   * `where=1=1` and drew 718 of them, 46.6% of the layer.
   *
   * Stated over every layer rather than the one that prompted it, so the next
   * filter added to a URL that cannot carry one fails here instead of on the
   * map.
   */
  const { OVERLAYS } = await import('../assets/js/config.js');

  for (const layer of OVERLAYS) {
    const uses = layer.query?.uses;
    if (!uses) continue;
    for (const kind of uses) {
      if (!kind.where) continue;
      const template = kind.url || layer.query.url || '';
      assert.ok(template.includes('{where}'),
        `${layer.id}/${kind.layer || kind.use} declares a filter its URL cannot carry`);
    }
  }
});

test('layers: military operating areas are excluded from the no-fly layer', async () => {
  /*
   * Pinned, because it is a decision rather than an implementation detail, and
   * because it was a comment describing behaviour the code did not have for as
   * long as the layer has existed.
   *
   * An MOA does not restrict civilian flight. Drawing one in the red this
   * layer reserves for prohibited airspace is not a cosmetic problem: it is
   * the map saying "do not fly here" about somewhere you may fly.
   */
  const { OVERLAYS } = await import('../assets/js/config.js');
  const airspace = OVERLAYS.find((layer) => layer.id === 'faa-restrictions');
  assert.ok(airspace, 'the restrictions layer is gone');

  const sua = airspace.query.uses.find((kind) => kind.layer === 'Special_Use_Airspace');
  assert.ok(sua, 'special-use airspace is no longer a sublayer of the restrictions layer');
  assert.match(sua.where || '', /TYPE_CODE\s*<>\s*'MOA'/,
    'the MOA exclusion is missing, and the comment above it says it is there');
});

test('byways: every let-bound variable is a name GL will accept', async () => {
  /*
   * This one shipped, and shipped past a full green test run.
   *
   * `let` variable names must be alphanumeric or underscore. A hyphen — which
   * is the convention for every other id in this codebase, since they are DOM
   * and image ids — makes GL reject the *whole style* at compile time, so the
   * map does not draw at all. Six deploys failed on `abmap-reflen` while
   * `npm test` stayed green, because the only thing that checks expression
   * validity is `validate:style`, and that needs a dependency this repo does
   * not install locally.
   *
   * So the rule is stated here, where it runs on every commit. It cannot
   * replace the real validator — it knows one rule — but it covers the class
   * that has now cost a day of deploys, and it costs nothing.
   */
  const { bywaysStyle, PROTOMAPS_SCHEMA } = await import('../assets/js/lib/byways-style.js');

  const LEGAL = /^[A-Za-z0-9_]+$/;
  const bad = [];

  const walk = (node, where) => {
    /*
     * Objects as well as arrays. `layer.layout` is an object whose values are
     * the expressions, and a walk that returned on anything not an array
     * inspected nothing at all — this test passed with the broken name still
     * in place, which is how it was caught.
     */
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const value of Object.values(node)) walk(value, where);
      return;
    }
    if (!Array.isArray(node)) return;
    if (node[0] === 'let') {
      // ['let', name, value, name, value, …, body] — the names are every
      // other argument from index 1, stopping before the body.
      for (let i = 1; i + 1 < node.length; i += 2) {
        const name = node[i];
        if (typeof name !== 'string' || !LEGAL.test(name)) bad.push(`${where}: ${JSON.stringify(name)}`);
      }
    }
    for (const child of node) walk(child, where);
  };

  for (const [label, style] of [
    ['mapbox', bywaysStyle('pk.test')],
    ['protomaps', bywaysStyle('pk.test', { schema: PROTOMAPS_SCHEMA, archive: 'https://x/y.pmtiles', maxzoom: 14 })],
  ]) {
    for (const layer of style.layers) {
      for (const group of ['layout', 'paint', 'filter']) {
        walk(layer[group], `${label}/${layer.id}/${group}`);
      }
    }
  }

  assert.deepEqual(bad, [], 'GL will refuse to compile the whole style for these');
});

test('fields: what the config claims to read is separated from what it invents', async () => {
  /*
   * The half of the field check that needs no network, which is also the half
   * that decides whether the other half is useful.
   *
   * Two ways to make it worthless. Counting the tags this app attaches itself
   * — `use`, `severity` — reports one imaginary missing column per layer and
   * buries the real ones. Asking each sublayer separately calls WKHR_CODE dead
   * because it is on the national-defence endpoint and not the special-use
   * one, which would send somebody deleting a row that works. Both were live
   * possibilities; the second nearly happened by hand.
   */
  const { declared, endpoints, injected } = await import('../tools/check-fields.mjs');
  const { OVERLAYS } = await import('../assets/js/config.js');

  const airspace = OVERLAYS.find((layer) => layer.id === 'faa-restrictions');
  assert.ok(airspace);

  const names = declared(airspace);
  assert.ok(names.includes('TYPE_CODE'), 'a field read from the service must be checked');
  assert.ok(names.includes('NAME'), 'the label field is read too, and is as able to be wrong');
  assert.ok(names.includes('WKHR_CODE'), 'a field belonging to one sublayer is still declared');

  // Ours, not the service's.
  assert.ok(injected(airspace).has('severity'), 'a tag the app attaches is not a column');
  assert.ok(!names.includes('severity'), 'the fill field is attached here, so it cannot be missing');
  assert.ok(!names.includes('use'), 'the sublayer marker is attached here too');

  /*
   * Every sublayer, because a field is only dead when no endpoint has it.
   */
  const places = endpoints(airspace);
  assert.equal(places.length, airspace.query.uses.length);
  for (const place of places) {
    assert.ok(!place.url.includes('{layer}'), `${place.name} kept its placeholder`);
    assert.doesNotThrow(() => new URL(place.url), `${place.name} is not a usable address`);
  }

  // A layer with one endpoint and no sublayers still gets checked.
  const single = OVERLAYS.find((layer) => layer.query?.url && !layer.query.uses);
  if (single) assert.equal(endpoints(single).length, 1);
});

test('overlays: a legend never offers a colour the layer cannot draw', () => {
  /*
   * Reported from Dolly Sods: Aloft shows a Caution and this map showed
   * nothing. The airspace layer's legend has offered a 'Permit or caution'
   * amber band since it was written, its fillBy has carried a colour for it,
   * and every sublayer tagged severity 'No fly'. Nothing could produce amber.
   *
   * That is worse than a missing layer. A key that names a category tells a
   * reader the map is looking for it, so ground with no amber on it reads as
   * ground with no advisory on it - which is exactly the wrong thing to
   * conclude over designated wilderness.
   *
   * Stated as the property rather than as a fact about this one layer: where
   * a layer colours by a field its sublayers tag, every colour it offers has
   * to be reachable from some sublayer. That fails on this bug, on a legend
   * entry added ahead of its data, and on a sublayer dropped later leaving an
   * orphaned colour behind.
   */
  let checked = 0;
  for (const overlay of OVERLAYS) {
    const by = overlay.query?.fillBy;
    const uses = overlay.query?.uses;
    if (!by?.colors || !uses?.length) continue;
    // Only layers where the tag is what decides the colour: a layer reading
    // the value out of the data cannot be checked without the data.
    if (!uses.every((kind) => kind.tag && kind.tag[by.field] !== undefined)) continue;
    checked += 1;

    const reachable = new Set(uses.map((kind) => String(kind.tag[by.field])));
    for (const value of Object.keys(by.colors)) {
      assert.ok(reachable.has(value),
        `${overlay.id}: nothing can produce "${value}", which its key offers a colour for`);
    }
    for (const entry of overlay.legend || []) {
      assert.ok(reachable.has(entry.label),
        `${overlay.id}: the key promises "${entry.label}" and no sublayer tags it`);
    }
  }
  assert.ok(checked >= 1, 'no layer exercised this; the shape of the config changed');
});

test('overlays: a label may name every column its services call a name', () => {
  /*
   * One layer, several services, and no agreement about what a name is
   * called: the FAA's three answer NAME, the wilderness service answers
   * `wildernessname` in lower case, because ArcGIS lower-cases field names in
   * GeoJSON output whatever its own displayFieldName says. A single field
   * there leaves every wilderness area unlabelled, which is indistinguishable
   * from a feature that has no name.
   */
  assert.deepEqual(labelExpression('NAME'), ['coalesce', ['get', 'NAME'], '']);
  assert.deepEqual(labelExpression(['NAME', 'wildernessname']),
    ['coalesce', ['get', 'NAME'], ['get', 'wildernessname'], '']);

  for (const overlay of OVERLAYS) {
    const label = overlay.query?.label;
    if (!label) continue;
    const named = [label].flat();
    assert.ok(named.every((one) => typeof one === 'string' && one),
      `${overlay.id}: a label column is not a name`);

    // Every name a config lists is a name the field check will verify.
    assert.deepEqual(declared({ ...overlay, query: { ...overlay.query } })
      .filter((one) => named.includes(one)).sort(), [...named].sort(),
    `${overlay.id}: the field check would not look for every column the label reads`);

    /*
     * And the label names exactly what the services call a name - no more,
     * no less.
     *
     * The first version of this checked only that the listed columns were
     * verified, which passed with the wilderness column removed: the label
     * fell back to NAME, every wilderness area drew unlabelled, and nothing
     * said so. Found by putting the bug back, which is the only reason this
     * paragraph exists.
     *
     * Equality both ways: a missing column leaves a service's features
     * anonymous, and a stale one outlives the sublayer it was added for.
     */
    for (const kind of overlay.query.uses || []) {
      assert.ok(kind.nameField,
        `${overlay.id}: sublayer ${kind.layer || kind.use} does not say which column is its name`);
    }
    if (overlay.query.uses?.length) {
      assert.deepEqual([...new Set(named)].sort(),
        [...new Set(overlay.query.uses.map((kind) => kind.nameField))].sort(),
        `${overlay.id}: the label and the sublayers disagree about the name columns`);
    }
  }
});

test('overlays: a view already covered asks the services nothing', () => {
  /*
   * The FAA's ArcGIS org meters a quota across every service on it, and this
   * map hit it: 6,006 request units against a ceiling of 6,000 per minute,
   * measured. A metered layer that gets emptied by asking too often is worse
   * than a slow one, because an empty airspace layer reads as clear sky.
   *
   * So a fetch covers a padded box and a view inside it asks nothing. Every
   * rule below is a way that shortcut could hide something real, which is why
   * each is asserted rather than assumed.
   */
  const held = { box: [-80, 38, -79, 39], at: 1_000_000, truncated: false };
  const inside = { box: [-79.6, 38.4, -79.4, 38.6] };
  const now = held.at + 1000;

  assert.equal(viewNeedsFetch(held, inside, { now }), false,
    'a view inside what is already held needs no request');

  // Nothing held, and the "held" of a source that was just rebuilt empty.
  assert.equal(viewNeedsFetch(undefined, inside, { now }), true);
  assert.equal(viewNeedsFetch(held, undefined, { now }), true);

  // Outside in each direction on its own, so a sign error in one comparison
  // cannot hide behind three that are right.
  for (const [what, box] of [
    ['west', [-80.5, 38.4, -79.4, 38.6]],
    ['south', [-79.6, 37.5, -79.4, 38.6]],
    ['east', [-79.6, 38.4, -78.5, 38.6]],
    ['north', [-79.6, 38.4, -79.4, 39.5]],
  ]) {
    assert.equal(viewNeedsFetch(held, { box }, { now }), true,
      `a view past the ${what} edge of what is held needs a request`);
  }

  /*
   * Age. These are live restrictions - a temporary flight restriction that
   * came up ten minutes ago is exactly the one worth seeing - so what is held
   * goes stale on a clock rather than lasting the session.
   */
  assert.equal(viewNeedsFetch(held, inside, { now: held.at + 4 * 60 * 1000 }), false);
  assert.equal(viewNeedsFetch(held, inside, { now: held.at + 6 * 60 * 1000 }), true);

  /*
   * And a truncated answer is never treated as settled. Every one of these
   * URLs caps at 300 records; a full page means there was more, so what is
   * held is a partial picture and its gaps look exactly like open ground.
   * Zooming into it must ask again rather than trusting the holes.
   */
  assert.equal(viewNeedsFetch({ ...held, truncated: true }, inside, { now }), true,
    'a capped answer is a partial one and must not be reused');
});

test('pages: an editable section that is its own body is not replaced by itself', () => {
  /*
   * `querySelector` searches descendants only. A section whose whole content
   * is its prose - one paragraph marked editable - matches
   * [data-editable-body] itself and nothing under it, so a lookup that only
   * searched downwards found nothing, fell through to the "keep the h2,
   * replace everything else" path, and emptied the element it was meant to
   * fill. Written after nearly shipping exactly that on the home page's lede.
   *
   * The stub is the smallest thing the two functions actually touch. A real
   * DOM here would be a dependency this repo does not have, and `npm test`
   * running with nothing installed is the point.
   */
  const node = (attrs = {}, children = []) => ({
    attrs,
    children,
    innerHTML: '',
    matches(selector) { return selector === '[data-editable-body]' && 'data-editable-body' in this.attrs; },
    querySelector(selector) {
      const hit = (one) => (selector === '[data-editable-body]'
        ? 'data-editable-body' in one.attrs
        : one.attrs.class === selector.replace('.', '') || one.attrs.tag === selector);
      for (const child of this.children) {
        if (hit(child)) return child;
        const deeper = child.querySelector?.(selector);
        if (deeper) return deeper;
      }
      return null;
    },
  });

  const itsOwnBody = node({ 'data-editable': 'lede', 'data-editable-body': '' });
  assert.equal(bodyOf(itsOwnBody), itsOwnBody, 'a section that is its own body has to find itself');
  applySaved(itsOwnBody, '<b>saved</b>');
  assert.equal(itsOwnBody.innerHTML, '<b>saved</b>', 'and be filled rather than emptied');

  // The nested shape still resolves to the child, not the section.
  const inner = node({ 'data-editable-body': '' });
  const wrapped = node({ 'data-editable': 'roadmap' }, [node({ tag: 'h2' }), inner]);
  assert.equal(bodyOf(wrapped), inner);
  applySaved(wrapped, '<i>x</i>');
  assert.equal(inner.innerHTML, '<i>x</i>');
  assert.equal(wrapped.innerHTML, '', 'the section keeps its layout; only the body changes');
});
