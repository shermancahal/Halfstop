/**
 * Google Maps saved lists, from the CSV files Google Takeout writes.
 *
 * The reading is the easy part to get subtly wrong - a note with a comma and
 * a line break in it, the empty row Takeout writes under the header, a link
 * with the position in it that should not be looked up at all. The lookup is
 * the part with consequences outside this app: a free service asked too fast,
 * or a paid one's answers kept against its terms. Both are tested here with a
 * search function standing in for the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  parseCSV, looksLikeGoogleList, readGoogleList, placeInGoogleLink, lookupPlaces, listDocument, LOOKUP_SPACING,
} from '../assets/js/lib/google-list.js';
import { positionInGoogleLink } from '../assets/js/lib/parse.js';

/* A list as Takeout writes one: BOM, CRLF, a blank row under the header, quoted fields. */
const TAKEOUT = '﻿Title,Note,URL,Tags,Comment\r\n'
  + ',,,,\r\n'
  + 'Mesa Arch,"Sunrise, and bring\na headlamp",https://www.google.com/maps/place/Mesa+Arch/data=!4m2!3m1!1s0x874805a8:0x8c3f6c5f,,\r\n'
  + 'Dropped pin,,"https://www.google.com/maps/search/38.3890,+-109.8680",,\r\n'
  + 'Moab Brewery,,"https://www.google.com/maps/place/Moab+Brewery,+686+S+Main+St,+Moab,+UT+84532/data=!4m2",,"The ""good"" one"\r\n'
  + 'Delicate Arch,,"https://www.google.com/maps/place/Delicate+Arch/@38.74,-109.5,15z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d38.7436!4d-109.4993",,\r\n';

test('google list: CSV with quotes, doubled quotes, line breaks and CRLF', () => {
  assert.deepEqual(parseCSV('a,"b, c","say ""hi"""\r\n"two\nlines",,x'), [
    ['a', 'b, c', 'say "hi"'],
    ['two\nlines', '', 'x'],
  ]);
  assert.deepEqual(parseCSV('﻿Title,URL\n'), [['Title', 'URL']]);
});

test('google list: a Takeout list is recognised, and a spreadsheet is not', () => {
  assert.equal(looksLikeGoogleList(TAKEOUT), true);
  assert.equal(looksLikeGoogleList('name,lat,lon\nA,1,2\n'), false);
  assert.equal(looksLikeGoogleList(''), false);
});

test('google list: places are read with their notes, links and any position the link carries', () => {
  const list = readGoogleList(TAKEOUT, 'Want to go.csv');
  assert.equal(list.name, 'Want to go');
  assert.deepEqual(list.places.map((place) => place.name), ['Mesa Arch', 'Dropped pin', 'Moab Brewery', 'Delicate Arch']);

  const [arch, pin, brewery, delicate] = list.places;
  assert.equal(arch.note, 'Sunrise, and bring\na headlamp');
  assert.equal(arch.position, null, 'a place link with no coordinates in it has no position');
  assert.equal(arch.include, false, 'nothing is kept before it is placed');
  assert.deepEqual(pin.position, [-109.868, 38.389]);
  assert.equal(pin.include, true);
  // The exact place in the link beats the @ viewport centre beside it.
  assert.deepEqual(delicate.position, [-109.4993, 38.7436]);
  // The link's own words, when they carry the street and town, are what is searched.
  assert.equal(brewery.query, 'Moab Brewery, 686 S Main St, Moab, UT 84532');
  assert.equal(arch.query, 'Mesa Arch');
  assert.equal(brewery.note, 'The "good" one');
});

test('google list: a row with no title takes its name from the link', () => {
  const list = readGoogleList('Title,Note,URL\n,,https://www.google.com/maps/place/Green+River+Overlook/data=!4m2\n', 'x.csv');
  assert.equal(list.places[0].name, 'Green River Overlook');
  assert.equal(placeInGoogleLink('https://www.google.com/maps/place/data=!4m2'), '');
  assert.throws(() => readGoogleList('name,lat\n', 'x.csv'), /not a Google Maps saved list/);
});

