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
