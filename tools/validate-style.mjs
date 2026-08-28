/**
 * Validate the Byways Topo style against the official Mapbox style spec.
 *
 * Kept out of `npm test` on purpose: the test suite runs with nothing
 * installed, and that property is worth more than folding this in. Run it
 * after touching byways-style.js:
 *
 *   npm install --no-save @mapbox/mapbox-gl-style-spec && node tools/validate-style.mjs
 *
 * It matters because Mapbox GL does not degrade on an invalid style — it
 * aborts loading and renders nothing, having already reported success. A blank
 * map with no console error is what a single bad property looks like.
 */

import { createRequire } from 'node:module';
import { bywaysStyle, shieldLayerUpdates, PROTOMAPS_SCHEMA } from '../assets/js/lib/byways-style.js';
import { runtimeLayers, runtimeSources } from '../assets/js/lib/runtime-layers.js';
import { buildRasterStyle, styleHasGlyphs } from '../assets/js/lib/engine.js';
import { OVERLAYS, STATE_GROUP } from '../assets/js/config.js';

const require = createRequire(import.meta.url);

let validate;
let expression;
let styleSpec;
try {
  ({ validate, expression, v8: styleSpec } = require('@mapbox/mapbox-gl-style-spec'));
} catch {
  console.error('@mapbox/mapbox-gl-style-spec is not installed.');
  console.error('Run: npm install --no-save @mapbox/mapbox-gl-style-spec');
  process.exit(2);
}

const style = bywaysStyle('pk.example');
const errors = validate(style);

console.log(`Byways Topo — ${style.layers.length} layers, ${Object.keys(style.sources).length} sources`);

/*
 * The layers the viewer adds at runtime — pins, tracks, region outlines, light
 * bearings, storm tracks — validated against the styles they are actually
 * added to.
 *
 * The first version of this check built a synthetic host style and, when the
 * symbol layers failed for want of a glyphs URL, added one to the host so they
 * would pass. That is backwards: the raster basemap style has no glyphs, the
 * real failure was exactly there, and bolting the missing property onto the
 * harness is how a validator ends up certifying the bug it exists to catch.
 * The host styles here are the real ones, unmodified.
 */
const withRuntime = (base, labels) => ({
  ...base,
  sources: {
    ...base.sources,
    ...Object.fromEntries(runtimeSources().map((name) => [
      name, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    ])),
  },
  layers: [...base.layers, ...runtimeLayers({ labels })],
});

const rasterBasemap = {
  tiles: ['https://example.com/{z}/{x}/{y}.png'],
  tileSize: 256,
  attribution: 'test',
};

const hosts = [
  ['Byways Topo + runtime', withRuntime(style, true)],
  ['raster basemap + runtime', withRuntime(buildRasterStyle(rasterBasemap), styleHasGlyphs(buildRasterStyle(rasterBasemap)))],
];

console.log(`Runtime layers — ${runtimeLayers().length} added by the viewer`);

const all = errors.map((error) => ['Byways Topo', error]);
for (const [name, host] of hosts) {
  for (const error of validate(host)) all.push([name, error]);
}

/*
 * The same cartography over Protomaps geometry.
 *
 * This is the half that has never been rendered by anybody, so it is the half
 * a validator is worth most on. Three things are checked and they are
 * different questions: that the document is valid at all, that no layer points
 * at a source-layer the schema says does not exist, and that the road
 * hierarchy came through with its eleven weights rather than collapsing.
 *
 * The third is the one that matters and the one a spec validator cannot see. A
 * filter naming a class that never occurs in the tiles is perfectly valid and
 * draws nothing; the difference between eleven road weights and five is the
 * difference between an atlas you read at speed and one you squint at, and it
 * would show up as "the map looks flat" rather than as an error.
 */
const protomaps = bywaysStyle('', {
  schema: PROTOMAPS_SCHEMA,
  archive: 'https://example.test/byways.pmtiles',
  maxzoom: 15,
});
console.log(`Byways Topo (Protomaps) — ${protomaps.layers.length} layers, ${Object.keys(protomaps.sources).length} source`);

