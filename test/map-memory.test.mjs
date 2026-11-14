/**
 * The last map: which basemap and layers the app opens on.
 *
 * Reported: on Byways Topo (Mapbox), the app should open on it every time,
 * or on whatever the account last used. The rules are small and are where it
 * goes wrong quietly - a link that should win losing, an older map on the
 * account overwriting a newer one here, a basemap this build cannot draw.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mapSync, parseMapMemory, sameMap, startingBasemap, worthKeeping } from '../assets/js/lib/map-memory.js';
import { Account } from '../assets/js/lib/account.js';

const map = (basemap, overlays = [], at = '') => ({ basemap, overlays, at });

test('map memory: a saved map is read back, and anything else is nothing', () => {
  assert.deepEqual(parseMapMemory(JSON.stringify(map('mapbox-byways', ['blm'], '2026-11-14T12:00:00Z'))),
    map('mapbox-byways', ['blm'], '2026-11-14T12:00:00Z'));
  assert.deepEqual(parseMapMemory(JSON.stringify({ basemap: 'usgs-topo' })), map('usgs-topo', [], ''));
  for (const junk of ['', 'null', '{', '{"overlays":["blm"]}', '{"basemap":""}', '[1]']) {
    assert.equal(parseMapMemory(junk), null, `"${junk}"`);
  }
  assert.deepEqual(parseMapMemory('{"basemap":"x","overlays":["a",3,null]}').overlays, ['a'], 'only ids');
});

test('map memory: the same map is the same basemap and layers, in any order', () => {
  assert.equal(sameMap(map('a', ['x', 'y'], '1'), map('a', ['y', 'x'], '2')), true, 'when it was saved is not the map');
  assert.equal(sameMap(map('a', ['x']), map('b', ['x'])), false);
  assert.equal(sameMap(map('a', ['x']), map('a', [])), false);
  assert.equal(sameMap(map('a'), null), false);
});

test('map memory: a link wins, then the remembered map, then the default', () => {
  const memory = map('mapbox-byways');
  assert.equal(startingBasemap({ link: 'usgs-topo', memory, fallback: 'byways' }), 'usgs-topo');
  assert.equal(startingBasemap({ memory, fallback: 'byways' }), 'mapbox-byways');
  assert.equal(startingBasemap({ memory: null, fallback: 'byways' }), 'byways');
  // A remembered Mapbox basemap on a build with no Mapbox token is a blank map.
  assert.equal(startingBasemap({ memory, fallback: 'byways', usable: () => false }), 'byways');
});

test('map memory: the newer of the device and the account wins', () => {
  const older = map('usgs-topo', [], '2026-11-01T00:00:00Z');
  const newer = map('mapbox-byways', ['blm'], '2026-11-14T00:00:00Z');
  assert.equal(mapSync({ mine: older, theirs: newer }), 'adopt', 'chosen on the laptop, opened on the phone');
  assert.equal(mapSync({ mine: newer, theirs: older }), 'push');
  assert.equal(mapSync({ mine: newer, theirs: null }), 'push', 'an account with no map yet is given this one');
  assert.equal(mapSync({ mine: null, theirs: newer }), 'adopt', 'a first visit on a new device');
  assert.equal(mapSync({ mine: newer, theirs: { ...newer, at: '2026-11-15T00:00:00Z' } }), 'none', 'they agree');
  assert.equal(mapSync({ mine: null, theirs: null }), 'none');
  // A link is what the reader asked to see: the account does not replace it.
  assert.equal(mapSync({ mine: older, theirs: newer, fromLink: true }), 'none');
  // One choice kept twice - the account's Mapbox map, held here as the
  // basemap this build can draw, at the account's time - is left alone.
  assert.equal(mapSync({ mine: { ...newer, basemap: 'byways-topo' }, theirs: newer }), 'none');
});

test('map memory: only a choice is kept, so a first visit cannot overwrite the account', () => {
  const start = map('byways-topo');
  const chosen = map('mapbox-byways', ['blm']);
  // A new phone opens on the default with nothing remembered: not a choice.
  // Kept, it would be stamped newer than the map picked on the laptop.
  assert.equal(worthKeeping({ now: start, saved: null, atStart: start }), false);
  assert.equal(worthKeeping({ now: chosen, saved: null, atStart: start }), true, 'changing it is');
  // A link's map is not a choice either, until something is changed on it.
  assert.equal(worthKeeping({ now: chosen, saved: start, atStart: chosen, fromLink: true }), false);
  assert.equal(worthKeeping({ now: start, saved: start, atStart: chosen, fromLink: true }), false, 'already kept');
  // A device that remembers a map keeps every change, back to the start too.
  assert.equal(worthKeeping({ now: start, saved: chosen, atStart: start }), true);
  assert.equal(worthKeeping({ now: chosen, saved: chosen, atStart: start }), false, 'nothing new');
});

test('map memory: the account keeps the map in its own metadata, and says nothing when it cannot', async () => {
  const updates = [];
  const client = { auth: { async updateUser(attributes) { updates.push(attributes); return { data: {}, error: null }; } } };
  const account = new Account({ list: () => [] }, { client: async () => client, configured: () => true });

  assert.equal(account.mapPrefs(), null);
  assert.equal(await account.saveMapPrefs(map('a')), false, 'signed out: nothing sent');
  assert.equal(updates.length, 0);

  account.user = { id: 'u1', user_metadata: { display_name: 'Ada', map_prefs: map('mapbox-byways', ['blm'], 't') } };
  assert.deepEqual(account.mapPrefs(), map('mapbox-byways', ['blm'], 't'));
  assert.equal(await account.saveMapPrefs(map('usgs-topo', [], 't2')), true);
  assert.deepEqual(updates, [{ data: { map_prefs: map('usgs-topo', [], 't2') } }],
    'only the map: Supabase merges it in beside the display name');

  account.offline = true;
  assert.equal(await account.saveMapPrefs(map('x')), false, 'no signal: the device keeps its copy');
  account.offline = false;
  account.user.user_metadata.map_prefs = 'not a map';
  assert.equal(account.mapPrefs(), null);
});
