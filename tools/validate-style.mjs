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
import { bywaysStyle } from '../assets/js/lib/byways-style.js';
import { runtimeLayers, runtimeSources } from '../assets/js/lib/runtime-layers.js';
import { buildRasterStyle, styleHasGlyphs } from '../assets/js/lib/engine.js';

const require = createRequire(import.meta.url);

let validate;
let expression;
try {
  ({ validate, expression } = require('@mapbox/mapbox-gl-style-spec'));
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

if (all.length) {
  console.error(`\n${all.length} validation error(s):`);
  for (const [where, error] of all) console.error(`  [${where}] ${error.message}`);
  process.exit(1);
}

console.log(`Shields — 23-60 splits into ${evaluate(layerBy('road-shield-first').layout['text-field'], DUPLEX)} and ${evaluate(layerBy('road-shield-second').layout['text-field'], DUPLEX)}`);
console.log('Valid.');