for (const error of validate(withRuntime(protomaps, true))) all.push(['Protomaps', error]);

const declared = new Set(Object.values(PROTOMAPS_SCHEMA.layers).filter(Boolean));
for (const layer of protomaps.layers) {
  if (layer.type === 'background') continue;
  if (!protomaps.sources[layer.source]) {
    all.push(['Protomaps', { message: `${layer.id} reads source ${layer.source}, which the style does not declare` }]);
  }
  const sourceLayer = layer['source-layer'];
  if (!sourceLayer) {
    all.push(['Protomaps', { message: `${layer.id} has no source-layer; it should have been dropped, not shipped blank` }]);
  } else if (!declared.has(sourceLayer)) {
    all.push(['Protomaps', { message: `${layer.id} reads source-layer ${sourceLayer}, which the schema does not name` }]);
  }
}

/*
 * Every road class the schema maps is actually asked for by some layer, and
 * every class a layer asks for is one the schema maps.
 *
 * Both directions, because they catch opposite mistakes. A class in the schema
 * that no layer draws is a road type that vanishes from the map; a class a
 * layer draws that the schema never maps is a filter matching a value the
 * tiles do not contain, which is the same vanishing with the blame in a
 * different file.
 */
{
  const mapped = new Set([
    ...Object.values(PROTOMAPS_SCHEMA.roadClasses),
    ...Object.values(PROTOMAPS_SCHEMA.roadLinks),
  ]);
  const asked = new Set();
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    const [head, field] = node;
    const readsClass = Array.isArray(field)
      && field[0] === 'get' && field[1] === PROTOMAPS_SCHEMA.fields.roadClassField;
    if (head === 'match' && readsClass) {
      for (const branch of node.slice(2)) {
        for (const value of [branch].flat()) if (typeof value === 'string') asked.add(value);
      }
    }
    for (const child of node) walk(child);
  };
  for (const layer of protomaps.layers) {
    if (layer['source-layer'] !== PROTOMAPS_SCHEMA.layers.road) continue;
    walk(layer.filter);
    for (const value of Object.values(layer.paint || {})) walk(value);
    for (const value of Object.values(layer.layout || {})) walk(value);
  }
  for (const value of mapped) {
    if (!asked.has(value)) all.push(['Protomaps', { message: `no road layer draws "${value}", so that class is invisible` }]);
  }
  if (Object.keys(PROTOMAPS_SCHEMA.roadLinks).length !== 5) {
    all.push(['Protomaps', { message: 'the ramp classes are not the five the road hierarchy has' }]);
  }
  for (const value of asked) {
    if (!mapped.has(value)) all.push(['Protomaps', { message: `a road layer filters on "${value}", which the schema never maps — it will match nothing` }]);
  }
  const weights = new Set(Object.values(PROTOMAPS_SCHEMA.roadClasses));
  if (weights.size !== 11) {
    all.push(['Protomaps', { message: `the road hierarchy has ${weights.size} weights, not the eleven the map is drawn for` }]);
  }
}

