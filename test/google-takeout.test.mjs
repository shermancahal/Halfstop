/**
 * Google Maps saved places, as Google Takeout exports them.
 *
 * The shapes below are Takeout's "Maps (your places)" files, written from its
 * published structure rather than from a real account's export: the current
 * lower-case Saved Places.json, the older capitalised one, and Labeled
 * places.json. What matters is what a person sees afterwards - a name, the
 * note they wrote, the address, a link back to Google - and that the places
 * Google exports at 0,0 are not drawn in the sea off West Africa.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMapFile, positionInGoogleLink } from '../assets/js/lib/parse.js';

const collection = (...features) => JSON.stringify({ type: 'FeatureCollection', features });

const starred = ({ coordinates = [-111.9754, 36.1069], url = 'http://maps.google.com/?cid=1234567890', comment = '' } = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties: {
    date: '2024-05-01T12:00:00Z',
    google_maps_url: url,
    location: { address: 'North Rim, AZ 86052, USA', country_code: 'US', name: 'Grand Canyon Lodge North Rim' },
    ...(comment ? { Comment: comment } : {}),
  },
});

test('google takeout: a starred place arrives named, noted, addressed and linked', async () => {
  const doc = await parseMapFile(collection(starred({ comment: 'Sunset from the porch' })), 'Saved Places.json');
  const [pin] = doc.geojson.features;
  assert.equal(pin.properties.name, 'Grand Canyon Lodge North Rim');
  assert.equal(pin.properties.description, 'Sunset from the porch\n\nNorth Rim, AZ 86052, USA');
  assert.equal(pin.properties.link, 'http://maps.google.com/?cid=1234567890');
  assert.equal(pin.properties.time, Date.parse('2024-05-01T12:00:00Z'));
  assert.equal(pin.properties.kind, 'waypoint');
  assert.deepEqual(pin.geometry.coordinates, [-111.9754, 36.1069]);
  assert.deepEqual(doc.unplaced, []);
  assert.equal(doc.name, 'Saved Places');
});

test('google takeout: a place Google exported at 0,0 is left out and named, not drawn in the sea', async () => {
  const lost = starred({ coordinates: [0, 0] });
  lost.properties.location.name = 'Joe’s Coffee';
  const doc = await parseMapFile(collection(starred(), lost), 'Saved Places.json');
  assert.equal(doc.geojson.features.length, 1);
  assert.deepEqual(doc.unplaced, [{
    name: 'Joe’s Coffee', address: 'North Rim, AZ 86052, USA', link: 'http://maps.google.com/?cid=1234567890',
  }]);
  // And the map is framed round the places that did arrive, not round 0,0.
  assert.ok(doc.bbox[0] < -100 && doc.bbox[2] < -100, `bbox ${doc.bbox}`);
});

test('google takeout: a 0,0 place whose link carries its position is placed from the link', async () => {
  const doc = await parseMapFile(collection(
    starred({ coordinates: [0, 0], url: 'https://www.google.com/maps/search/?api=1&query=36.1069,-111.9754' }),
  ), 'Saved Places.json');
  assert.deepEqual(doc.geojson.features[0].geometry.coordinates, [-111.9754, 36.1069]);
  assert.deepEqual(doc.unplaced, []);
});

test('google takeout: the older export, with capitalised keys and its own coordinates', async () => {
  const doc = await parseMapFile(collection({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: {
      'Google Maps URL': 'http://maps.google.com/?cid=42',
      Location: {
        Address: '1 Main St, Moab, UT', 'Business Name': 'Moab Diner',
        'Geo Coordinates': { Latitude: '38.5733', Longitude: '-109.5498' },
      },
      Published: '2018-06-02T10:00:00Z',
      Title: 'Moab Diner',
    },
  }), 'Saved Places.json');
  const [pin] = doc.geojson.features;
  assert.equal(pin.properties.name, 'Moab Diner');
  assert.equal(pin.properties.link, 'http://maps.google.com/?cid=42');
  assert.equal(pin.properties.description, '1 Main St, Moab, UT');
  assert.deepEqual(pin.geometry.coordinates, [-109.5498, 38.5733]);
});

test('google takeout: labeled places keep their address as the note', async () => {
  const doc = await parseMapFile(collection({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-86.1581, 39.7684] },
    properties: { name: 'Home', address: '1 Monument Cir, Indianapolis, IN' },
  }), 'Labeled places.json');
  assert.equal(doc.geojson.features[0].properties.name, 'Home');
  assert.equal(doc.geojson.features[0].properties.description, '1 Monument Cir, Indianapolis, IN');
});

test('google takeout: GeoJSON from anywhere else is untouched, 0,0 included', async () => {
  // A deliberate point at 0,0 in somebody's own file is theirs to keep.
  const doc = await parseMapFile(collection({
    type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'Null Island buoy' },
  }), 'buoys.geojson');
  assert.equal(doc.geojson.features.length, 1);
  assert.deepEqual(doc.unplaced, []);
});

test('google links: positions are read from every form Google writes them in', () => {
  assert.deepEqual(positionInGoogleLink('https://www.google.com/maps/place/X/@36.1069,-111.9754,17z'), [-111.9754, 36.1069]);
  assert.deepEqual(positionInGoogleLink('https://www.google.com/maps/place/X/data=!4m6!3m5!1s0x1:0x2!8m2!3d36.1069!4d-111.9754'), [-111.9754, 36.1069]);
  assert.deepEqual(positionInGoogleLink('https://maps.google.com/?q=36.1069,-111.9754'), [-111.9754, 36.1069]);
  assert.deepEqual(positionInGoogleLink('https://www.google.com/maps/search/?api=1&query=36.1069%2C-111.9754'), [-111.9754, 36.1069]);
  // A cid names a place without saying where it is.
  assert.equal(positionInGoogleLink('http://maps.google.com/?cid=1234567890'), null);
  assert.equal(positionInGoogleLink('https://maps.google.com/?q=0,0'), null);
  assert.equal(positionInGoogleLink('https://maps.google.com/?q=95,10'), null);
  assert.equal(positionInGoogleLink(''), null);
});
