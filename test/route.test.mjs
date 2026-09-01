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

/* ------------------------------------------------------------------ asking */

test('route: one request carries the whole trip, not one per leg', async () => {
  const { routeBody } = await import('../assets/js/lib/route.js');
  const stops = [
    { position: [-83.37, 36.71] },
    { position: [-83.02, 36.75] },
    { position: [-82.80, 36.90] },
  ];
  const body = routeBody(stops);

  /*
   * Three stops, one request. The published limit is one request per second,
   * so a trip asked leg by leg would take as many seconds as it has legs and
   * spend the budget of that many other people's routes.
   */
  assert.equal(body.locations.length, 3);
  assert.deepEqual(body.locations[0], { lat: 36.71, lon: -83.37, type: 'break' });
  assert.equal(body.costing, 'auto');
  assert.equal(body.directions_options.units, 'miles');
  /*
   * And no costing_options at all, not an empty one. A car route has to be the
   * same request it was before vehicle profiles existed — an empty object is a
   * different body and a different cache entry at the far end for no gain.
   */
  assert.equal('costing_options' in body, false);

  // lat/lon, not the [lon, lat] the rest of this codebase uses. Getting this
  // pair the wrong way round routes somewhere in the Indian Ocean and reports
  // no error at all.
  assert.equal(body.locations[1].lat, 36.75);
  assert.equal(body.locations[1].lon, -83.02);
});

test('route: requests are serialised and spaced to the published limit', async () => {
  const { throttled } = await import('../assets/js/lib/route.js');

  /*
   * The limit is one request per second and it is not a suggestion.
   *
   * Enforced here rather than trusted to good behaviour: dragging a stop about
   * generates a request per drag. Tested with a small interval so the suite
   * does not take seconds, since what is being checked is the spacing rule
   * rather than the particular number.
   */
  const at = [];
  const started = Date.now();
  await Promise.all([1, 2, 3].map(() => throttled(
    () => { at.push(Date.now() - started); return 'done'; },
    { minIntervalMs: 60 },
  )));

  assert.equal(at.length, 3);
  for (let i = 1; i < at.length; i += 1) {
    assert.ok(at[i] - at[i - 1] >= 55,
      `requests ${i - 1} and ${i} were ${at[i] - at[i - 1]}ms apart, under the limit`);
  }
});

test('route: one failure does not wedge the queue behind it', async () => {
  const { throttled } = await import('../assets/js/lib/route.js');

  /*
   * The queue chains each call onto the last, so a rejection that was not
   * caught inside the chain would leave every later request waiting on a
   * promise that never settles - routing would work once, fail once, and then
   * be silently dead for the rest of the session.
   */
  const failed = throttled(() => Promise.reject(new Error('service said no')), { minIntervalMs: 1 });
  await assert.rejects(failed, /service said no/);

  const after = await throttled(() => 'still working', { minIntervalMs: 1 });
  assert.equal(after, 'still working');
});

test('route: a refusal is read from the body, not guessed from the status', async () => {
  const { fetchRoute } = await import('../assets/js/lib/route.js');

  /*
   * Valhalla answers a refusal with a 400 and a JSON body that says why. The
   * sentence in the body is a far better thing to show than the status code
   * that carried it.
   */
  const fetcher = async () => ({
    status: 400,
    json: async () => ({ error: 'No path could be found for input' }),
  });
  const route = await fetchRoute(
    [{ position: [0, 0] }, { position: [1, 1] }],
    { fetcher, walkInMetres: 400 },
  );
  assert.equal(route.ok, false);
  assert.match(route.message, /No path could be found/);
});

test('route: an unreadable answer says so rather than throwing', async () => {
  const { fetchRoute } = await import('../assets/js/lib/route.js');
  const fetcher = async () => ({
    status: 502,
    json: async () => { throw new Error('not JSON'); },
  });
  const route = await fetchRoute([{ position: [0, 0] }, { position: [1, 1] }], { fetcher });
  assert.equal(route.ok, false);
  assert.match(route.message, /502/);
  assert.deepEqual(route.legs, []);
});

test('route: fewer than two stops is not a request worth making', async () => {
  const { fetchRoute } = await import('../assets/js/lib/route.js');
  let called = 0;
  const fetcher = async () => { called += 1; return { status: 200, json: async () => ({}) }; };

  const none = await fetchRoute([], { fetcher });
  const one = await fetchRoute([{ position: [0, 0] }], { fetcher });

  assert.equal(none.ok, false);
  assert.equal(one.ok, false);
  assert.equal(called, 0, 'the service was asked to route a trip with no legs');
});

test('route: the endpoint is configurable, and required by the terms to be', async () => {
  const { fetchRoute } = await import('../assets/js/lib/route.js');
  const { ROUTING } = await import('../assets/js/config.js');

  /*
   * FOSSGIS's own terms say the URLs of their services should not be hardcoded
   * into the app, and their limits mean anything with a paid tier needs its own
   * Valhalla. Both of those are the same requirement: this has to be a setting.
   */
  assert.ok(ROUTING.url, 'no default routing endpoint is configured');
  assert.equal(ROUTING.minIntervalMs >= 1000, true,
    'the throttle is faster than the one-request-per-second limit');
  assert.match(ROUTING.attribution, /openstreetmap\.org\/fixthemap/,
    'the terms require a link users can report data errors through');

  let asked = '';
  const fetcher = async (url) => {
    asked = url;
    return { status: 200, json: async () => ({ error: 'nope' }) };
  };
  await fetchRoute([{ position: [0, 0] }, { position: [1, 1] }],
    { fetcher, url: 'https://valhalla.example.test/route' });
  assert.ok(asked.startsWith('https://valhalla.example.test/route?json='),
    `the configured endpoint was ignored: ${asked}`);
});