/*
 * The same check, for every field that is not the road class.
 *
 * The road version found seven hardcoded values and stopped there, because
 * roads were where the work was. Everything else classifies through the same
 * `classField`, and three layers still carried Mapbox's vocabulary - the
 * landcover ramp, the landuse fill and the place-label sizing. Those are the
 * ground the map is drawn on and the names on it: matching nothing means a
 * uniform green country with every town's name the same size, which reads as
 * a design decision rather than as a bug.
 *
 * The schema names each set, so the test is that every value a layer asks for
 * comes from one of them.
 */
{
  const known = new Set([
    ...PROTOMAPS_SCHEMA.landcoverClasses || [],
    ...PROTOMAPS_SCHEMA.landuseClasses || [],
    ...PROTOMAPS_SCHEMA.protectedClasses || [],
    ...PROTOMAPS_SCHEMA.waterClasses || [],
    ...PROTOMAPS_SCHEMA.summitClasses || [],
    ...PROTOMAPS_SCHEMA.placeClasses || [],
  ]);
  const field = PROTOMAPS_SCHEMA.fields.classField;
  const asked = new Map();
  const walk = (node, id) => {
    if (!Array.isArray(node)) return;
    const reads = Array.isArray(node[1]) && node[1][0] === 'get' && node[1][1] === field;
    if ((node[0] === 'match' || node[0] === '==') && reads) {
      for (const value of node.slice(2).flat()) {
        // Colours and sizes sit in the same arms as the values they answer for.
        if (typeof value === 'string' && !value.startsWith('#')) asked.set(value, id);
      }
    }
    for (const child of node) walk(child, id);
  };
  for (const layer of protomaps.layers) {
    if (layer['source-layer'] === PROTOMAPS_SCHEMA.layers.road) continue;
    walk(layer.filter, layer.id);
    for (const value of Object.values(layer.paint || {})) walk(value, layer.id);
    for (const value of Object.values(layer.layout || {})) walk(value, layer.id);
  }
  for (const [value, id] of asked) {
    if (!known.has(value)) {
      all.push(['Protomaps', { message: `${id} filters on "${value}", which the schema never names — it will match nothing` }]);
    }
  }
}

// And the archive is addressed through the protocol, not fetched as a tile.
{
  const source = protomaps.sources[PROTOMAPS_SCHEMA.source];
  if (!source?.tiles?.[0]?.startsWith('pmtiles://')) {
    all.push(['Protomaps', { message: `the archive is addressed as ${JSON.stringify(source?.tiles?.[0] ?? source?.url)}, which nothing will resolve` }]);
  }
}

// An unconfigured archive is refused rather than built into a blank map.
if (bywaysStyle('', { schema: PROTOMAPS_SCHEMA }) !== null) {
  all.push(['Protomaps', { message: 'a style was built with no archive to read, which would load, succeed and draw nothing' }]);
}

/*
 * A valid expression is not a correct one. The concurrency split is the case
 * where that gap bites: "23-60" has to come apart into two shields reading 23
 * and 60, and every operator in that chain — index-of, slice, let/var — is one
 * the spec will happily accept doing the wrong thing. So it is evaluated here
 * against a feature shaped like the ones Mapbox Streets actually sends.
 */
const DUPLEX = { properties: { ref: '23-60', shield: 'us-highway-duplex', reflen: 5, class: 'primary' } };
const TRIPLE = { properties: { ref: '23-60-119', shield: 'us-highway-duplex', reflen: 9, class: 'primary' } };
const SINGLE = { properties: { ref: '40', shield: 'us-interstate', reflen: 2, class: 'motorway' } };

const evaluate = (raw, feature, type = 'string') => {
  const compiled = expression.createExpression(raw, { type });
  if (compiled.result !== 'success') {
    console.error(`\nExpression did not compile: ${compiled.value.map((e) => e.message).join(', ')}`);
    process.exit(1);
  }
  return compiled.value.evaluate({ zoom: 12 }, feature);
};

const layerBy = (id) => style.layers.find((layer) => layer.id === id);
const expectations = [
  ['first shield reads 23', evaluate(layerBy('road-shield-first').layout['text-field'], DUPLEX), '23'],
  ['second shield reads 60', evaluate(layerBy('road-shield-second').layout['text-field'], DUPLEX), '60'],
  ['a third route does not run into the second',
    evaluate(layerBy('road-shield-second').layout['text-field'], TRIPLE), '60'],
  ['each half is sized for its own number, not the pair',
    evaluate(layerBy('road-shield-first').layout['icon-image'], DUPLEX), 'abmap-shield-us-2'],
];

for (const [label, actual, expected] of expectations) {
  if (actual !== expected) all.push(['shields', { message: `${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}` }]);
}

