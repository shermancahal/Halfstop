/**
 * Tests for reading a place out of a reverse-geocode answer.
 *
 * These exist because the geocoder failed silently for as long as it existed.
 * The app asked for `types=address,place,locality,region&limit=5`, and Mapbox
 * answered every one of those requests with:
 *
 *   422  {"message":"limit must be combined with a single type parameter
 *         when reverse geocoding"}
 *
 * `reverseGeocode` returns null on a bad response and every caller reads null
 * as "no answer yet", so nothing anywhere reported a fault. What it cost was
 * the state code, which is what decides the route marker every road on the map
 * draws — so the whole shield feature was generic in all fifty states.
 *
 * The fixtures below are trimmed from real responses captured from CI at a
 * point in Texas and a point in Kentucky, not written from the documentation.
 * Guessing at a service's shape rather than reading it is the most expensive
 * mistake in this project's history, and this is the third instance of it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePlace, parseSearch } from '../assets/js/lib/place.js';

/**
 * Texas, as the API actually returns it with no `types` and no `limit`.
 *
 * Note that the state is in two places at once: as a feature of its own with
 * `short_code` under `properties`, and inside every other feature's `context`
 * with `short_code` at the top level. Same fact, two shapes, and which of them
 * is present varies with the location.
 */
const TEXAS = {
  features: [
    {
      place_type: ['address'],
      text: 'N Fm 200',
      place_name: '1234 N Fm 200, Cleburne, Texas 76033, United States',
      context: [
        { id: 'postcode.1', text: '76033' },
        { id: 'place.2', text: 'Cleburne' },
        { id: 'district.3', text: 'Somervell County' },
        { id: 'region.4', text: 'Texas', short_code: 'US-TX' },
        { id: 'country.5', text: 'United States', short_code: 'us' },
      ],
    },
    { place_type: ['place'], text: 'Cleburne', context: [{ id: 'region.4', text: 'Texas', short_code: 'US-TX' }] },
    { place_type: ['region'], text: 'Texas', properties: { short_code: 'US-TX' }, context: [] },
  ],
};

test('the state comes out of a full reverse-geocode answer', () => {
  const place = parsePlace(TEXAS);
  assert.equal(place.regionCode, 'TX');
  assert.equal(place.regionName, 'Texas');
  assert.equal(place.place, 'Cleburne');
  assert.equal(place.address, '1234 N Fm 200');
  assert.equal(place.context, 'Cleburne, Texas');
});

test('the state comes out of context when there is no region feature', () => {
  /*
   * The case that a fixture built from one lucky location would never cover.
   * Out in open country there is often no address and no region feature at
   * all — just a place with the rest of the hierarchy hanging off it. Reading
   * only the sibling features works everywhere the developer happened to test
   * and nowhere else.
   */
  const contextOnly = { features: [TEXAS.features[1]] };
  const place = parsePlace(contextOnly);
  assert.equal(place.regionCode, 'TX');
  assert.equal(place.place, 'Cleburne');
});

test('a Kentucky point resolves to KY, not to Kentucky', () => {
  // The shield lookup keys on the two-letter code. "Kentucky" finds no design
  // and falls through to the generic marker, which is the failure this whole
  // file is about — so the US- prefix has to come off and the case has to be
  // right.
  const place = parsePlace({
    features: [
      { place_type: ['place'], text: 'Canmer', context: [{ id: 'region.9', text: 'Kentucky', short_code: 'US-KY' }] },
      { place_type: ['region'], text: 'Kentucky', properties: { short_code: 'US-KY' } },
    ],
  });
  assert.equal(place.regionCode, 'KY');
  assert.equal(place.regionName, 'Kentucky');
});

test('an empty or broken answer is survivable, not a throw', () => {
  // reverseGeocode is an enhancement — the map works without it — so nothing
  // here may throw its way up into the caller that draws the panel.
  for (const input of [null, undefined, {}, { features: [] }, { features: [{}] }]) {
    const place = parsePlace(input);
    assert.equal(place.regionCode, '');
    assert.equal(place.regionName, '');
    assert.equal(place.place, '');
  }
});

test('a locality stands in for a place where there is no place', () => {
  const place = parsePlace({
    features: [{ place_type: ['locality'], text: 'Hardyville', context: [{ id: 'region.1', short_code: 'US-KY', text: 'Kentucky' }] }],
  });
  assert.equal(place.place, 'Hardyville');
  assert.equal(place.regionCode, 'KY');
});

/* ------------------------------------------------------------------ search */

test('search: a result carries where it is, not just what it is called', () => {
  /*
   * "Elkmont" is a campground, a town and a ghost town within four miles of
   * each other. A list of three identical words is not a choice, so the row
   * has to say which is which and where each one is.
   */
  const [poi, town] = parseSearch({
    features: [
      {
        id: 'poi.1', text: 'Elkmont Campground', place_name: 'Elkmont Campground, Gatlinburg, Tennessee',
        place_type: ['poi'], center: [-83.58, 35.65],
        properties: { category: 'campground, park' },
        context: [{ id: 'place.9', text: 'Gatlinburg' }, { id: 'region.9', text: 'Tennessee' }],
      },
      {
        id: 'place.2', text: 'Elkmont', place_name: 'Elkmont, Tennessee', place_type: ['place'],
        center: [-83.58, 35.66], bbox: [-83.62, 35.62, -83.54, 35.7],
        context: [{ id: 'region.9', text: 'Tennessee' }],
      },
    ],
  });

  assert.equal(poi.name, 'Elkmont Campground');
  assert.equal(poi.context, 'Gatlinburg, Tennessee', 'the hierarchy comes from context, in order');
  assert.equal(poi.kind, 'Place');
  assert.deepEqual(poi.center, [-83.58, 35.65]);
  assert.equal(poi.bbox, null, 'a point has no extent to fit to');

  assert.equal(town.kind, 'Town', 'a place_type of "place" is a town, not a "place"');
  assert.deepEqual(town.bbox, [-83.62, 35.62, -83.54, 35.7], 'a town does, so the map can frame it');
});

test('search: a feature with nowhere to go is dropped', () => {
  // The list flies the map to `center`. A row that cannot answer where it is
  // would be a search result that does nothing when tapped, which is worse
  // than one fewer result.
  const results = parseSearch({
    features: [
      { id: 'a', text: 'Nowhere', place_type: ['place'] },
      { id: 'b', text: 'Somewhere', place_type: ['place'], geometry: { coordinates: [-84, 36] } },
    ],
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Somewhere');
  assert.deepEqual(results[0].center, [-84, 36], 'geometry.coordinates when there is no center');
});

test('search: nothing to search for is not an error', () => {
  assert.deepEqual(parseSearch(null), []);
  assert.deepEqual(parseSearch({}), []);
});
