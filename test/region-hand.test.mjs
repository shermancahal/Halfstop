/**
 * Download regions set by hand: round a point, round a folder's places, or
 * with an edge typed in.
 *
 * The arithmetic is the part that is easy to get quietly wrong - a mile east
 * is not a degree, and is fewer degrees the further north you are - and the
 * checks are the part that must not be skipped: every region made by hand has
 * to pass the same size cap as one dragged out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  reachKm, padBoundsKm, boundsAround, withEdge, REACH_CHOICES, KM_PER_MILE, regionSizeProblem, areaKm2,
} from '../assets/js/lib/offline.js';

/** Great-circle distance in km, to check a reach independently of how it was built. */
function km([lon1, lat1], [lon2, lat2]) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}

test('region by hand: a reach is read in the units it was chosen in', () => {
  assert.equal(reachKm(10, 'metric'), 10);
  assert.equal(reachKm(10, 'imperial'), 10 * KM_PER_MILE);
  assert.equal(reachKm('nonsense'), 0);
  assert.equal(reachKm(-3), 0);
});

test('region by hand: round a point reaches at least as far as asked, in every direction', () => {
  for (const lat of [25, 38.39, 48.5, 61]) {
    const centre = [-109.87, lat];
    const box = boundsAround(centre, 16);
    const north = km(centre, [centre[0], box.north]);
    const east = km(centre, [box.east, lat]);
    assert.ok(Math.abs(north - 16) < 0.2, `north reach ${north} at ${lat}`);
    // At least 16 km east along the centre's own latitude, never short.
    assert.ok(east >= 15.9, `east reach ${east} at ${lat}`);
    assert.ok(east < 17.5, `east reach ${east} at ${lat} overshoots`);
  }
  assert.equal(boundsAround([-109.87, 38.39], 0), null);
  assert.equal(boundsAround(['x', 38], 5), null);
});

test('region by hand: every reach on offer makes a region that can be saved, north or south', () => {
  for (const [units, choices] of Object.entries(REACH_CHOICES)) {
    for (const reach of choices) {
      for (const lat of [19, 38, 48, 64]) {
        const box = boundsAround([-110, lat], reachKm(reach, units));
        assert.equal(regionSizeProblem(box), '', `${reach} ${units} at ${lat} is over the cap: ${Math.round(areaKm2(box))} km2`);
      }
    }
  }
});

test('region by hand: a folder’s places are grown by the reach on every side', () => {
  const places = { west: -110.1, south: 38.3, east: -109.6, north: 38.7 };
  const box = padBoundsKm(places, 5);
  assert.ok(box.west < places.west && box.east > places.east && box.south < places.south && box.north > places.north);
  assert.deepEqual(padBoundsKm(places, 0), places);
  // Clamped at the antimeridian rather than wrapped round to the other side.
  assert.equal(padBoundsKm({ west: 179.99, south: 51, east: 179.99, north: 51 }, 20).east, 180);
  assert.equal(padBoundsKm(places, -1), null);
});

test('region by hand: an edge typed in is checked the way a drawn region is', () => {
  const region = boundsAround([-109.87, 38.39], 8);
  assert.deepEqual(withEdge(region, 'north', '38.5').bounds, { ...region, north: 38.5 });
  assert.match(withEdge(region, 'north', 'north-ish').problem, /number of degrees/);
  assert.match(withEdge(region, 'north', '').problem, /number of degrees/);
  assert.match(withEdge(region, 'north', '30').problem, /north of the south edge/);
  assert.match(withEdge(region, 'east', '-111').problem, /east of the west edge/);
  assert.match(withEdge(region, 'south', '-90').problem, /-85 to 85/);
  assert.match(withEdge(region, 'west', '-200').problem, /-180 to 180/);
  assert.match(withEdge(boundsAround([-109.87, 38.39], 40), 'west', '-125').problem, /capped at/);
  assert.match(withEdge(region, 'middle', '1').problem, /not an edge/);
});

test('region by hand: the form saves through saveRegionFrom, so the cap and the plan apply', async () => {
  const viewer = await readFile(new URL('../assets/js/viewer.js', import.meta.url), 'utf8');
  const form = viewer.slice(viewer.indexOf('function regionByHandForm() {'), viewer.indexOf('function renderOfflineTab() {'));
  assert.ok(form.length > 100, 'the by-hand form was not found');
  assert.match(form, /saveRegionFrom\(current\.bounds/);
  assert.doesNotMatch(form, /state\.offline\.add\(/, 'the form writes a region without the checks');
  const edges = viewer.slice(viewer.indexOf('function regionEdges(region) {'), viewer.indexOf('function regionRow(region, kind) {'));
  assert.match(edges, /withEdge\(region\.bounds/);
  assert.match(edges, /regionSizeProblem\(bounds\)/);
});