/*
 * The number on the shield is a number.
 *
 * Tiles hand us the raw OSM ref and most states put the system in it — "SR 61",
 * "KY 15" — so the marker read "SR 61" inside a state-route blank, which is a
 * sign that exists nowhere. Checked by evaluating the real expression against
 * the refs that actually come out of the tiles, because "it compiles" and "it
 * says 61" are different claims.
 */
const shieldText = layerBy('road-shield').layout['text-field'];
const shieldImage = layerBy('road-shield').layout['icon-image'];
const REFS = [
  ['SR 61', '61', 'a state route keeps its number and loses its system'],
  ['US 27', '27', 'so does a US route'],
  ['I 40', '40', 'and an interstate'],
  ['KY 15', '15', 'whichever state issued it'],
  ['CR 1234', '1234', 'and however long the number is'],
  ['FM 1960', '1960', 'including the ones only one state uses'],
  ['61', '61', 'a bare number is already the answer'],
  ['Loop 1', 'Loop 1', 'a road named across two words keeps both — that is a name, not a system'],
  ['Old 61', 'Old 61', 'a name leading with a short word survives, because upcasing Old changes it'],
  ['SR', 'SR', 'a prefix with nothing after it is all there is, so it stays'],
  /*
   * The banner designations. On the road these are a separate plate above the
   * marker and the marker itself carries only the number, so the shield drops
   * them - and "Old 61" is here to hold the line between a designation that
   * qualifies a route and a word that is part of its name.
   */
  ['US 40 Scenic', '40', 'the scenic designation rides on a banner, not in the shield'],
  ['US 68 Business', '68', 'and so does business'],
  ['US 50 Alternate', '50', 'and alternate'],
  ['SR 26 Bypass', '26', 'and bypass'],
  ['US 61 Truck', '61', 'and truck'],
  ['Old 61 Scenic', 'Old 61', 'the suffix goes and the Old stays, because it is part of the name'],
  ['US 40 Spur', '40', 'and spur'],
  ['KY 80 East', '80 East', 'the prefix goes as always; the direction stays, not being a designation'],
  ['', '', 'and nothing is nothing'],

  /*
   * Forest roads, which is why the length rule became a capitals rule.
   *
   * FSR is three characters, so the old "one or two" limit kept it and the
   * shield read FSR 300 - a name where a number belongs. These hold the new
   * line: a system is written in capitals, a name is not, and a number is
   * neither.
   */
  ['FSR 300', '300', 'a forest road drops its system, which is three letters long'],
  ['NF-9', '9', 'and does so across a hyphen, which is how the other half are signed'],
  ['CR 1230', '1230', 'so does a county road'],
  ['Old 61', 'Old 61', 'but Old is a name, and upcasing it would change it'],
  ['Bear Creek', 'Bear Creek', 'a road named across two words keeps both'],
  ['300 Spur', '300', 'a number leading is not a system - the Spur suffix goes, the 300 stays'],
];
for (const [ref, want, why] of REFS) {
  const got = evaluate(shieldText, { properties: { ref, shield: 'default', class: 'primary' } });
  if (String(got) !== want) {
    all.push(['shields', { message: `"${ref}" drew "${got}", expected "${want}" — ${why}` }]);
  }
}

// And the blank is sized for the number it holds, not for the raw ref: a
// stripped "SR 61" asking for a four-wide sign leaves two digits adrift in it.
const blank = evaluate(shieldImage, { properties: { ref: 'SR 61', shield: 'default', reflen: 5, class: 'primary' } });
if (!String(blank).endsWith('-2')) {
  all.push(['shields', { message: `"SR 61" asked for ${blank}, expected a two-character blank` }]);
}

/*
 * A long number is drawn small enough to stay inside its blank.
 *
 * Every shield layer used to ask for two-character text whatever the number
 * was, so "21/2" — a West Virginia secondary route — was drawn at the size of
 * "21" and ran outside the circle. `shieldTextSize` had always shrunk with
 * length; nothing was telling it the length.
 */
