/**
 * The Waypoints tab's orders, and the folder tree every folder menu reads.
 *
 * Asked for as "under all waypoints, add a sorting feature" and "when viewing
 * folder hierarchy under a pin, have it in order as it shows in the Folders
 * list with the sub folders displaying with an indent or bullet".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WAYPOINT_SORTS, sortWaypoints, readSort, addedAt,
} from '../assets/js/lib/waypoint-sort.js';
import { folderTree, treeLabel, UNFILED_ID } from '../assets/js/lib/folders.js';

const stamp = (ms, step = 0) => `i_${ms.toString(36)}_${step.toString(36)}`;
const pin = (name, { id = stamp(0), at = [-74, 44], icon = null, color = null } = {}) => ({
  id,
  feature: { type: 'Feature', geometry: { type: 'Point', coordinates: at }, properties: { kind: 'waypoint', name, icon, color } },
});

const lake = { id: 'f_lake', name: 'Heart Lake' };
const peaks = { id: 'f_peaks', name: 'Adirondack peaks' };
const rows = [
  { folder: lake, item: pin('Marcy Dam', { id: stamp(3000), at: [-73.96, 44.16], color: '#15803d' }) },
  { folder: peaks, item: pin('algonquin', { id: stamp(1000), at: [-73.99, 44.14], color: '#f42410' }) },
  { folder: lake, item: pin('Bear Den', { id: stamp(2000), at: [-74.5, 44.5] }) },
];
const names = (list) => list.map((row) => row.item.feature.properties.name);

test('waypoint sort: every choice in the menu is one the sorter knows', () => {
  for (const sort of WAYPOINT_SORTS) assert.equal(readSort(sort.id), sort.id);
  // And anything else - an old stored value, nothing at all - is A to Z.
  assert.equal(readSort('bogus'), 'name');
  assert.equal(readSort(null), 'name');
});

test('waypoint sort: by name, either way, ignoring case', () => {
  assert.deepEqual(names(sortWaypoints(rows, 'name')), ['algonquin', 'Bear Den', 'Marcy Dam']);
  assert.deepEqual(names(sortWaypoints(rows, 'name-desc')), ['Marcy Dam', 'Bear Den', 'algonquin']);
});

test('waypoint sort: recently added reads the time out of the id', () => {
  assert.deepEqual(addedAt({ id: stamp(1234, 5) }), { time: 1234, step: 5 });
  assert.deepEqual(addedAt({ id: 'whatever' }), { time: 0, step: 0 });
  assert.deepEqual(addedAt(null), { time: 0, step: 0 });
  assert.deepEqual(names(sortWaypoints(rows, 'newest')), ['Marcy Dam', 'Bear Den', 'algonquin']);
  assert.deepEqual(names(sortWaypoints(rows, 'oldest')), ['algonquin', 'Bear Den', 'Marcy Dam']);
  // Two filed in the same millisecond keep the order they were filed in.
  const twins = [
    { folder: lake, item: pin('second', { id: stamp(5000, 2) }) },
    { folder: lake, item: pin('first', { id: stamp(5000, 1) }) },
  ];
  assert.deepEqual(names(sortWaypoints(twins, 'oldest')), ['first', 'second']);
});

test('waypoint sort: nearest the middle of the map, and the unplaceable last', () => {
  const centre = [-73.97, 44.15];
  assert.deepEqual(names(sortWaypoints(rows, 'nearest', { centre })), ['Marcy Dam', 'algonquin', 'Bear Den']);
  const lost = { folder: lake, item: { id: stamp(1), feature: { properties: { name: 'Aaa no place' }, geometry: null } } };
  assert.equal(names(sortWaypoints([lost, ...rows], 'nearest', { centre })).at(-1), 'Aaa no place');
  // No centre to measure from: falls back to the names rather than throwing.
  assert.deepEqual(names(sortWaypoints(rows, 'nearest')), ['algonquin', 'Bear Den', 'Marcy Dam']);
});

test('waypoint sort: by folder follows the Folders list, then the names', () => {
  const sorted = sortWaypoints(rows, 'folder', { folderOrder: ['f_lake', 'f_peaks'] });
  assert.deepEqual(names(sorted), ['Bear Den', 'Marcy Dam', 'algonquin']);
});

test('waypoint sort: by colour goes round the wheel, the plain ones first', () => {
  // Red is first on the wheel and green further round; no colour is before both.
  assert.deepEqual(names(sortWaypoints(rows, 'color')), ['Bear Den', 'algonquin', 'Marcy Dam']);
});

test('waypoint sort: the list it was given is left alone', () => {
  const before = names(rows);
  sortWaypoints(rows, 'name-desc');
  assert.deepEqual(names(rows), before);
});

test('folder tree: the order the Folders list draws, with depth', () => {
  const folders = [
    { id: 'b', name: 'Zion', parentId: null },
    { id: 'a', name: 'Adirondacks', parentId: null },
    { id: 'a2', name: 'Lakes', parentId: 'a' },
    { id: 'a1', name: 'High peaks', parentId: 'a' },
    { id: 'a1x', name: 'Day hikes', parentId: 'a1' },
    { id: UNFILED_ID, name: 'Unfiled', parentId: null },
  ];
  const tree = folderTree(folders).map(({ folder, depth }) => `${depth}:${folder.name}`);
  // The reserved folder first, as the list puts it; then alphabetical, each
  // folder followed by what is filed under it.
  assert.deepEqual(tree, ['0:Unfiled', '0:Adirondacks', '1:High peaks', '2:Day hikes', '1:Lakes', '0:Zion']);
});

test('folder tree: a folder whose parent is gone is still listed', () => {
  const folders = [
    { id: 'a', name: 'Adirondacks' },
    { id: 'o', name: 'Orphan', parentId: 'deleted-elsewhere' },
    { id: 'oc', name: 'Orphan child', parentId: 'o' },
  ];
  const tree = folderTree(folders).map(({ folder, depth }) => `${depth}:${folder.name}`);
  assert.deepEqual(tree, ['0:Adirondacks', '0:Orphan', '1:Orphan child']);
});

test('folder tree: a cycle in hand-edited data does not hang', () => {
  const folders = [
    { id: 'x', name: 'X', parentId: 'y' },
    { id: 'y', name: 'Y', parentId: 'x' },
  ];
  const tree = folderTree(folders);
  assert.equal(tree.length, 2);
});

test('folder tree: a subfolder reads as indented under its parent in a menu', () => {
  assert.equal(treeLabel('Adirondacks', 0), 'Adirondacks');
  const nested = treeLabel('Heart Lake', 1);
  assert.match(nested, /^ +• Heart Lake$/);
  // Deeper is further in.
  assert.ok(treeLabel('Day hikes', 2).indexOf('•') > nested.indexOf('•'));
});