test('google list: a dropped pin’s link is read as the position it is', () => {
  assert.deepEqual(positionInGoogleLink('https://www.google.com/maps/search/44.5263,-109.0567'), [-109.0567, 44.5263]);
  assert.deepEqual(positionInGoogleLink('https://www.google.com/maps/search/44.5263,+-109.0567'), [-109.0567, 44.5263]);
  assert.equal(positionInGoogleLink('https://www.google.com/maps/search/coffee+near+me'), null);
});

/** A search that answers from a table and records what it was asked. */
function fakeSearch(table = {}) {
  const asked = [];
  const search = async (query, options) => {
    asked.push({ query, ...options });
    const answer = table[`${options.provider}:${query}`] ?? table[options.provider] ?? { ok: true, results: [] };
    return typeof answer === 'function' ? answer(query, options) : answer;
  };
  return { asked, search };
}

const hit = (name, center = [-109.8, 38.4]) => ({ ok: true, results: [{ name, kind: 'Peak', context: 'Utah', center }] });

/** A clock that only moves when the code under test waits. */
function fakeClock() {
  let time = 0;
  const waits = [];
  return { waits, now: () => time, wait: async (ms) => { waits.push(ms); time += ms; } };
}

test('google list: a free account asks OpenStreetMap only, worldwide, spaced out, once per name', async () => {
  const places = readGoogleList(
    'Title,URL\nMesa Arch,x\nMesa Arch,y\nTour Eiffel,z\nPinned,"https://www.google.com/maps/search/38.1,-109.2"\n',
    'l.csv',
  ).places;
  const { asked, search } = fakeSearch({ osm: hit('Found') });
  const clock = fakeClock();
  const progress = [];
  const outcome = await lookupPlaces(places, {
    search, provider: 'osm', wait: clock.wait, now: clock.now, onProgress: (done, total) => progress.push([done, total]),
  });

  assert.deepEqual(asked.map((call) => call.query), ['Mesa Arch', 'Tour Eiffel'], 'a repeated name is asked once, a linked place never');
  assert.ok(asked.every((call) => call.provider === 'osm' && call.anywhere === true && call.permanent === false));
  // Two a second at most: the second request waited out the gap.
  assert.deepEqual(clock.waits, [LOOKUP_SPACING.osm]);
  assert.deepEqual(progress.at(-1), [3, 3]);
  assert.equal(outcome.looked, 3);
  assert.ok(places.slice(0, 3).every((place) => place.include && place.candidates[0].provider === 'osm'));
});

test('google list: Premium asks Mapbox’s permanent geocoding first, and OpenStreetMap for what it misses', async () => {
  const places = readGoogleList('Title,URL\nMesa Arch,x\nObscure Spring,y\n', 'l.csv').places;
  const { asked, search } = fakeSearch({
    'mapbox:Mesa Arch': hit('Mesa Arch'),
    'mapbox:Obscure Spring': { ok: true, results: [] },
    'osm:Obscure Spring': hit('Obscure Spring'),
  });
  const clock = fakeClock();
  await lookupPlaces(places, { search, provider: 'mapbox', wait: clock.wait, now: clock.now });

  assert.deepEqual(asked.map((call) => `${call.provider}:${call.query}`),
    ['mapbox:Mesa Arch', 'mapbox:Obscure Spring', 'osm:Obscure Spring']);
  // Kept answers from Mapbox must come from the permanent service.
  assert.ok(asked.filter((call) => call.provider === 'mapbox').every((call) => call.permanent === true));
  assert.equal(places[0].candidates[0].provider, 'mapbox');
  assert.equal(places[1].candidates[0].provider, 'osm');
});