const shieldSize = layerBy('road-shield').layout['text-size'];
const sizeOf = (ref) => evaluate(shieldSize, { properties: { ref, shield: 'circle-white', class: 'secondary' } }, 'number');
const sizes = ['61', '250', '21/2', '250/88'].map(sizeOf);
for (let i = 1; i < sizes.length; i += 1) {
  if (!(sizes[i] <= sizes[i - 1])) {
    all.push(['shields', { message: `a longer number was drawn larger: ${JSON.stringify(sizes)}` }]);
    break;
  }
}
if (!(sizes[3] < sizes[0])) {
  all.push(['shields', { message: `"250/88" is drawn at ${sizes[3]} and "61" at ${sizes[0]} — the long one must be smaller` }]);
}

/*
 * A signed state route keeps the state's marker; an unsigned county road does not.
 *
 * Probed two miles apart in Leelanau County, Michigan:
 *
 *   M-22          ref=22   shield=circle-white  shield_image=us-state-diamond-2
 *   county road   ref=641  shield=default       shield_image=default-3
 *
 * So the data does tell them apart, and this is the check that it keeps
 * telling them apart — sending `default` to the state's own marker is how a
 * county road came to be drawn on Michigan's M.
 */
/*
 * Through `shieldLayerUpdates`, which is the path a state actually arrives by.
 * `bywaysStyle` takes only a token — the style is built stateless and the
 * marker is applied when the map settles over a state.
 */
const shieldFor = (shield, state) => evaluate(
  shieldLayerUpdates(state).find((entry) => entry.id === 'road-shield').layout['icon-image'],
  { properties: { ref: '22', shield, class: 'primary' } },
);
for (const state of ['MI', 'TN', 'WV', '']) {
  const signed = String(shieldFor('circle-white', state));
  const unsigned = String(shieldFor('default', state));
  if (unsigned === signed) {
    all.push(['shields', { message: `in ${state || 'no state'} a county road and a state route both drew ${signed}` }]);
  }
  if (!unsigned.includes('circle')) {
    all.push(['shields', { message: `in ${state || 'no state'} an unsigned road drew ${unsigned}, expected the circle` }]);
  }
}
// And a state with a marker of its own still uses it for a signed route.
const michigan = String(shieldFor('circle-white', 'MI'));
if (!michigan.includes('st-MI')) {
  all.push(['shields', { message: `M-22 drew ${michigan}, expected Michigan's own marker` }]);
}

// The combined shield must stand down where the pair takes over, or the road
// carries three markers.
const filters = {
  'road-shield': false,
  'road-shield-first': true,
  'road-shield-second': true,
};
for (const [id, wanted] of Object.entries(filters)) {
  for (const [feature, name] of [[DUPLEX, 'a concurrency'], [SINGLE, 'a single route']]) {
    const drawn = evaluate(layerBy(id).filter, feature, 'boolean');
    const should = feature === DUPLEX ? wanted : !wanted;
    if (drawn !== should) {
      all.push(['shields', { message: `${id} ${drawn ? 'draws' : 'skips'} ${name}, expected the opposite` }]);
    }
  }
}

/*
 * The paint expressions the viewer builds for a queried overlay.
 *
 * These are assembled in viewer.js at runtime and never reach the style
 * document, so nothing here has ever looked at them - which is how a casing
 * width of ['*', <interpolate on zoom>, 1.9] shipped. The spec forbids it: a
 * zoom expression may only be the top-level input to step or interpolate.
 * addLayer threw, the function aborted before adding the core line, and all
 * eight road layers drew nothing.
 *
 * The widths are duplicated from viewer.js rather than imported, because
 * viewer.js expects a browser. Duplication is the cost of checking them at
 * all, and the stops are the part that has to stay in step.
 */
const roadWidth = (scale) => ['interpolate', ['linear'], ['zoom'],
  8, 0.9 * scale, 11, 1.6 * scale, 13, 2.6 * scale, 15, 4.2 * scale, 17, 6.5 * scale];
