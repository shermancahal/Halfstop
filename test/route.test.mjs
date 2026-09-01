import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodePolyline, offRoadMetres, readRoute, routeGeoJSON, WALK_IN_METRES,
} from '../assets/js/lib/route.js';
import { haversine } from '../assets/js/lib/geo.js';

/*
 * A real shape, from the real service.
 *
 * The first 48 characters of trip.legs[0].shape for a route starting at
 * 36.7106, -83.3745 in Lee County, Virginia - read off the live FOSSGIS
 * Valhalla instance rather than made up, so the precision test below is
 * checking the decoder against the thing it has to decode.
 */
const REAL_SHAPE = 's}y_eArc~_~CtFxNiCnLwNnVgL~|@eAn[dArMnIjN~l@lX`B';
const ASKED_FOR = [-83.3745, 36.7106];

test('route: the shape decodes at precision six, and only at six', () => {
  const [lon, lat] = decodePolyline(REAL_SHAPE)[0];

  /*
   * The failure this exists for is silent and total.
   *
   * Valhalla encodes at six decimal places; Google's format and most of the
   * copy-and-paste decoders on the internet use five. Decoded at five there is
   * no error - you get coordinates, every one of them ten times too large, and
   * a line drawn somewhere off the edge of the planet. 367 degrees north is not
   * a latitude, and nothing in the pipeline says so.
   */
  assert.ok(Math.abs(lat - 36.714) < 0.01, `latitude decoded as ${lat}`);
  assert.ok(Math.abs(lon + 83.378) < 0.01, `longitude decoded as ${lon}`);

  const [wrongLon, wrongLat] = decodePolyline(REAL_SHAPE, 5)[0];
  assert.ok(Math.abs(wrongLat) > 90, 'precision five should give an impossible latitude');
  assert.ok(Math.abs(wrongLon) > 180, 'precision five should give an impossible longitude');
});

test('route: an empty or missing shape decodes to nothing rather than throwing', () => {
  assert.deepEqual(decodePolyline(''), []);
  assert.deepEqual(decodePolyline(null), []);
  assert.deepEqual(decodePolyline(undefined), []);
});

/*
 * A response shaped exactly like the measured one: trip.legs[].shape and
 * .summary, trip.summary, trip.status_message. No distance_from_input, because
 * the service does not send one - which is the whole reason offRoadMetres
 * exists.
 */
function fakeTrip({ shape, miles = 10, seconds = 1200 }) {
  return {
    trip: {
      locations: [{ type: 'break', lat: 0, lon: 0, side_of_street: 'left', original_index: 0 }],
      legs: [{
        shape,
        summary: { length: miles, time: seconds, has_toll: false, has_ferry: false, has_highway: false },
      }],
      summary: { length: miles, time: seconds },
      status_message: 'Found route between points',
      status: 0,
      units: 'miles',
    },
  };
}

test('route: legs come back with geometry, miles and minutes', () => {
  const route = readRoute(fakeTrip({ shape: REAL_SHAPE, miles: 36.448, seconds: 4641.189 }), []);
  assert.equal(route.ok, true);
  assert.equal(route.legs.length, 1);
  assert.equal(route.legs[0].miles, 36.448);
  assert.ok(Math.abs(route.legs[0].minutes - 77.35) < 0.1, 'seconds were not converted to minutes');
  assert.ok(route.legs[0].coordinates.length > 5);
  assert.ok(Math.abs(route.totals.minutes - 77.35) < 0.1);
});

test('route: a refusal is reported in the service’s own words', () => {
  const refused = readRoute({ error: 'No path could be found for input' }, [{ position: [0, 0] }]);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /No path could be found/);
  assert.deepEqual(refused.legs, []);
  // One entry per stop even when nothing routed, so a caller can render the
  // list without checking whether the route worked first.
  assert.equal(refused.stops.length, 1);
});

test('route: how far a stop sits from the road it reached', () => {
  const coordinates = decodePolyline(REAL_SHAPE);
  const legs = [{ coordinates }];
  const gaps = offRoadMetres([{ position: ASKED_FOR }], legs);

  /*
   * Hand-checked against the same numbers by a different route: the requested
   * point and the first decoded vertex, through haversine directly.
   */
  const expected = haversine(ASKED_FOR, coordinates[0]);
  assert.ok(Math.abs(gaps[0] - expected) < 0.001);
  assert.ok(gaps[0] > 400 && gaps[0] < 550,
    `expected roughly 470 m for this pair, got ${Math.round(gaps[0])}`);
});

test('route: a stop off the network is called a walk, and kept out of the drive', () => {
  /*
   * The case this was all for: a pin by a waterfall.
   *
   * Valhalla does not refuse it. It snaps to the nearest road it can reach and
   * answers "Found route between points", so nothing in the response says the
   * driving does not get there - measured on the live service with a location
   * deep in the Jefferson National Forest, which routed successfully.
   */
  const coordinates = decodePolyline(REAL_SHAPE);
  const near = { position: coordinates[0] };
  const far = { position: [coordinates[0][0] + 0.02, coordinates[0][1] + 0.02] };

  const json = fakeTrip({ shape: REAL_SHAPE });
  const onRoad = readRoute(json, [near]);
  assert.equal(onRoad.stops[0].walkIn, false);
  assert.equal(onRoad.stops[0].walkMinutes, 0);

  const offRoad = readRoute(json, [far]);
  assert.equal(offRoad.stops[0].walkIn, true);
  assert.ok(offRoad.stops[0].offRoadMetres > WALK_IN_METRES);
  assert.ok(offRoad.stops[0].walkMinutes > 0, 'a walk-in stop reported no walking time');

  /*
   * And the walk stays out of the drive.
   *
   * Adding it to the leg would say the car goes somewhere it does not, which
   * is the specific wrong answer this whole mechanism exists to avoid.
   */
  assert.equal(offRoad.totals.minutes, onRoad.totals.minutes);
  assert.equal(offRoad.legs[0].minutes, onRoad.legs[0].minutes);
});

test('route: the threshold is a setting, not a constant', () => {
  const coordinates = decodePolyline(REAL_SHAPE);
  const stop = [{ position: [coordinates[0][0] + 0.002, coordinates[0][1]] }];
  const json = fakeTrip({ shape: REAL_SHAPE });

  assert.equal(readRoute(json, stop, { walkInMetres: 10 }).stops[0].walkIn, true);
  assert.equal(readRoute(json, stop, { walkInMetres: 5000 }).stops[0].walkIn, false);
});

test('route: the drawable geometry is one feature per leg', () => {
  const route = readRoute(fakeTrip({ shape: REAL_SHAPE }), []);
  const collection = routeGeoJSON(route);
  assert.equal(collection.type, 'FeatureCollection');
  assert.equal(collection.features.length, 1);
  assert.equal(collection.features[0].geometry.type, 'LineString');
  assert.deepEqual(collection.features[0].geometry.coordinates, route.legs[0].coordinates);
  // A leg with nothing in it is dropped rather than drawn as an empty line,
  // which GL renders as a warning and a gap.
  assert.equal(routeGeoJSON({ legs: [{ coordinates: [] }] }).features.length, 0);
  assert.deepEqual(routeGeoJSON(null).features, []);
});
