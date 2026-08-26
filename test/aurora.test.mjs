/**
 * Tests for reading NOAA's space weather feeds.
 *
 * Both shapes are from the live services, which CI confirmed answer with CORS
 * open: the OVATION grid at about 900KB, and the K index table at 4.8KB. The
 * fixtures below are trimmed from those rather than written from the
 * documentation, which is a habit this project arrived at expensively.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { auroraAt, latestKp, describeKp } from '../assets/js/lib/aurora.js';

/** The grid, as OVATION publishes it: [longitude 0-359, latitude, chance]. */
const GRID = {
  'Observation Time': '2026-08-26T00:00:00Z',
  'Forecast Time': '2026-08-26T00:30:00Z',
  coordinates: [
    [0, -90, 0],
    [275, 36, 3],
    [275, 37, 4],
    [276, 36, 5],
    [359, 89, 71],
  ],
};

test('aurora: a western longitude finds its cell', () => {
  /*
   * The grid runs 0-359, so -85 has to become 275 before anything matches.
   * Getting this wrong does not throw — it reports a chance from somewhere on
   * the other side of the planet, which is the kind of wrong answer that never
   * gets noticed.
   */
  const here = auroraAt(GRID, [-85, 36.4]);
  assert.equal(here.chance, 3, '-85 is 275 east, and 36.4 rounds to 36');
  assert.equal(here.forecast, '2026-08-26T00:30:00Z');
});

test('aurora: latitude and longitude both round to the nearest cell', () => {
  assert.equal(auroraAt(GRID, [-85, 36.6]).chance, 4);
  assert.equal(auroraAt(GRID, [-84.2, 36]).chance, 5);
});

test('aurora: a point the grid does not cover is null, not zero', () => {
  // Zero would be a claim that there is no aurora there. Null says the feed
  // did not answer for that point, and the panel prints neither.
  assert.equal(auroraAt(GRID, [10, 10]), null);
  assert.equal(auroraAt({ coordinates: [] }, [-85, 36]), null);
  assert.equal(auroraAt(null, [-85, 36]), null);
});

test('kp: the last row of the table is the current reading', () => {
  // A header row of column names, then rows of values, newest last.
  const table = [
    ['time_tag', 'Kp', 'Kp_fraction', 'a_running', 'station_count'],
    ['2026-08-25T18:00:00', '2', '2.00', '7', '8'],
    ['2026-08-25T21:00:00', '5', '4.67', '48', '8'],
  ];
  assert.deepEqual(latestKp(table), { kp: 5, when: '2026-08-25T21:00:00' });
});

test('kp: the column is matched by family, not by one spelling', () => {
  // This column has been "Kp", "kp_index" and "k_index" across revisions of the
  // feed, and a rename should not silently turn the readout into "not
  // available" — which looks like NOAA being down rather than a parse failing.
  for (const name of ['Kp', 'Kp_index', 'k_index', 'KP']) {
    const table = [['time_tag', name], ['2026-08-25T21:00:00', '4']];
    assert.equal(latestKp(table)?.kp, 4, `column "${name}" should be found`);
  }
});

test('kp: a table with no readings is null rather than a guess', () => {
  assert.equal(latestKp([]), null);
  assert.equal(latestKp([['time_tag', 'Kp']]), null);
  assert.equal(latestKp([['time_tag', 'something_else'], ['x', 'y']]), null);
  assert.equal(latestKp(null), null);
});

test('kp: the description crosses at the thresholds the aurora uses', () => {
  // Not this app's numbers: 5 is the storm line, and below about 4 there is
  // nothing to see from the middle of the country however clear it is.
  assert.match(describeKp(2), /quiet/);
  assert.match(describeKp(4), /unsettled/);
  assert.match(describeKp(5), /storm/);
  assert.match(describeKp(7), /severe/);
  assert.equal(describeKp(NaN), '');
});
