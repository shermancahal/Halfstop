/**
 * Tests for the folder store and the GPX writer — the pieces behind organising
 * waypoints into folders and getting them back out again.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FolderStore, fingerprint, packFeature, readTrip, tripStanding, localDay, thinLine, TRACK_POINT_CAP,
} from '../assets/js/lib/folders.js';
import { toGPX } from '../assets/js/lib/gpx-write.js';
import { parseGPX } from '../assets/js/lib/gpx.js';
import { parseMapFile } from '../assets/js/lib/parse.js';

/** In-memory stand-in for localStorage, so tests never touch a real browser API. */
function memoryStorage(initial = null) {
  const map = new Map(initial ? [['ab-maps-folders-v1', initial]] : []);
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
    get size() { return map.size; },
    dump: (key = 'ab-maps-folders-v1') => map.get(key),
  };
}

const waypoint = (name, lon = -84, lat = 36) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat, 300] },
  properties: { kind: 'waypoint', name, symbol: 'Campground', description: 'note' },
});

const track = (name) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: [[-84, 36, 300], [-84.1, 36.1, 400]] },
  properties: { kind: 'track', name, coordTimes: [1714557600000, 1714561200000] },
});

/* ------------------------------------------------------------------ folders */

test('folders: create, rename and remove', () => {
  const store = new FolderStore({ storage: memoryStorage() });
  const folder = store.create('Trip planning');
  assert.equal(store.list().length, 1);
  assert.equal(folder.name, 'Trip planning');

  store.rename(folder.id, '  Fall  colour  run ');
  assert.equal(store.get(folder.id).name, 'Fall colour run');

  store.remove(folder.id);
  assert.equal(store.list().length, 0);
});

test('folders: ensure() reuses a folder by name, case-insensitively', () => {
  const store = new FolderStore({ storage: memoryStorage() });
  const a = store.ensure('Day 1');
  const b = store.ensure('day 1');
  assert.equal(a.id, b.id);
  assert.equal(store.list().length, 1);
});

test('folders: adding features reports added and skipped counts', () => {
  const store = new FolderStore({ storage: memoryStorage() });
  const folder = store.create('Camps');
  const first = store.addFeatures(folder.id, [waypoint('Camp A'), waypoint('Camp B', -84.5)]);
  assert.deepEqual(first, { added: 2, skipped: 0 });

  const second = store.addFeatures(folder.id, [waypoint('Camp A'), waypoint('Camp C', -85)]);
  assert.deepEqual(second, { added: 1, skipped: 1 }, 'the duplicate should be skipped, not re-added');
  assert.equal(store.counts(folder).total, 3);
});

test('folders: de-duplication is by name and position, not object identity', () => {
  assert.equal(fingerprint(waypoint('Camp A')), fingerprint(waypoint('camp a')));
  assert.notEqual(fingerprint(waypoint('Camp A')), fingerprint(waypoint('Camp A', -85)));
});

test('folders: a folder owns copies, so it survives its source going away', () => {
  const store = new FolderStore({ storage: memoryStorage() });
  const folder = store.create('Saved');
  const source = waypoint('Overlook');
  store.addFeatures(folder.id, [source]);

  source.properties.name = 'Renamed after the fact';
  assert.equal(store.get(folder.id).items[0].feature.properties.name, 'Overlook');
});

test('folders: track timestamps are dropped unless explicitly kept', () => {
  assert.equal(packFeature(track('Road')).properties.coordTimes, undefined);
  assert.equal(packFeature(track('Road'), { keepTimes: true }).properties.coordTimes.length, 2);
});

test('folders: moving an item transfers it exactly once', () => {
  const store = new FolderStore({ storage: memoryStorage() });
  const from = store.create('Inbox');
  const to = store.create('Day 2');
  store.addFeatures(from.id, [waypoint('Spring')]);
  const itemId = store.get(from.id).items[0].id;

  assert.equal(store.moveItem(itemId, from.id, to.id), true);
  assert.equal(store.counts(store.get(from.id)).total, 0);
  assert.equal(store.counts(store.get(to.id)).total, 1);
});

