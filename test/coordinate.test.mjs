/**
 * Reading a coordinate somebody typed.
 *
 * The search box takes place names, and a coordinate is the other way people
 * say where they mean - off a GPS screen, out of a text message, read over a
 * radio, or copied from this app's own details panel.
 *
 * The round trip is the test that matters and it is first: every format the
 * panel prints, printed and read back, over a spread of points including the
 * signs and the hemispheres that are easy to get backwards. A parser tested
 * only against strings somebody sat down and imagined will accept those
 * strings and nothing else.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCoordinate, formatDD, formatDMS, formatDDM,
} from '../assets/js/lib/place.js';

/** Points in all four quadrants, plus the edges and the origin. */
const POINTS = [
  [-84.28, 35.96],          // Tennessee - the default view
  [-106.445, 39.117],       // Colorado
  [151.2093, -33.8688],     // Sydney: south and east
  [-58.3816, -34.6037],     // Buenos Aires: south and west
  [2.3522, 48.8566],        // Paris: north and east
  [0, 0],
  [180, 0],
  [-180, 0],
  [0, 90],
  [0, -90],
  [-0.1276, 51.5072],       // London, just west of the meridian
];

/*
 * A metre is about 1/111000 of a degree of latitude, and formatDMS rounds
 * seconds to a tenth (~3 m) while formatDDM rounds minutes to a thousandth
 * (~1.8 m). So the round trip is checked to the precision the format itself
 * carries, not to the bit.
 */
const TOLERANCE = { formatDD: 1e-6, formatDMS: 1e-4, formatDDM: 1e-4 };

for (const [name, format] of Object.entries({ formatDD, formatDMS, formatDDM })) {
  test(`round trip: ${name} prints what parseCoordinate reads`, () => {
    for (const [lon, lat] of POINTS) {
      const printed = format([lon, lat]);
      const read = parseCoordinate(printed);
      assert.ok(read, `${name}([${lon}, ${lat}]) printed ${printed}, which did not parse`);
      assert.ok(
        Math.abs(read.lat - lat) < TOLERANCE[name],
        `${printed}: latitude came back ${read.lat}, expected ${lat}`,
      );
      assert.ok(
        Math.abs(read.lon - lon) < TOLERANCE[name],
        `${printed}: longitude came back ${read.lon}, expected ${lon}`,
      );
    }
  });
}

test('decimal degrees, however they are separated', () => {
  for (const text of ['35.96, -84.28', '35.96,-84.28', '35.96 -84.28', '  35.96 , -84.28  ']) {
    const read = parseCoordinate(text);
    assert.ok(read, `${text} did not parse`);
    assert.equal(read.lat, 35.96);
    assert.equal(read.lon, -84.28);
    assert.equal(read.swapped, false);
  }
});

test('a hemisphere letter settles which number is which, in either order', () => {
  const expected = { lat: 35.96, lon: -84.28 };
  for (const text of ['35.96N, 84.28W', 'N35.96 W84.28', 'W84.28 N35.96', '84.28W 35.96N']) {
    const read = parseCoordinate(text);
    assert.ok(read, `${text} did not parse`);
    assert.equal(read.lat, expected.lat, text);
    assert.equal(read.lon, expected.lon, text);
  }
});

test('one letter is enough to place both numbers', () => {
  const read = parseCoordinate('84.28W 35.96');
  assert.ok(read);
  assert.equal(read.lon, -84.28);
  assert.equal(read.lat, 35.96);
});

test('southern and eastern letters carry their sign', () => {
  const read = parseCoordinate('33.8688S 151.2093E');
  assert.ok(read);
  assert.equal(read.lat, -33.8688);
  assert.equal(read.lon, 151.2093);
});

test('degrees, minutes and seconds, with and without the punctuation', () => {
  const target = { lat: 35 + 57 / 60 + 36 / 3600, lon: -(84 + 16 / 60 + 48 / 3600) };
  for (const text of [
    `35°57'36"N 84°16'48"W`,
    '35 57 36 N, 84 16 48 W',
    '35°57′36″N 84°16′48″W',
    '35 57 36, -84 16 48',
  ]) {
    const read = parseCoordinate(text);
    assert.ok(read, `${text} did not parse`);
    assert.ok(Math.abs(read.lat - target.lat) < 1e-9, `${text}: lat ${read.lat}`);
    assert.ok(Math.abs(read.lon - target.lon) < 1e-9, `${text}: lon ${read.lon}`);
  }
});

test('degrees and decimal minutes, which is what a handheld shows', () => {
  const read = parseCoordinate(`35° 57.600'N 84° 16.800'W`);
  assert.ok(read);
  assert.ok(Math.abs(read.lat - (35 + 57.6 / 60)) < 1e-9);
  assert.ok(Math.abs(read.lon + (84 + 16.8 / 60)) < 1e-9);
});

test('a first number that cannot be a latitude is read as a longitude, and says so', () => {
  // Denver, written longitude first. 104.99 is past the poles, so there is
  // only one reading of it and no guess involved in finding that out.
  const read = parseCoordinate('-104.99, 39.74');
  assert.ok(read);
  assert.equal(read.lon, -104.99);
  assert.equal(read.lat, 39.74);
  assert.equal(read.swapped, true, 'the caller has to be able to say the order was inferred');

  // Same rule without a sign: 95 is a longitude, so 10 is the latitude.
  const east = parseCoordinate('95, 10');
  assert.ok(east);
  assert.equal(east.lon, 95);
  assert.equal(east.lat, 10);
  assert.equal(east.swapped, true);
});