test('google list: a Mapbox refusal is heard once, and a busy Mapbox is not a refusal', async () => {
  const refusing = readGoogleList('Title,URL\nA,x\nB,y\nC,z\n', 'l.csv').places;
  const refused = fakeSearch({ mapbox: { ok: false, status: 403, results: [] }, osm: hit('Found') });
  const outcome = await lookupPlaces(refusing, { search: refused.search, provider: 'mapbox', wait: async () => {} });
  assert.equal(outcome.mapboxRefused, true);
  assert.deepEqual(refused.asked.map((call) => call.provider), ['mapbox', 'osm', 'osm', 'osm']);

  const busy = fakeSearch({ mapbox: { ok: false, status: 429, results: [] }, osm: hit('Found') });
  const second = await lookupPlaces(readGoogleList('Title,URL\nA,x\nB,y\n', 'l.csv').places,
    { search: busy.search, provider: 'mapbox', wait: async () => {} });
  assert.equal(second.mapboxRefused, false);
  assert.deepEqual(busy.asked.map((call) => call.provider), ['mapbox', 'osm', 'mapbox', 'osm']);
});

test('google list: stopping keeps what was found and says it stopped', async () => {
  const places = readGoogleList('Title,URL\nA,x\nB,y\nC,z\n', 'l.csv').places;
  const { search } = fakeSearch({ osm: hit('Found') });
  let calls = 0;
  const outcome = await lookupPlaces(places, { search, provider: 'osm', wait: async () => {}, stopped: () => calls++ >= 1 });
  assert.equal(outcome.stoppedEarly, true);
  assert.equal(outcome.looked, 1);
  assert.equal(places[0].include, true);
  assert.equal(places[1].include, false);
});

test('google list: what is kept becomes a document of waypoints, named as the list named them', async () => {
  const list = readGoogleList(TAKEOUT, 'Want to go.csv');
  const { search } = fakeSearch({
    'osm:Mesa Arch': { ok: true, results: [{ name: 'Mesa Arch', kind: 'Peak', context: 'Utah', center: [-109.868, 38.389], provider: 'osm' }] },
    'osm:Moab Brewery, 686 S Main St, Moab, UT 84532': { ok: true, results: [] },
  });
  await lookupPlaces(list.places, { search, provider: 'osm', wait: async () => {} });
  // The person unticked one of the linked places in the review.
  list.places[3].include = false;

  const doc = listDocument(list.name, list.places);
  const features = doc.geojson.features;
  assert.deepEqual(features.map((feature) => feature.properties.name), ['Mesa Arch', 'Dropped pin']);
  const [arch, pin] = features;
  assert.equal(arch.properties.kind, 'waypoint');
  assert.equal(arch.properties.description, 'Sunrise, and bring\na headlamp');
  assert.match(arch.properties.link, /maps\/place\/Mesa\+Arch/);
  assert.equal(arch.properties.address, 'Mesa Arch, Utah');
  assert.equal(arch.properties.located, 'OpenStreetMap');
  assert.equal(pin.properties.located, undefined, 'a position from the link needs no credit');
  assert.deepEqual(doc.bbox, [-109.868, 38.389, -109.868, 38.389]);
  assert.equal(doc.name, 'Want to go');
  assert.ok(doc.stats, 'the document carries the totals the file list shows');
});

test('google list: the map accepts a CSV and sends it to the review, not the file readers', async () => {
  const [page, viewer] = await Promise.all([
    readFile(new URL('../map.html', import.meta.url), 'utf8'),
    readFile(new URL('../assets/js/viewer.js', import.meta.url), 'utf8'),
  ]);
  assert.match(page, /id="file-input"[^>]*accept="[^"]*\.csv/);
  const handle = viewer.slice(viewer.indexOf('async function handleFiles(files'));
  assert.match(handle.slice(0, 1200), /reviewGoogleLists\(lists\)/);
  // The review looks places up with the plan's provider, like every other lookup.
  assert.match(viewer, /lookupPlaces\(places, \{\s*search: searchPlaces,\s*provider,/);
  assert.match(viewer, /const provider = lookup\(\);/);
});