test('folders: moving onto a folder that already holds the point does not duplicate it', () => {
  const store = new FolderStore({ storage: memoryStorage() });
  const from = store.create('A');
  const to = store.create('B');
  store.addFeatures(from.id, [waypoint('Spring')]);
  store.addFeatures(to.id, [waypoint('Spring')]);

  store.moveItem(store.get(from.id).items[0].id, from.id, to.id);
  assert.equal(store.counts(store.get(from.id)).total, 0);
  assert.equal(store.counts(store.get(to.id)).total, 1);
});

test('folders: toGeoJSON tags features with their folder and honours visibility', () => {
  const store = new FolderStore({ storage: memoryStorage() });
  const shown = store.create('Shown');
  const hidden = store.create('Hidden');
  store.addFeatures(shown.id, [waypoint('A')]);
  store.addFeatures(hidden.id, [waypoint('B', -85)]);
  store.update(hidden.id, { visible: false });

  const visible = store.toGeoJSON();
  assert.equal(visible.features.length, 1);
  assert.equal(visible.features[0].properties.folderName, 'Shown');
  assert.equal(visible.features[0].properties.folderColor, shown.color);
  assert.ok(visible.features[0].properties.itemId);

  assert.equal(store.toGeoJSON({ visibleOnly: false }).features.length, 2);
});

test('folders: state round-trips through storage', () => {
  const storage = memoryStorage();
  const store = new FolderStore({ storage });
  const folder = store.create('Persisted');
  store.addFeatures(folder.id, [waypoint('Camp'), track('Road')]);
  store.update(folder.id, { visible: false, collapsed: true });

  const reloaded = new FolderStore({ storage });
  assert.equal(reloaded.list().length, 1);
  const restored = reloaded.list()[0];
  assert.equal(restored.name, 'Persisted');
  assert.equal(restored.visible, false);
  assert.equal(restored.collapsed, true);
  assert.deepEqual(reloaded.counts(restored), { waypoints: 1, tracks: 1, total: 2 });
});

test('folders: corrupt stored state starts clean instead of throwing', () => {
  const store = new FolderStore({ storage: memoryStorage('{not json at all') });
  assert.deepEqual(store.list(), []);
});

test('folders: a null storage (private mode) still works in memory', () => {
  const store = new FolderStore({ storage: null });
  const folder = store.create('Ephemeral');
  assert.equal(store.addFeatures(folder.id, [waypoint('A')]).added, 1);
  assert.equal(store.counts(folder).total, 1);
});

test('folders: a failing save reports rather than throwing', () => {
  const storage = {
    getItem: () => null,
    setItem: () => { const error = new Error('full'); error.name = 'QuotaExceededError'; throw error; },
    removeItem: () => {},
  };
  const store = new FolderStore({ storage });
  const folder = store.create('Big');
  assert.equal(store.addFeatures(folder.id, [waypoint('A')]).added, 1, 'in-memory state stays correct');
  assert.match(store.lastError, /Local storage is full/);
});

test('folders: change listeners fire on mutation', () => {
  const store = new FolderStore({ storage: memoryStorage() });
  let calls = 0;
  const off = store.onChange(() => { calls++; });
  const folder = store.create('Watched');
  store.addFeatures(folder.id, [waypoint('A')]);
  assert.equal(calls, 2);
  off();
  store.create('Unwatched');
  assert.equal(calls, 2);
});

test('folders: totals aggregate across folders', () => {
  const store = new FolderStore({ storage: memoryStorage() });
  const a = store.create('A');
  const b = store.create('B');
  store.addFeatures(a.id, [waypoint('1'), waypoint('2', -85)]);
  store.addFeatures(b.id, [track('T')]);
  assert.deepEqual(store.totals(), { folders: 2, waypoints: 2, tracks: 1 });
});

