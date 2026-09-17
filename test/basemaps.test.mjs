/**
 * The basemap list, as the picker will read it.
 *
 * The picker groups by `group` and keeps array order inside each group, so the
 * order here is the order on screen. That makes this list a piece of interface
 * that happens to live in a config file, and interface that nothing checks is
 * interface that drifts back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BASEMAPS, DEFAULT_BASEMAP } from '../assets/js/config.js';

/** What the picker builds: group in first-seen order, entries in array order. */
function asPicker(list = BASEMAPS) {
  const groups = new Map();
  for (const basemap of list) {
    if (!groups.has(basemap.group)) groups.set(basemap.group, []);
    groups.get(basemap.group).push(basemap.name);
  }
  return groups;
}

test('the two USGS topos sit together, current series first', () => {
  const topographic = asPicker().get('Topographic');
  const modern = topographic.indexOf('USGS Topo Modern');
  const classic = topographic.indexOf('USGS Topo Classic');
  const hybrid = topographic.indexOf('USGS Imagery + Topo');

  assert.ok(modern >= 0, 'USGS Topo Modern is not in the Topographic group');
  assert.ok(classic >= 0, 'USGS Topo Classic is not in the Topographic group');
  assert.ok(hybrid >= 0, 'USGS Imagery + Topo is not in the Topographic group');

  assert.equal(classic, modern + 1,
    'the scanned quads should sit directly under the current series, not across the hybrid from it');
  assert.equal(hybrid, classic + 1,
    'the imagery hybrid comes after both topos, being neither of them');
});

test('neither USGS topo is named in a way that makes it a footnote', () => {
  const names = BASEMAPS.map((basemap) => basemap.name);
  // The old pair was "USGS Topo" and "USGS Topo (classic)", which read as one
  // map and one asterisk rather than as two surveys to choose between.
  assert.ok(!names.includes('USGS Topo'), 'the bare name is ambiguous now that there are two');
  assert.ok(!names.some((name) => /\(classic\)/i.test(name)), 'the parenthetical is gone');
});

test('the ids are untouched by the renaming', () => {
  /*
   * Ids travel. They are the `?b=` on every shared link and they are written
   * into a downloaded offline region, so renaming one breaks links that are
   * already out in the world - which a display-name change never does.
   */
  const ids = BASEMAPS.map((basemap) => basemap.id);
  for (const id of ['byways-topo', 'usgs-topo', 'usgs-classic', 'usgs-imagery-topo', 'esri-imagery', 'osm']) {
    assert.ok(ids.includes(id), `${id} is missing`);
  }
});

test('every basemap has the fields the picker draws', () => {
  for (const basemap of BASEMAPS) {
    assert.ok(basemap.id, 'a basemap with no id');
    assert.ok(basemap.name, `${basemap.id} has no name`);
    assert.ok(basemap.group, `${basemap.id} has no group`);
    assert.ok(basemap.description, `${basemap.id} has no description`);
  }
});

test('the default basemap is one of them', () => {
  assert.ok(BASEMAPS.some((basemap) => basemap.id === DEFAULT_BASEMAP));
});

test('no two basemaps share an id or a name', () => {
  const ids = BASEMAPS.map((basemap) => basemap.id);
  const names = BASEMAPS.map((basemap) => basemap.name);
  assert.equal(new Set(ids).size, ids.length, 'two basemaps share an id');
  assert.equal(new Set(names).size, names.length, 'two basemaps share a name');
});

/* ---------------------------------------------------------------- premium */

import { featureForLayer, can, gateReason, TIERS, FEATURES } from '../assets/js/lib/tiers.js';

const LIVE = { live: true, plans: {}, defaultPlan: 'month', currency: 'USD', store: 'none', testers: [] };
const OFF = { ...LIVE, live: false };

/** The three drawn from Mapbox, which is the thing that is metered per view. */
const METERED = ['byways-topo-mapbox', 'mapbox-outdoors', 'mapbox-satellite-streets'];

test('the metered basemaps are the ones marked premium, and only those', () => {
  const marked = BASEMAPS.filter((basemap) => basemap.premium).map((basemap) => basemap.id);
  assert.deepEqual(marked.slice().sort(), METERED.slice().sort());
});

test('the free maps are left alone', () => {
  /*
   * Named individually rather than derived as "everything else", so that a
   * basemap added later with premium on it fails this and has to be thought
   * about. The public services and our own archive are the whole free list.
   */
  for (const id of ['byways-topo', 'usgs-topo', 'usgs-classic', 'usgs-imagery-topo',
    'esri-imagery', 'usgs-imagery', 'osm']) {
    const basemap = BASEMAPS.find((entry) => entry.id === id);
    assert.ok(basemap, `${id} is missing`);
    assert.ok(!basemap.premium, `${id} should not be behind the paid plan`);
  }
});

test('Byways Topo is never the one behind the gate', () => {
  /*
   * The trap that made this an explicit flag rather than a derivation. Byways
   * Topo falls back to Mapbox geometry when no Protomaps archive is
   * configured, so a rule of "draws from Mapbox, therefore paid" would lock
   * the default basemap on any deploy that has not cut an archive - which is
   * every fresh clone.
   */
  const byways = BASEMAPS.find((basemap) => basemap.id === 'byways-topo');
  assert.equal(featureForLayer(byways), null);
  assert.equal(byways.id, DEFAULT_BASEMAP, 'and it is still the default');
});

test('a premium basemap asks for the feature the Premium tier grants', () => {
  for (const id of METERED) {
    const basemap = BASEMAPS.find((entry) => entry.id === id);
    assert.equal(featureForLayer(basemap), 'extraBasemaps', id);
  }
  assert.ok(Object.hasOwn(FEATURES, 'extraBasemaps'), 'the feature has to exist to be gated on');
  assert.ok(TIERS.premium.grants.includes('extraBasemaps'), 'Premium has to actually include it');
  assert.ok(!TIERS.free.grants.includes('extraBasemaps'), 'Free must not');
});

test('nothing is locked while billing is off', () => {
  // Today. can() is true for everything until there is a server-side half to
  // close it against, so every row draws exactly as it always has.
  assert.equal(can('extraBasemaps', { billing: OFF }), true);
  assert.equal(can('extraBasemaps', { tier: TIERS.free, billing: OFF }), true);
});

test('and locked for Free, not Premium, once it is on', () => {
  assert.equal(can('extraBasemaps', { tier: TIERS.free, billing: LIVE }), false);
  assert.equal(can('extraBasemaps', { tier: TIERS.premium, billing: LIVE }), true);
});

test('the locked row names the thing rather than saying "upgrade"', () => {
  const reason = gateReason('extraBasemaps', { tier: TIERS.free });
  assert.match(reason, /Extra basemaps/);
  assert.match(reason, /Free/);
});
