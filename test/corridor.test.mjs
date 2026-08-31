/**
 * Finding what is near the drive rather than near the screen.
 *
 * Every queried overlay asks "what is in the current view", which is wrong for
 * a trip: the view is a rectangle and a drive is a thin line through one, so
 * most of what a viewport query returns for a route is nowhere near the road.
 *
 * The numbers below are checked against distances that can be worked out by
 * hand — a degree of latitude is about 69 miles, everywhere — rather than
 * against whatever this code happens to return, which would only assert that
 * it does not change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { closestOnLeg, distanceToRoute, routeBounds, alongRoute } from '../assets/js/lib/corridor.js';
import { M_TO_MI } from '../assets/js/lib/geo.js';

const miles = (metres) => metres * M_TO_MI;

test('corridor: the foot of the perpendicular is found on the ground, not in degrees', () => {
  /*
   * The trap, and the test I got wrong first.
   *
   * A degree of longitude is about 69 miles at the equator and 53 at 40°N.
   * Point-to-segment distance done in raw degrees treats them as equal, so the
   * nearest point it finds is the wrong point on the leg.
   *
   * My first version of this used a leg running due north and a point due east
   * of it, and PASSED with the cos(lat) scaling deleted - because for that
   * arrangement the foot of the perpendicular is at the same latitude whatever
   * the horizontal scale, and the distance is measured with haversine on the
   * unprojected point afterwards. It asserted haversine, not the projection.
   * Found by mutation; it would have shipped otherwise.
   *
   * A diagonal leg is what separates them. From (-81,39) to (-80,40) the
   * ground vector is 85.9 km east by 110.6 km north, not the 45° it looks in
   * degrees, so the nearest point to (-80,39) sits 37.6% along it rather than
   * 50.3%. Worked out by hand from those two figures before it was run.
   */
  const hit = closestOnLeg([-80, 39], [-81, 39], [-80, 40]);
  assert.ok(Math.abs(hit.t - 0.376) < 0.02,
    `expected the foot 37.6% along a diagonal leg, got ${(hit.t * 100).toFixed(1)}%`);
  assert.ok(Math.abs(miles(hit.metres) - 42.3) < 0.6,
    `expected about 42.3 miles, got ${miles(hit.metres).toFixed(2)}`);

  /*
   * And the plain case still measures on the ground: a leg running due north
   * at 40°N with a point one degree of longitude east is 69 × cos(40°) ≈ 53
   * miles away, not 69.
   */
  const across = closestOnLeg([-80, 40], [-81, 39.5], [-81, 40.5]);
  assert.ok(Math.abs(miles(across.metres) - 53) < 1.5,
    `expected about 53 miles across a degree of longitude at 40N, got ${miles(across.metres).toFixed(1)}`);
  assert.ok(Math.abs(across.t - 0.5) < 0.02);
});

test('corridor: a point past the end of a leg measures to the end, not the line', () => {
  /*
   * Segment, not infinite line. A place a hundred miles beyond the last stop
   * sits near the line the route runs along and is not near the route, and
   * clamping is the whole difference between those two statements.
   */
  const beyond = closestOnLeg([-81, 42], [-81, 39], [-81, 40]);
  assert.equal(beyond.t, 1, 'clamped to the far end');
  assert.ok(Math.abs(miles(beyond.metres) - 138) < 2, 'two degrees of latitude, about 138 miles');

  const before = closestOnLeg([-81, 38], [-81, 39], [-81, 40]);
  assert.equal(before.t, 0, 'clamped to the near end');
});

test('corridor: a route reports which leg is nearest and how far along', () => {
  // An L: north up the -81 line, then east along 40.
  const stops = [[-81, 39], [-81, 40], [-80, 40]];

  // Beside the first leg, a third of the way up.
  const first = distanceToRoute([-80.9, 39.33], stops);
  assert.equal(first.legIndex, 0);
  assert.ok(Math.abs(miles(first.along) - 23) < 2, 'about a third of a 69-mile leg');

  // Beside the second leg: `along` must include the whole first leg before it,
  // which is what puts finds in driving order rather than in map order.
  const second = distanceToRoute([-80.5, 40.1], stops);
  assert.equal(second.legIndex, 1);
  assert.ok(miles(second.along) > 69, `expected past the first leg, got ${miles(second.along).toFixed(1)}`);
});

test('corridor: the query box is padded by the corridor, not by the trip', () => {
  /*
   * The box is what a service is actually asked for, and these services cap
   * what they return - so a box bigger than the corridor spends the cap on
   * places that will be filtered out.
   */
  const box = routeBounds([[-81, 39], [-80, 40]], 10);
  const [west, south, east, north] = box;
  assert.ok(south < 39 && north > 40 && west < -81 && east > -80, 'the route is inside');

  // Ten miles is about 0.145° of latitude. Generous bounds: the assertion is
  // that it is a corridor's worth of padding, not a degree of it.
  assert.ok(Math.abs((39 - south) - 0.145) < 0.02, `south pad was ${(39 - south).toFixed(3)}`);
  // Longitude pads wider than latitude, because a degree of it is shorter here.
  assert.ok((west * -1) - 81 > (39 - south), 'the longitude pad has to be the larger one');
});

test('corridor: finds come back in driving order, not in order of distance', () => {
  /*
   * The ordering is the feature. A list sorted by how close each place is to
   * the road is a list you cannot drive: it puts the last stop of the trip
   * second. Sorted along the route, it reads as an itinerary.
   */
  const stops = [[-81, 39], [-81, 41]];
  const at = (lon, lat, name) => ({ name, geometry: { coordinates: [lon, lat] } });
  const candidates = [
    at(-81.02, 40.8, 'near the end, very close to the road'),
    at(-81.10, 39.2, 'early, further off the road'),
    at(-79.00, 40.0, 'a long way east — not on the way at all'),
  ];

  const found = alongRoute(candidates, stops, { milesWithin: 10 });
  assert.deepEqual(found.map((one) => one.candidate.name), [
    'early, further off the road',
    'near the end, very close to the road',
  ], 'driving order, and the far one dropped');

  // And the miles reported are the distance from the road, which is what the
  // reader is deciding on.
  assert.ok(found[0].miles > found[1].miles, 'the earlier find is the further one here');
  assert.ok(found.every((one) => one.miles <= 10));
});

test('corridor: a narrower band drops what a wider one keeps', () => {
  // The band is the whole control, so it has to actually control something.
  const stops = [[-81, 39], [-81, 41]];
  const candidates = [{ geometry: { coordinates: [-81.1, 40] } }];
  assert.equal(alongRoute(candidates, stops, { milesWithin: 10 }).length, 1);
  assert.equal(alongRoute(candidates, stops, { milesWithin: 2 }).length, 0);
});

test('corridor: one stop is a radius, and no stops is nothing', () => {
  // A trip with a single stop still has a sensible answer — what is near it —
  // and a trip with none must not throw at whoever asks.
  const one = distanceToRoute([-81.1, 39], [[-81, 39]]);
  assert.ok(Math.abs(miles(one.metres) - 5.4) < 0.5);
  assert.equal(distanceToRoute([-81, 39], []), null);
  assert.deepEqual(alongRoute([{ geometry: { coordinates: [-81, 39] } }], []), []);
  assert.equal(routeBounds([]), null);
});