/* ------------------------------------------------------------------ GPX out */

test('gpx-write: a folder export round-trips back through the reader', async () => {
  const store = new FolderStore({ storage: memoryStorage() });
  const folder = store.create('Day 2');
  store.addFeatures(folder.id, [waypoint('Spring at the gap')], { keepTimes: false });
  store.addFeatures(folder.id, [track('Ridge road')], { keepTimes: true });

  const gpx = toGPX(store.folderGeoJSON(folder.id), { name: folder.name });
  const parsed = await parseMapFile(gpx, 'day-2.gpx');

  assert.equal(parsed.name, 'Day 2');
  assert.equal(parsed.stats.waypointCount, 1);
  assert.equal(parsed.stats.trackCount, 1);

  const point = parsed.geojson.features.find((f) => f.properties.kind === 'waypoint');
  assert.equal(point.properties.name, 'Spring at the gap');
  assert.equal(point.properties.symbol, 'Campground');
  assert.equal(point.geometry.coordinates[2], 300);

  const line = parsed.geojson.features.find((f) => f.properties.kind === 'track');
  assert.equal(line.properties.coordTimes.length, 2);
});

test('gpx-write: escapes XML metacharacters in names and descriptions', () => {
  const gpx = toGPX({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-84, 36] },
      properties: { kind: 'waypoint', name: 'Rock & Roll <trailhead>', description: 'say "hi"' },
    }],
  });
  assert.match(gpx, /<name>Rock &amp; Roll &lt;trailhead&gt;<\/name>/);
  assert.match(gpx, /<desc>say &quot;hi&quot;<\/desc>/);
  const reparsed = parseGPX(gpx);
  assert.equal(reparsed.geojson.features[0].properties.name, 'Rock & Roll <trailhead>');
});

test('gpx-write: emits waypoints before tracks regardless of input order', () => {
  const gpx = toGPX({ type: 'FeatureCollection', features: [track('T'), waypoint('W')] });
  assert.ok(gpx.indexOf('<wpt') < gpx.indexOf('<trk'), 'GPX requires wpt before trk');
});

test('gpx-write: multi-segment tracks keep their segment boundaries', async () => {
  const gpx = toGPX({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: {
        type: 'MultiLineString',
        coordinates: [[[-84, 36], [-84.1, 36.1]], [[-84.2, 36.2], [-84.3, 36.3]]],
      },
      properties: { kind: 'track', name: 'Split' },
    }],
  });
  assert.equal((gpx.match(/<trkseg>/g) || []).length, 2);
  const parsed = await parseMapFile(gpx, 'split.gpx');
  assert.equal(parsed.geojson.features[0].geometry.type, 'MultiLineString');
});

test('gpx-write: an empty collection is still a valid document', () => {
  const gpx = toGPX({ type: 'FeatureCollection', features: [] }, { name: 'Empty' });
  assert.match(gpx, /<gpx version="1.1"/);
  assert.match(gpx, /<\/gpx>/);
  assert.equal(parseGPX(gpx).geojson.features.length, 0);
});

test('editItem changes the text you write, not the styling', () => {
  const store = new FolderStore({ storage: memoryStorage() });
  const folder = store.create('Trip');
  store.addFeatures(folder.id, [{
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-84, 35] },
    properties: { name: 'Waypoint 214', kind: 'waypoint', color: '#123456', icon: 'water' },
  }]);

  const [item] = store.get(folder.id).items;
  assert.equal(store.editItem(folder.id, item.id, {
    name: 'Spring below the ford',
    description: 'Runs clear all summer.',
  }), true);

  const props = store.get(folder.id).items[0].feature.properties;
  assert.equal(props.name, 'Spring below the ford');
  assert.equal(props.description, 'Runs clear all summer.');
  // Styling is styleItems' job and must survive a text edit untouched.
  assert.equal(props.color, '#123456');
  assert.equal(props.icon, 'water');
});

