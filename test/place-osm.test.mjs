/**
 * Place lookups from OpenStreetMap on a free account, from Mapbox on Premium.
 *
 * The two answer in different shapes and the rest of the app knows only one,
 * so these check the translation - Photon's upside-down extent, a state that
 * arrives as a name rather than a code, a country filter Photon does not have
 * - and that the choice between them is made where it is meant to be: at
 * every lookup the viewer makes, from the plan.
 *
 * Neither service is reachable from the test run, so fetch is stood in for
 * and the answers are shaped the way Photon documents them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  lookupProvider, parsePhotonSearch, parsePhotonPlace, searchPlaces, reverseGeocode, PHOTON_URL,
} from '../assets/js/lib/place.js';

const feature = (properties, coordinates = [-109.5, 38.6]) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates }, properties,
});

test('osm: Mapbox only for Premium with a token, OpenStreetMap otherwise', () => {
  assert.equal(lookupProvider({ premium: true, token: 'pk.test' }), 'mapbox');
  assert.equal(lookupProvider({ premium: false, token: 'pk.test' }), 'osm');
  // No token used to mean no search at all; it now means the free one.
  assert.equal(lookupProvider({ premium: true, token: '' }), 'osm');
});

test('osm: search results come back in the Mapbox shape, United States only', () => {
  const results = parsePhotonSearch({
    type: 'FeatureCollection',
    features: [
      feature({
        osm_type: 'N', osm_id: 42, osm_key: 'natural', osm_value: 'peak', type: 'other',
        name: 'Mount Elbert', county: 'Lake County', state: 'Colorado', countrycode: 'US',
        extent: [-106.5, 39.2, -106.4, 39.1],
      }, [-106.445, 39.118]),
      feature({ osm_type: 'R', osm_id: 7, osm_value: 'city', type: 'city', name: 'Paris', countrycode: 'FR' }, [2.35, 48.85]),
      feature({ osm_type: 'W', osm_id: 9, type: 'house', housenumber: '120', street: 'Main Street', city: 'Moab', state: 'Utah', countrycode: 'us' }),
      feature({ osm_type: 'N', osm_id: 3, osm_value: 'ice_cream', type: 'other', name: 'Dairy Stop', city: 'Moab', state: 'Utah', countrycode: 'US' }),
    ],
  });

  assert.deepEqual(results.map((result) => result.name), ['Mount Elbert', '120 Main Street', 'Dairy Stop']);
  const [peak, house, shop] = results;
  assert.equal(peak.kind, 'Peak');
  assert.equal(peak.context, 'Colorado');
  assert.deepEqual(peak.center, [-106.445, 39.118]);
  // Photon's extent is west, north, east, south; a bbox is west, south, east, north.
  assert.deepEqual(peak.bbox, [-106.5, 39.1, -106.4, 39.2]);
  assert.equal(house.kind, 'Address');
  assert.equal(house.context, 'Moab, Utah');
  assert.equal(shop.kind, 'Ice cream', 'an unlisted OpenStreetMap value is still said in words');
  assert.equal(shop.bbox, null);
});

test('osm: a result without a name or a position is left out', () => {
  const results = parsePhotonSearch({
    features: [
      feature({ type: 'other', countrycode: 'US' }),
      { type: 'Feature', geometry: null, properties: { name: 'Nowhere', countrycode: 'US' } },
    ],
  });
  assert.deepEqual(results, []);
  assert.deepEqual(parsePhotonSearch(null), []);
});

test('osm: the nearest place carries the state code the route markers need', () => {
  const place = parsePhotonPlace({
    features: [feature({
      type: 'house', housenumber: '12', street: 'Kane Creek Boulevard', city: 'Moab', state: 'Utah', countrycode: 'US',
    })],
  });
  assert.deepEqual(place, {
    address: '12 Kane Creek Boulevard', place: 'Moab', context: 'Moab, Utah', regionCode: 'UT', regionName: 'Utah',
  });

  // A town answering for itself names no city, only itself.
  const town = parsePhotonPlace({ features: [feature({ type: 'city', name: 'Ouray', state: 'Colorado', countrycode: 'US' })] });
  assert.equal(town.place, 'Ouray');
  assert.equal(town.regionCode, 'CO');

  // States whose own data this app does not carry still get their code.
  assert.equal(parsePhotonPlace({ features: [feature({ state: 'Nevada', countrycode: 'US' })] }).regionCode, 'NV');
  // Outside the United States there are no state markers to choose.
  assert.equal(parsePhotonPlace({ features: [feature({ state: 'British Columbia', countrycode: 'CA' })] }).regionCode, '');
  // Nothing found is an empty answer, not a missing one.
  assert.deepEqual(parsePhotonPlace({ features: [] }), { address: '', place: '', context: '', regionCode: '', regionName: '' });
});

/** Stand in for fetch, answering in turn; returns the URLs asked for. */
function stubFetch(...answers) {
  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const answer = answers.shift() || { status: 200, body: { features: [] } };
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      statusText: '',
      async json() { return answer.body; },
    };
  };
  return { asked, restore: () => { globalThis.fetch = original; } };
}