test('lat-first wins whenever both orders would work', () => {
  // Both readings are on the globe, so the convention decides - and the
  // convention is the order every format in place.js prints.
  const read = parseCoordinate('35, -84');
  assert.ok(read);
  assert.equal(read.lat, 35);
  assert.equal(read.lon, -84);
  assert.equal(read.swapped, false);

  /*
   * This one is worth pinning down because it looks like the swap case and
   * is not. -84.28 is a perfectly good latitude - it is in Antarctica - so
   * a GeoJSON pair pasted longitude first reads as a point south of
   * everything. Nothing in the string says which was meant, the result is
   * shown before it is acted on, and quietly preferring the reading that
   * lands on land would make the rule unpredictable.
   */
  const ambiguous = parseCoordinate('-84.28, 35.96');
  assert.ok(ambiguous);
  assert.equal(ambiguous.lat, -84.28);
  assert.equal(ambiguous.lon, 35.96);
  assert.equal(ambiguous.swapped, false);
});

test('a place name is not a coordinate', () => {
  for (const text of [
    'Elkmont', 'Hazard KY', 'Mount Elbert 14440', 'Route 66', 'Highway 1',
    'Elk Creek', '', '   ', 'N', 'NW', '35', 'Camp 4', 'I-40 exit 407',
  ]) {
    assert.equal(parseCoordinate(text), null, `${JSON.stringify(text)} parsed as a coordinate`);
  }
});

test('a name whose own letters spell a hemisphere is still a name', () => {
  /*
   * The dangerous shape, and the reason anything that is not a number, a
   * hemisphere letter or a separator disqualifies the whole string.
   *
   * "Trail 6 North 40" offers up a 6, an N and a 40 to a scan that only looks
   * for those, and reads as a point in Somalia. Every one of these came back
   * as a coordinate with that check removed - which is how the check was
   * found to be doing something, since the obvious place names below it all
   * failed on the numbers alone.
   */
  for (const text of [
    'Trail 6 North 40', 'Camp 4 South 20', 'Pit 3 North 9',
    'Bay 7 Slip 22 East', 'Dock 9 South 4', 'Mile 40 North 12',
  ]) {
    assert.equal(parseCoordinate(text), null, `${JSON.stringify(text)} parsed as a coordinate`);
  }
});

test('a point off the globe is refused', () => {
  /*
   * Only pairs with no reading at all are here. "95, 10" and "91.5, -84.28"
   * are deliberately absent: in both, the first number is past the poles and
   * the second is not, so the swap rule places them and they are coordinates.
   * Refusing them would mean refusing every pair written longitude first.
   */
  for (const text of ['95 91', '-91.5, -95.2', '35.96, 181', '35.96, -180.5', '200, 300']) {
    assert.equal(parseCoordinate(text), null, `${text} parsed`);
  }
});

test('minutes and seconds past sixty are refused', () => {
  for (const text of ['35 60 00 N, 84 16 48 W', '35 57 60 N, 84 16 48 W', `35° 60.5'N 84° 16.8'W`]) {
    assert.equal(parseCoordinate(text), null, `${text} parsed`);
  }
});

test('a sign and a letter that disagree are refused rather than guessed at', () => {
  for (const text of ['-35.96S, 84.28W', '35.96N, -84.28W']) {
    assert.equal(parseCoordinate(text), null, `${text} parsed`);
  }
});

test('two letters on the same axis are not a place', () => {
  for (const text of ['35.96N 84.28N', '35.96E 84.28W']) {
    assert.equal(parseCoordinate(text), null, `${text} parsed`);
  }
});

test('a run of numbers that does not divide into two is refused', () => {
  for (const text of ['35 57 36 84 16', '35 57 36 84 16 48 12', '1 2 3']) {
    assert.equal(parseCoordinate(text), null, `${text} parsed`);
  }
});

test('an even run with no separators splits down the middle', () => {
  const read = parseCoordinate('35 57 36 84 16 48');
  assert.ok(read, 'six numbers are two DMS coordinates');
  assert.ok(Math.abs(read.lat - (35 + 57 / 60 + 36 / 3600)) < 1e-9);
  assert.ok(Math.abs(read.lon - (84 + 16 / 60 + 48 / 3600)) < 1e-9);
});

test('a degree sign pasted as a masculine ordinal still reads', () => {
  // What a Windows paste of "35º57'36\"N" actually carries.
  const read = parseCoordinate(`35º57'36"N 84º16'48"W`);
  assert.ok(read);
  assert.ok(Math.abs(read.lat - (35 + 57 / 60 + 36 / 3600)) < 1e-9);
});

test('a unicode minus is still a minus', () => {
  const read = parseCoordinate('35.96, −84.28');
  assert.ok(read);
  assert.equal(read.lon, -84.28);
});

test('fractional degrees cannot carry minutes', () => {
  // 35.5 degrees 30 minutes is two ways of saying a fraction at once, and
  // which one the writer meant is not recoverable.
  assert.equal(parseCoordinate('35.5 30 N, 84 16 W'), null);
});

test('the shape the app puts in a share link round-trips', () => {
  // pinLinkParts writes `p=lat,lon` at six decimals; pasting that pair back
  // into the search box is a thing people will do.
  const read = parseCoordinate('35.960000,-84.280000');
  assert.ok(read);
  assert.equal(read.lat, 35.96);
  assert.equal(read.lon, -84.28);
});
