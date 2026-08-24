import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStormMotion, describeMotion, projectedPositions, centroid, alertsToGeoJSON,
} from '../assets/js/lib/storms.js';
import { destinationPoint } from '../assets/js/lib/sky.js';

/*
 * The real shape of the field, copied from an NWS severe thunderstorm warning.
 * The convention it encodes is the whole reason this module exists: 245DEG is
 * where the storm is coming FROM, so the arrow has to point at 065.
 */
const MOTION = '2026-05-21T23:54:00-00:00...storm...245DEG...41KT...LAT...LON 3821 8654';

test('parses the NWS storm motion field', () => {
  const motion = parseStormMotion(MOTION);
  assert.equal(motion.fromDegrees, 245);
  assert.equal(motion.headingDegrees, 65);
  assert.equal(motion.knots, 41);
  assert.equal(motion.mph, 47);
  assert.equal(motion.observed.toISOString(), '2026-05-21T23:54:00.000Z');
});

test('a heading that wraps past north stays in range', () => {
  assert.equal(parseStormMotion('...090DEG...20KT...').headingDegrees, 270);
  assert.equal(parseStormMotion('...350DEG...20KT...').headingDegrees, 170);
  assert.equal(parseStormMotion('...180DEG...20KT...').headingDegrees, 0);
});

test('a field with no vector in it yields nothing rather than zero', () => {
  assert.equal(parseStormMotion(''), null);
  assert.equal(parseStormMotion('storm...stationary'), null);
  assert.equal(parseStormMotion('...245DEG...'), null);
});

test('describes the heading in words, not the meteorological convention', () => {
  assert.equal(describeMotion(parseStormMotion(MOTION)), 'northeast at 47 mph');
  assert.equal(describeMotion(null), '');
});

test('projects distance from speed and time', () => {
  const motion = parseStormMotion('...245DEG...30KT...');
  const [quarter] = projectedPositions(motion, [30]);
  // 30 knots for 30 minutes is 15 nautical miles, which is 27.8 km.
  assert.ok(Math.abs(quarter.km - 27.78) < 0.1, `got ${quarter.km}`);
});

test('finds the centre of a polygon and a multipolygon', () => {
  const square = { type: 'Polygon', coordinates: [[[-84, 35], [-83, 35], [-83, 36], [-84, 36], [-84, 35]]] };
  const [lon, lat] = centroid(square);
  assert.ok(Math.abs(lon + 83.5) < 0.01 && Math.abs(lat - 35.5) < 0.01);
  assert.equal(centroid({ type: 'Point', coordinates: [0, 0] }), null);
  assert.equal(centroid(null), null);
});

test('builds an area, a motion line and an arrowhead per warned storm', () => {
  const alerts = [{
    event: 'Severe Thunderstorm Warning',
    severity: 'Severe',
    tracked: true,
    motion: parseStormMotion(MOTION),
    geometry: { type: 'Polygon', coordinates: [[[-84, 35], [-83, 35], [-83, 36], [-84, 36], [-84, 35]]] },
  }];

  const data = alertsToGeoJSON(alerts, destinationPoint, { minutes: 30 });
  assert.deepEqual(data.features.map((f) => f.properties.kind), ['area', 'motion', 'head']);

  const [start, tip] = data.features[1].geometry.coordinates;
  // Heading 065 is east and a little north, so the tip must be east and north.
  assert.ok(tip[0] > start[0], 'arrow points east');
  assert.ok(tip[1] > start[1], 'arrow points north');
  assert.equal(data.features[2].properties.bearing, 65);
});

test('an alert with no motion still draws its area', () => {
  const alerts = [{
    event: 'Flood Watch', severity: 'Moderate', tracked: false, motion: null,
    geometry: { type: 'Polygon', coordinates: [[[-84, 35], [-83, 35], [-83, 36], [-84, 35]]] },
  }];
  const data = alertsToGeoJSON(alerts, destinationPoint);
  assert.deepEqual(data.features.map((f) => f.properties.kind), ['area']);
});