test('an emptied description is a deletion, an absent one is not an edit', () => {
  const store = new FolderStore({ storage: memoryStorage() });
  const folder = store.create('Trip');
  store.addFeatures(folder.id, [{
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-84, 35] },
    properties: { name: 'Pin', kind: 'waypoint', description: 'Something here.' },
  }]);
  const [item] = store.get(folder.id).items;

  // Renaming without touching the note must not silently discard it.
  store.editItem(folder.id, item.id, { name: 'Renamed' });
  assert.equal(store.get(folder.id).items[0].feature.properties.description, 'Something here.');

  // Clearing the box is a deletion, and leaves no empty string behind.
  store.editItem(folder.id, item.id, { description: '   ' });
  assert.ok(!('description' in store.get(folder.id).items[0].feature.properties));
});

test('editItem reports a miss rather than throwing', () => {
  const store = new FolderStore({ storage: memoryStorage() });
  const folder = store.create('Trip');
  assert.equal(store.editItem(folder.id, 'nope', { name: 'x' }), false);
  assert.equal(store.editItem('nope', 'nope', { name: 'x' }), false);
});

/* ------------------------------------------------------------------ trips */

test('trips: a window is two days, in order, or nothing at all', () => {
  assert.deepEqual(readTrip({ from: '2026-09-12', to: '2026-09-16' }),
    { from: '2026-09-12', to: '2026-09-16', retired: false });

  // Backwards is a typo, not an intention.
  assert.deepEqual(readTrip({ from: '2026-09-16', to: '2026-09-12' }),
    { from: '2026-09-12', to: '2026-09-16', retired: false });

  // A day trip: one date, and the end defaults to it rather than to nothing.
  assert.deepEqual(readTrip({ from: '2026-09-12' }),
    { from: '2026-09-12', to: '2026-09-12', retired: false });

  /*
   * Rubbish becomes null, not a broken window.
   *
   * A folder carrying { from: 'soon' } would render as "Invalid Date" and
   * there is no control in the app that could repair it — the date fields
   * cannot hold it to show it back to you.
   */
  for (const bad of [null, undefined, {}, { from: '' }, { from: 'soon' }, { from: '2026-13-45' }, 'nope']) {
    assert.equal(readTrip(bad), null, `${JSON.stringify(bad)} should not become a trip`);
  }
});

test('trips: where a trip stands is measured in days, not instants', () => {
  const trip = readTrip({ from: '2026-09-12', to: '2026-09-16' });

  assert.deepEqual(tripStanding(trip, '2026-09-09'), { state: 'ahead', days: 3 });
  assert.deepEqual(tripStanding(trip, '2026-09-12'), { state: 'on', days: 4 });
  assert.deepEqual(tripStanding(trip, '2026-09-14'), { state: 'on', days: 2 });

  /*
   * The last day is still "on".
   *
   * A trip that reads as finished while you are driving it is worse than
   * useless: the folder it names is the one holding the pins you are heading
   * for, and the app stands a finished trip down.
   */
  assert.deepEqual(tripStanding(trip, '2026-09-16'), { state: 'on', days: 0 });
  assert.deepEqual(tripStanding(trip, '2026-09-17'), { state: 'over', days: 1 });
  assert.equal(tripStanding(null, '2026-09-17'), null);
});

test('trips: today is the local day, not the UTC one', () => {
  // Half the planet is on a different date from UTC at any given moment, and a
  // trip that starts "tomorrow" for someone in Sydney is a trip the app would
  // call "on" if it read the UTC day.
  const nearMidnight = new Date(2026, 8, 12, 23, 30);
  assert.equal(localDay(nearMidnight), '2026-09-12');
  const earlyMorning = new Date(2026, 8, 12, 0, 30);
  assert.equal(localDay(earlyMorning), '2026-09-12');
});

