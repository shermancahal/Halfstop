import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appleMapsURL, googleMapsURL, wazeURL, googleTripURL, directionsFor, GOOGLE_WAYPOINT_LIMIT,
} from '../assets/js/lib/directions.js';

/* Lee County, Virginia — [lon, lat], the way this codebase stores everything. */
const BEN_HUR = [-83.3745, 36.7106];

test('directions: every link is lat,lon, whatever we store', () => {
  /*
   * The one conversion in the file, and the one that fails silently.
   *
   * GeoJSON order is [lon, lat] and every navigation URL is the other way
   * round. Backwards, 36.71N -83.37W becomes -83.37N 36.71E, which is open
   * water south of Africa - and nothing reports an error. The link opens, the
   * app accepts it, the pin is simply somewhere else.
   */
  for (const url of [appleMapsURL(BEN_HUR), googleMapsURL(BEN_HUR), wazeURL(BEN_HUR)]) {
    const decoded = decodeURIComponent(url);
    assert.match(decoded, /36\.7106/, `${url} lost the latitude`);
    assert.match(decoded, /-83\.3745/, `${url} lost the longitude`);
    // Latitude first, longitude second — the pair, in order, in one string.
    assert.match(decoded, /36\.710600,-83\.374500/, `${url} has the pair the wrong way round`);
  }
});

test('directions: each service gets the form it actually accepts', () => {
  assert.match(appleMapsURL(BEN_HUR), /^https:\/\/maps\.apple\.com\/\?daddr=/);
  assert.match(appleMapsURL(BEN_HUR), /dirflg=d/, 'Apple was not asked for driving directions');

  assert.match(googleMapsURL(BEN_HUR), /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1/);
  assert.match(googleMapsURL(BEN_HUR), /destination=/);

  assert.match(wazeURL(BEN_HUR), /^https:\/\/waze\.com\/ul\?ll=/);
  assert.match(wazeURL(BEN_HUR), /navigate=yes/);
});

test('directions: only Google is offered a whole trip', () => {
  /*
   * Not a preference — a limitation, and the reason the trip button names one
   * service. Apple Maps has no multi-stop form in its URL scheme at all, and
   * Waze answers a link carrying several destinations with an error rather
   * than ignoring the extras. Google is the only one of the three whose links
   * carry intermediate stops.
   */
  const stops = [
    { position: BEN_HUR }, { position: [-83.02, 36.75] }, { position: [-82.8, 36.9] },
  ];
  const trip = googleTripURL(stops);
  assert.match(trip.url, /waypoints=/);
  assert.match(decodeURIComponent(trip.url), /36\.750000,-83\.020000/);
  assert.equal(trip.sent, 3);
  assert.equal(trip.dropped, 0);

  // The single-stop builders carry no waypoints at all, because they cannot.
  assert.ok(!appleMapsURL(BEN_HUR).includes('waypoint'));
  assert.ok(!wazeURL(BEN_HUR).includes('waypoint'));
});

test('directions: a trip too long to send says so rather than losing stops', () => {
  /*
   * A trip quietly missing its last four stops is worse than a trip that says
   * it was too long to send whole: the first is discovered in a car park.
   */
  const many = Array.from({ length: GOOGLE_WAYPOINT_LIMIT + 4 }, (_, i) => ({
    position: [-83 + i * 0.1, 36 + i * 0.1],
  }));
  const trip = googleTripURL(many);

  const carried = decodeURIComponent(trip.url).match(/waypoints=(.*)$/)[1].split('|');
  assert.equal(carried.length, GOOGLE_WAYPOINT_LIMIT, 'more waypoints were sent than the limit');
  assert.equal(trip.sent, GOOGLE_WAYPOINT_LIMIT + 2);
  assert.equal(trip.dropped, many.length - trip.sent,
    'the count of dropped stops does not add up, so the warning would be wrong');
  assert.ok(trip.dropped > 0);
});

test('directions: a trip with nothing to route is no link at all', () => {
  assert.equal(googleTripURL([]), null);
  assert.equal(googleTripURL([{ position: BEN_HUR }]), null);
  assert.equal(googleTripURL(null), null);
});

test('directions: a stop with no usable position offers nothing', () => {
  assert.deepEqual(directionsFor(null), []);
  assert.deepEqual(directionsFor([]), []);
  assert.deepEqual(directionsFor([NaN, 36.7]), []);
  assert.equal(directionsFor(BEN_HUR).length, 3);
  assert.deepEqual(directionsFor(BEN_HUR).map((one) => one.id), ['apple', 'google', 'waze']);
});
