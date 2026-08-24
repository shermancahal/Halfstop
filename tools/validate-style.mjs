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
import { runtimeLayers } from '../assets/js/lib/runtime-layers.js';

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
 * bearings, storm tracks — never went through here, and that gap cost a
 * feature.
 *
 * `line-dasharray` is not a data-driven property. Giving it a `case` on a
 * feature flag is invalid, and GL's response is to reject the layer at
 * addLayer time. The light-direction lines therefore drew their white casing
 * and nothing else, which reads as "the lines are not coloured" rather than as
 * an error, because there is no error — just a layer that never arrived.
 *
 * These are validated inside a minimal host style so the spec has sources to
 * resolve against.
 */
const runtime = runtimeLayers();
const host = {
  version: 8,
  // The real style carries these; the host needs them so symbol layers with a
  // text-field validate against something rather than failing on the harness.
  glyphs: 'https://example.com/fonts/{fontstack}/{range}.pbf',
  sprite: 'https://example.com/sprite',
  sources: Object.fromEntries(
    [...new Set(runtime.map((layer) => layer.source).filter(Boolean))]
      .map((name) => [name, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }]),
  ),
  layers: runtime,
};
const runtimeErrors = validate(host);

console.log(`Runtime layers — ${runtime.length} added by the viewer`);

const all = [
  ...errors.map((error) => ['Byways Topo', error]),
  ...runtimeErrors.map((error) => ['runtime', error]),
];

if (all.length) {
  console.error(`\n${all.length} validation error(s):`);
  for (const [where, error] of all) console.error(`  [${where}] ${error.message}`);
  process.exit(1);
}

console.log('Valid.');