test('trips: a folder keeps its window across a save and load', () => {
  const storage = memoryStorage();
  const first = new FolderStore({ storage });
  const trip = first.create('Smokies', { trip: { from: '2026-09-12', to: '2026-09-16' } });
  assert.equal(trip.trip.from, '2026-09-12');

  const second = new FolderStore({ storage });
  assert.deepEqual(second.get(trip.id).trip, { from: '2026-09-12', to: '2026-09-16', retired: false });

  // And a folder that is not a trip stays not a trip.
  const plain = first.create('Saved places');
  assert.equal(new FolderStore({ storage }).get(plain.id).trip, null);
});

test('trips: the window survives the sync merge', () => {
  // `replaceAll` rebuilds every folder from a plain object, so a field it does
  // not copy is a field that vanishes the first time two devices meet.
  const store = new FolderStore({ storage: memoryStorage() });
  store.replaceAll([{
    id: 'f1', name: 'Smokies', items: [],
    trip: { from: '2026-09-12', to: '2026-09-16' },
  }]);
  assert.deepEqual(store.get('f1').trip, { from: '2026-09-12', to: '2026-09-16', retired: false });
});

test('trips: the queue can be reordered, and nothing falls out of it', () => {
  /*
   * A trip is driven in an order, so the order is data. The dangerous case is
   * a stale list — one built before a pin was added on another device — which
   * must reorder what it knows about and lose nothing it does not.
   */
  const store = new FolderStore({ storage: memoryStorage() });
  const folder = store.create('Trip');
  const ids = ['a', 'b', 'c'].map((name) => {
    store.addFeatures(folder.id, [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-84, 36] },
      properties: { kind: 'waypoint', name },
    }]);
    return store.get(folder.id).items.at(-1).id;
  });

  store.reorder(folder.id, [ids[2], ids[0], ids[1]]);
  assert.deepEqual(store.get(folder.id).items.map((item) => item.id), [ids[2], ids[0], ids[1]]);

  // A partial list keeps the rest, in place, at the end.
  store.reorder(folder.id, [ids[1]]);
  assert.deepEqual(store.get(folder.id).items.map((item) => item.id), [ids[1], ids[2], ids[0]]);

  // Ids from somewhere else are ignored rather than inserted as holes.
  store.reorder(folder.id, ['nonsense', ids[0]]);
  assert.deepEqual(store.get(folder.id).items.map((item) => item.id).sort(), [...ids].sort());
  assert.equal(store.get(folder.id).items.length, 3);
});

/*
 * A day's GPS log is twenty thousand points and a folder is one localStorage
 * row, so a stored track is thinned to a budget - keeping its ends, keeping
 * the elevation on every point it keeps, and leaving a short track exactly as
 * it was. Timestamps cannot survive thinning, since they are one per point.
 */
test('folders: a long track is thinned to the budget and a short one is left alone', () => {
  const long = [];
  for (let i = 0; i < 12000; i += 1) {
    // A wandering line, so simplification has real work to do.
    long.push([-84 + i * 0.00005, 36 + Math.sin(i / 7) * 0.0004, 300 + i]);
  }
  const packed = packFeature({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: long },
    properties: { kind: 'track', name: 'All day', coordTimes: long.map((_, i) => i) },
  }, { keepTimes: true });
  const kept = packed.geometry.coordinates;
  assert.ok(kept.length <= TRACK_POINT_CAP, `${kept.length} points is over the cap`);
  assert.ok(kept.length > 100, 'thinned, not gutted');
  assert.deepEqual(kept[0], long[0]);
  assert.deepEqual(kept.at(-1), long.at(-1));
  assert.ok(kept.every((position) => position.length === 3), 'elevation rides along');
  assert.equal(packed.properties.coordTimes, undefined, 'timestamps do not survive thinning');

  const short = track('Short');
  assert.equal(thinLine(short.geometry), short.geometry, 'under the cap, the same object comes back');
  assert.equal(packFeature(short, { keepTimes: true }).properties.coordTimes.length, 2);
});