const NUMBER = { type: 'number', 'property-type': 'data-driven', expression: { interpolated: true, parameters: ['zoom', 'feature'] } };
const runtimeExpressions = {
  'road casing width': [roadWidth(1.9), NUMBER],
  'road core width': [roadWidth(1), NUMBER],
  'site icon size': [['interpolate', ['linear'], ['zoom'], 8, 0.55, 13, 0.85, 16, 1], NUMBER],
  'dot radius': [['interpolate', ['linear'], ['zoom'], 7, 2.5, 12, 5, 16, 7], NUMBER],
  // The trail widths, which are the same curve at a smaller scale. Baked into
  // the stops for the reason the casing had to be: a zoom expression cannot be
  // an argument to anything.
  'trail casing width': [roadWidth(1.5), NUMBER],
  'trail core width': [roadWidth(0.62), NUMBER],
};
for (const [what, [value, spec]] of Object.entries(runtimeExpressions)) {
  const compiled = expression.createPropertyExpression(value, spec);
  if (compiled.result !== 'success') {
    for (const error of compiled.value) all.push(['runtime', { message: `${what}: ${error.message}` }]);
  }
}

/*
 * Every fillBy actually picks its colour.
 *
 * The viewer builds one `match` per fillBy, and a `match` compares like with
 * like. Object keys are strings, so a fillBy over a numeric column - the FAA
 * grid's CEILING - compiled perfectly and evaluated to the fallback for every
 * single feature. Nothing in a compile check can see that: the expression is
 * valid, it just answers the wrong colour.
 *
 * So this evaluates it, against a feature carrying the value the service really
 * sends, and insists on the colour the config asked for.
 */
const fillByOverlays = [...OVERLAYS, ...(STATE_GROUP?.overlays || STATE_GROUP || [])]
  .filter((overlay) => overlay?.query?.fillBy);
for (const overlay of fillByOverlays) {
  const by = overlay.query.fillBy;
  const colour = overlay.query.color;
  const tint = ['match', ['coalesce', ['to-string', ['get', by.field]], ''],
    ...Object.entries(by.colors).flatMap(([value, hex]) => [value, hex]), by.fallback || colour];
  for (const [value, hex] of Object.entries(by.colors)) {
    // The service sends a number as a number; JSON.parse gives it back as one
    // when the key is numeric, and as the original string when it is not.
    const raw = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
    const got = evaluate(tint, { properties: { [by.field]: raw } }, 'color');
    const rgb = got && typeof got === 'object' ? got.toString() : String(got);
    const want = expression.createExpression(hex, { type: 'color' });
    const wantRgb = want.result === 'success'
      ? want.value.evaluate({ zoom: 12 }, {}).toString() : hex;
    if (rgb !== wantRgb) {
      all.push(['fillBy', { message: `${overlay.id}: ${by.field}=${JSON.stringify(raw)} painted ${rgb}, expected ${wantRgb} (${hex})` }]);
    }
  }
}

/*
 * A hatched fillBy compiles as a fill-pattern.
 *
 * fill-pattern takes an image name, and a `match` returning the wrong type is
 * rejected at addLayer - which in this app means the try/catch swallows it and
 * the layer is simply missing its fill. Compiled against the real spec so that
 * failure is a build error rather than an empty area on a map about where you
 * may not fly.
 *
 * What this can and cannot see, stated plainly: it catches a branch of the
 * wrong type and an input that was not coerced, both confirmed by breaking
 * them. It cannot tell whether the image names correspond to patterns that
 * were actually registered - nothing static can, since they are drawn on a
 * canvas at runtime. That half is covered by the fallback in the viewer, which
 * reverts to a flat tint unless every pattern registered.
 */
for (const overlay of fillByOverlays.filter((entry) => entry.query.fillBy.hatch)) {
  const by = overlay.query.fillBy;
  // Image names stand in for what hatchPattern registers at runtime; the shape
  // of the expression is what is under test, not the canvas it draws.
  const pattern = ['match', ['coalesce', ['to-string', ['get', by.field]], ''],
    ...Object.entries(by.colors).flatMap(([value, hex]) => [value, `hatch-${hex.replace('#', '')}`]),
    `hatch-${String(by.fallback).replace('#', '')}`];
  const compiled = expression.createPropertyExpression(pattern, styleSpec.paint_fill['fill-pattern']);
  if (compiled.result !== 'success') {
    for (const error of compiled.value) all.push(['hatch', { message: `${overlay.id}: ${error.message}` }]);
  }
}