test('route: the request is CORS-simple, so no preflight can fail it', async () => {
  const { fetchRoute } = await import('../assets/js/lib/route.js');

  /*
   * A GET with the query in the URL and no custom headers.
   *
   * Valhalla's docs suggest published apps send an X-Client-Id. That is not a
   * CORS-simple header, so it would make every request depend on the service
   * answering an OPTIONS - a failure that is total and looks exactly like the
   * router being down. What the FOSSGIS terms actually require is the
   * browser's own User-Agent and Referer, which a page cannot set anyway.
   */
  let options = null;
  const fetcher = async (_url, init) => {
    options = init;
    return { status: 200, json: async () => ({ error: 'nope' }) };
  };
  await fetchRoute([{ position: [0, 0] }, { position: [1, 1] }], { fetcher });
  assert.equal(options?.headers, undefined, 'a custom header would trigger a preflight');
  assert.ok(!options?.method || options.method === 'GET');
});

test('route: the walk is drawn, dashed and separate from the drive', async () => {
  const { decodePolyline, readRoute, routeGeoJSON } = await import('../assets/js/lib/route.js');

  const coordinates = decodePolyline(REAL_SHAPE);
  const near = { position: coordinates[0] };
  const far = { position: [coordinates[0][0] + 0.02, coordinates[0][1] + 0.02] };
  const json = fakeTrip({ shape: REAL_SHAPE });

  /*
   * Without this the map shows a line stopping at a road with the pin floating
   * beside it and nothing joining them - which is exactly the confusion the
   * whole walk-in mechanism exists to remove.
   */
  const walked = routeGeoJSON(readRoute(json, [far]), [far]);
  const stub = walked.features.find((f) => f.properties.walk);
  assert.ok(stub, 'a walk-in stop drew no walk');
  assert.equal(stub.geometry.coordinates.length, 2);
  assert.deepEqual(stub.geometry.coordinates[1], far.position,
    'the walk should end at the pin that was dropped');
  assert.ok(stub.properties.metres > 0);

  // Every drive leg says it is not a walk, so one filter separates them and a
  // feature cannot fall through both.
  assert.equal(walked.features.filter((f) => f.properties.walk === false).length, 1);

  const parked = routeGeoJSON(readRoute(json, [near]), [near]);
  assert.equal(parked.features.filter((f) => f.properties.walk).length, 0,
    'a roadside stop drew a walk it does not have');
});

test('route: the reader carries no turn instructions, on purpose', async () => {
  /*
   * A scope decision, written as a test so it is a decision rather than a
   * thing nobody got round to.
   *
   * Valhalla returns a full maneuvers array - instructions, street names,
   * verbal variants, shape indices - and this reads none of it. Turn-by-turn is
   * Apple's and Google's ground, fought with their traffic data and their voice
   * guidance, and GaiaGPS makes the same call: a map on CarPlay, no driving
   * instructions. If that changes it should change deliberately, and this test
   * is what makes somebody say so.
   */
  const { readRoute } = await import('../assets/js/lib/route.js');

  const withManeuvers = {
    trip: {
      legs: [{
        shape: REAL_SHAPE,
        summary: { length: 10, time: 600 },
        maneuvers: [
          { type: 1, instruction: 'Drive east on Wilderness Road.', street_names: ['US 58'] },
          { type: 15, instruction: 'You have arrived at your destination.' },
        ],
      }],
      summary: { length: 10, time: 600 },
      status_message: 'Found route between points',
    },
  };

  const route = readRoute(withManeuvers, []);
  assert.equal(route.ok, true);
  const serialised = JSON.stringify(route);
  assert.ok(!serialised.includes('Wilderness Road'), 'a turn instruction reached the app');
  assert.ok(!serialised.includes('maneuver'), 'maneuvers reached the app');
  assert.equal(route.legs[0].maneuvers, undefined);

  // What it does carry is the shape and the numbers, which is the whole feature.
  assert.ok(route.legs[0].coordinates.length > 1);
  assert.equal(route.legs[0].miles, 10);
});

test('route: a vehicle profile rides along with the costing it belongs to', async () => {
  const { routeBody } = await import('../assets/js/lib/route.js');
  const { routingFor } = await import('../assets/js/lib/rv.js');
  const stops = [{ position: [-83.37, 36.71] }, { position: [-83.02, 36.75] }];

  const rv = routingFor({ kind: 'rv', heightM: 4.11, widthM: 2.6, lengthM: 10.7, weightT: 7.2 });
  const body = routeBody(stops, { costing: rv.costing, costingOptions: rv.costing_options });
  assert.equal(body.costing, 'truck');
  assert.equal(body.costing_options.truck.height, 4.11);
});