test('osm: a free search asks Photon, near the map, and says which service answered', async () => {
  const stub = stubFetch({ status: 200, body: { features: [feature({ name: 'Arches', type: 'other', osm_value: 'national_park', countrycode: 'US' })] } });
  try {
    const answer = await searchPlaces('arches', { near: [-109.5, 38.6], provider: 'osm' });
    assert.equal(answer.ok, true);
    assert.equal(answer.provider, 'osm');
    assert.equal(answer.results[0].kind, 'National park');
    assert.equal(stub.asked.length, 1);
    assert.ok(stub.asked[0].startsWith(`${PHOTON_URL}/api/?q=arches`), stub.asked[0]);
    assert.match(stub.asked[0], /&lat=38\.600&lon=-109\.500/);
    assert.doesNotMatch(stub.asked[0], /mapbox/);
  } finally {
    stub.restore();
  }
});

test('osm: a busy Photon is said as busy, not as nothing found', async () => {
  const stub = stubFetch({ status: 429, body: {} });
  try {
    const answer = await searchPlaces('moab', { provider: 'osm' });
    assert.equal(answer.ok, false);
    assert.match(answer.reason, /busy/);
  } finally {
    stub.restore();
  }
});

test('osm: the nearest place is asked within 10 km, and again without if Photon refuses the radius', async () => {
  const stub = stubFetch(
    { status: 400, body: {} },
    { status: 200, body: { features: [feature({ state: 'Wyoming', countrycode: 'US', city: 'Cody' })] } },
  );
  try {
    // A coordinate nobody else in this file asks about, so the cache is cold.
    const place = await reverseGeocode([-109.0567, 44.5263], { provider: 'osm' });
    assert.equal(place.regionCode, 'WY');
    assert.equal(stub.asked.length, 2);
    assert.match(stub.asked[0], /\/reverse\?lon=-109\.056700&lat=44\.526300&lang=en&radius=10$/);
    assert.doesNotMatch(stub.asked[1], /radius/);
  } finally {
    stub.restore();
  }
});

test('osm: every lookup the viewer makes names the provider its plan chose', async () => {
  /*
   * A call that leaves the provider out gets the default, which is
   * OpenStreetMap - so forgetting it at one call site quietly gives Premium
   * the free search there, and nothing fails. Checked at the source instead.
   */
  const viewer = await readFile(new URL('../assets/js/viewer.js', import.meta.url), 'utf8');
  const calls = [...viewer.matchAll(/\b(reverseGeocode|searchPlaces)\(([\s\S]*?)\)\s*(?:\.then|\.catch|;|\))/g)]
    .filter((match) => !/^\s*$/.test(match[2]));
  assert.ok(calls.length >= 4, `found only ${calls.length} lookups in viewer.js`);
  for (const [whole] of calls) {
    assert.match(whole, /provider: lookup\(\)/, `a lookup without the plan's provider: ${whole.slice(0, 80)}`);
  }
  assert.match(viewer, /const lookup = \(\) => lookupProvider\(\{ premium: allowed\('addressSearch'\) \}\);/);
});