/*
 * The brown shields go on the roads that asked for them, and nowhere else.
 *
 * These two designs are chosen by the ref rather than by Mapbox's `shield`,
 * which means an ordinary road can be dragged into them by a sloppy rule -
 * "Forest Hill Road" leading with FH, say. Evaluated against real refs in both
 * directions: the ones that should be brown, and the ones that must not be.
 */
{
  const shieldLayer = layerBy('road-shield');
  const image = shieldLayer.layout['icon-image'];
  const colour = shieldLayer.paint['text-color'];
  const feature = (ref, shield = 'default') => ({ properties: { ref, shield, reflen: ref.length, class: 'primary' } });

  const cases = [
    /*
     * The width suffix is the length of the text that ends up drawn, clamped
     * to 2..4 - not the length of the ref. "Old 61 Scenic" draws "Old 61",
     * which is six characters and so asks for the widest blank.
     */
    ['FSR 300', 'us-state', 'abmap-shield-forest-3', '#ffffff', 'a forest road gets the trapezoid and white numerals'],
    ['NF-9', 'us-state', 'abmap-shield-forest-2', '#ffffff', 'and so does one signed across a hyphen'],
    ['US 40 Scenic', 'us-highway', 'abmap-shield-scenic-2', '#ffffff', 'a scenic route gets the brown shield'],
    ['Old 61 Scenic', 'default', 'abmap-shield-scenic-4', '#ffffff', 'even when its number is a name — Scenic is what decides'],
    // The other direction, which is the half that catches an over-eager rule.
    ['US 40', 'us-highway', 'abmap-shield-us-2', '#1c1c1c', 'a plain US route keeps the white US shield'],
    ['CR 1230', 'default', 'abmap-shield-circle-4', '#1c1c1c', 'a county road is not a forest road'],
    ['Forest Hill Road', 'default', 'abmap-shield-circle-4', '#1c1c1c', 'a road merely named Forest is not one either'],
    ['FR Bend', 'default', 'abmap-shield-forest-4', '#ffffff', 'FR is a forest system whatever follows it'],
  ];

  for (const [ref, shield, wantImage, wantColour, why] of cases) {
    const gotImage = evaluate(image, feature(ref, shield));
    if (String(gotImage) !== wantImage) {
      all.push(['ref-shields', { message: `"${ref}" drew ${gotImage}, expected ${wantImage} — ${why}` }]);
    }
    const gotColour = evaluate(colour, feature(ref, shield), 'color');
    const want = expression.createExpression(wantColour, { type: 'color' });
    const wantRGB = want.result === 'success' ? want.value.evaluate({ zoom: 12 }, {}).toString() : wantColour;
    if (String(gotColour) !== wantRGB) {
      all.push(['ref-shields', { message: `"${ref}" wrote ${gotColour}, expected ${wantRGB} — ${why}` }]);
    }
  }
}

if (all.length) {
  console.error(`\n${all.length} validation error(s):`);
  for (const [where, error] of all) console.error(`  [${where}] ${error.message}`);
  process.exit(1);
}

console.log(`Shields — 23-60 splits into ${evaluate(layerBy('road-shield-first').layout['text-field'], DUPLEX)} and ${evaluate(layerBy('road-shield-second').layout['text-field'], DUPLEX)}`);
console.log(`Runtime paint — ${Object.keys(runtimeExpressions).length} overlay expressions compile`);
console.log(`fillBy — ${fillByOverlays.length} layers pick the colour they asked for`);
console.log(`Hatching — ${fillByOverlays.filter((e) => e.query.fillBy.hatch).length} layer(s) compile as a fill-pattern`);
console.log('Valid.');
