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
try {
  ({ validate } = require('@mapbox/mapbox-gl-style-spec'));
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

if (all.length) {
  console.error(`\n${all.length} validation error(s):`);
  for (const [where, error] of all) console.error(`  [${where}] ${error.message}`);
  process.exit(1);
}

console.log('Valid.');
