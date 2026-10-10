/**
 * The layers read by colour, and the bar their scale is drawn as.
 *
 * Asked for as "for anything with a color scale (weather, light pollution or
 * Bortle), put the scale along the bottom". The catalogue decides which layers
 * those are, so the checks here are on the catalogue as much as on the
 * functions that draw from it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { OVERLAYS, BASEMAPS } from '../assets/js/config.js';
import {
  scaleFor, scaleTicks, rampGradient, stepLabel, needsGlossary,
} from '../assets/js/lib/color-scale.js';
import { sourceNoteFor } from '../assets/js/lib/engine.js';

const byId = (id) => OVERLAYS.find((entry) => entry.id === id);

test('color scale: the layers named in the request all carry one', () => {
  for (const id of [
    'light-pollution', 'sky-brightness', 'radar',
    'weather-sky', 'weather-temp', 'weather-wind', 'weather-rain-chance', 'weather-snowfall',
    'snow-depth',
  ]) {
    const entry = byId(id);
    assert.ok(entry, `${id} is in the catalogue`);
    assert.ok(scaleFor(entry), `${id} has a colour scale`);
    assert.ok(entry.scaleUnit, `${id} says what its scale measures`);
  }
});

test('color scale: a key of categories is not drawn as a bar', () => {
  // Public lands has colours, and BLM is not "more" than the Forest Service.
  // A bar would claim an order the colours do not have.
  assert.equal(scaleFor(byId('public-lands')), null);
  assert.equal(scaleFor(byId('faa-restrictions')), null);
  // And a layer with no key at all has no scale either.
  assert.equal(scaleFor(byId('usgs-contours')), null);
  assert.equal(scaleFor(null), null);
  // No basemap is read by colour.
  for (const entry of BASEMAPS) assert.equal(scaleFor(entry), null, entry.id);
});

test('color scale: each kind of key becomes the matching kind of scale', () => {
  assert.equal(scaleFor(byId('weather-temp')).kind, 'service');
  assert.match(scaleFor(byId('weather-temp')).url, /GetLegendGraphic/);
  assert.equal(scaleFor(byId('snow-depth')).kind, 'arcgis');
  assert.equal(scaleFor(byId('snow-depth')).layer, 3);
  assert.equal(scaleFor(byId('light-pollution')).kind, 'ramp');
  assert.equal(scaleFor(byId('sky-brightness')).kind, 'steps');
  assert.equal(scaleFor(byId('sky-brightness')).steps.length, 6);
});

test('color scale: the scale is a copy, so drawing it cannot edit the catalogue', () => {
  const scale = scaleFor(byId('sky-brightness'));
  scale.steps[0].label = 'changed';
  assert.notEqual(byId('sky-brightness').legend[0].label, 'changed');
});

test('color scale: both ends of a long ramp are always labelled', () => {
  assert.deepEqual(scaleTicks(0), []);
  assert.deepEqual(scaleTicks(1), [0]);
  assert.deepEqual(scaleTicks(2), [0, 1]);
  assert.deepEqual(scaleTicks(3, 5), [0, 1, 2]);
  const ticks = scaleTicks(24, 5);
  assert.equal(ticks.length, 5);
  assert.equal(ticks[0], 0);
  assert.equal(ticks.at(-1), 23);
  // Ascending and unique, so labels never sit on top of each other.
  assert.deepEqual([...ticks].sort((a, b) => a - b), ticks);
  assert.equal(new Set(ticks).size, ticks.length);
  // Never more labels than asked for, however long the ramp.
  assert.ok(scaleTicks(200, 4).length <= 4);
  // Nonsense in, nothing thrown.
  assert.deepEqual(scaleTicks('x'), []);
});

test('color scale: a ramp is a left-to-right gradient through its colours', () => {
  assert.equal(rampGradient(['#000', '#fff']), 'linear-gradient(to right, #000, #fff)');
  assert.equal(rampGradient(['#123']), '#123');
  assert.equal(rampGradient([]), 'transparent');
  assert.match(rampGradient(byId('light-pollution').legendRamp.colors), /^linear-gradient/);
});

test('color scale: Bortle shows its class under the bar and its meaning beside it', () => {
  const steps = scaleFor(byId('sky-brightness')).steps;
  assert.deepEqual(steps.map(stepLabel), ['1–2', '3', '4', '5', '6–7', '8–9']);
  assert.equal(needsGlossary(steps), true);
  // Radar's words fit the bar as they are, bar one — so no glossary for it
  // beyond the step that was shortened.
  const radar = scaleFor(byId('radar')).steps;
  assert.equal(stepLabel(radar.at(-1)), 'Intense');
  assert.equal(needsGlossary([{ label: 'Light' }, { label: 'Heavy' }]), false);
  assert.equal(needsGlossary([{ label: 'Light', short: 'Light' }]), false);
});

test('Byways Topo (Mapbox): the help text reads as asked', () => {
  /*
   * "The house map drawn from Mapbox geometry. Cannot be downloaded for
   * offline use." The panel joins the description and the source note, so
   * that sentence is the two together — for an editor too, who used to get
   * "Drawn from Mapbox" a second time after a description saying the same.
   */
  const entry = BASEMAPS.find((basemap) => basemap.id === 'byways-topo-mapbox');
  assert.ok(entry);
  for (const editor of [false, true]) {
    const note = sourceNoteFor(entry, { archive: 'https://x/y.pmtiles', token: 'pk.x', editor });
    assert.equal([entry.description, note].filter(Boolean).join(' '),
      'The house map drawn from Mapbox geometry. Cannot be downloaded for offline use.');
  }
});
