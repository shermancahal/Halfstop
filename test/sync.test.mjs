/**
 * Tests for the folder sync merge.
 *
 * This decides whether your phone or your laptop wins, and gets it wrong
 * silently if it gets it wrong at all — so it is a pure function, tested
 * without a network or a database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeFolders, rowToFolder, folderToRow, describeSync } from '../assets/js/lib/sync.js';
import { FolderStore } from '../assets/js/lib/folders.js';

const folder = (id, updatedAt, extra = {}) => ({
  id, name: `Folder ${id}`, color: '#b4441f', visible: true, collapsed: false,
  created: 1000, updatedAt, deleted: false, items: [], ...extra,
});

const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
};

/* ------------------------------------------------------------------ merge */

test('merge: a folder only on this device is kept and queued to push', () => {
  const result = mergeFolders([folder('a', 5)], []);
  assert.equal(result.merged.length, 1);
  assert.deepEqual(result.toPush.map((f) => f.id), ['a']);
  assert.equal(result.pulled, 0);
});

test('merge: a folder only on the server is pulled down', () => {
  const result = mergeFolders([], [folder('b', 5)]);
  assert.deepEqual(result.merged.map((f) => f.id), ['b']);
  assert.equal(result.pulled, 1);
  assert.equal(result.toPush.length, 0);
});

test('merge: the newer side wins', () => {
  const serverNewer = mergeFolders([folder('a', 10, { name: 'mine' })], [folder('a', 20, { name: 'theirs' })]);
  assert.equal(serverNewer.merged[0].name, 'theirs');
  assert.equal(serverNewer.pulled, 1);

  const localNewer = mergeFolders([folder('a', 30, { name: 'mine' })], [folder('a', 20, { name: 'theirs' })]);
  assert.equal(localNewer.merged[0].name, 'mine');
  assert.deepEqual(localNewer.toPush.map((f) => f.id), ['a']);
});

test('merge: a change on both sides is reported, not hidden', () => {
  const result = mergeFolders([folder('a', 10, { name: 'phone' })], [folder('a', 20, { name: 'laptop' })]);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].kept, 'server');
  assert.match(describeSync(result), /changed in both places/);
});

test('merge: identical timestamps are left alone and reported as no conflict', () => {
  const result = mergeFolders([folder('a', 42)], [folder('a', 42)]);
  assert.equal(result.merged.length, 1);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.toPush.length, 0);
  assert.equal(describeSync(result), 'Up to date');
});

test('merge: a never-synced local folder is not treated as a conflict', () => {
  // updatedAt 0 means "this device has not stamped it", which is not evidence
  // of an edit — flagging it would cry wolf on every first sign-in.
  const result = mergeFolders([folder('a', 0)], [folder('a', 99)]);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.pulled, 1);
});

test('merge: a server tombstone removes the folder locally', () => {
  const result = mergeFolders([folder('a', 10)], [folder('a', 20, { deleted: true })]);
  assert.equal(result.merged.length, 0, 'the deletion should win');
  assert.equal(result.pulled, 1);
});

test('merge: a tombstone older than a local edit does not delete', () => {
  // Deleted on one device, then edited on this one. The edit is newer, so it
  // wins — resurrecting the folder rather than losing the work.
  const result = mergeFolders([folder('a', 50, { name: 'still wanted' })], [folder('a', 20, { deleted: true })]);
  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0].name, 'still wanted');
});

test('merge: a local tombstone is pushed but not shown', () => {
  const result = mergeFolders([folder('a', 60, { deleted: true })], [folder('a', 30)]);
  assert.equal(result.merged.length, 0);
  assert.deepEqual(result.toPush.map((f) => f.deleted), [true]);
});

test('merge: an empty server does not wipe a device', () => {
  // The failure that would matter most: signing in on a device with folders,
  // against an account that has none, must push rather than delete.
  const local = [folder('a', 5), folder('b', 6), folder('c', 7)];
  const result = mergeFolders(local, []);
  assert.equal(result.merged.length, 3);
  assert.equal(result.toPush.length, 3);
});

test('merge: an empty device does not wipe the server', () => {
  const result = mergeFolders([], [folder('a', 5), folder('b', 6)]);
  assert.equal(result.merged.length, 2);
  assert.equal(result.toPush.length, 0);
});

test('merge: results are ordered by creation, not by side', () => {
  const result = mergeFolders(
    [folder('local', 9, { created: 300 })],
    [folder('remote', 9, { created: 100 })],
  );
  assert.deepEqual(result.merged.map((f) => f.id), ['remote', 'local']);
});

/* ------------------------------------------------------------------ rows */

test('rows: a folder round-trips through the server shape', () => {
  const original = folder('a', 1700000000000, { name: 'Day 2', items: [{ id: 'i1', feature: {} }] });
  const back = rowToFolder(folderToRow(original, 'user-1'));
  assert.equal(back.id, 'a');
  assert.equal(back.name, 'Day 2');
  assert.equal(back.items.length, 1);
  assert.equal(back.updatedAt, original.updatedAt);
});

test('rows: the row carries the owner, which row-level security keys on', () => {
  const row = folderToRow(folder('a', 5), 'user-42');
  assert.equal(row.user_id, 'user-42');
  assert.equal(row.client_id, 'a');
});

/* ------------------------------------------------------------------ store */

test('store: every mutation moves the folder clock forward', () => {
  const store = new FolderStore({ storage: memoryStorage() });
  const created = store.create('Trip');
  const first = store.get(created.id).updatedAt;
  assert.ok(first > 0);

  store.rename(created.id, 'Trip renamed');
  assert.ok(store.get(created.id).updatedAt >= first, 'a rename must be visible to sync');
});

test('store: deleting returns a tombstone with the items stripped', () => {
  const store = new FolderStore({ storage: memoryStorage() });
  const created = store.create('Doomed');
  store.addFeatures(created.id, [{
    type: 'Feature', geometry: { type: 'Point', coordinates: [-84, 36] },
    properties: { kind: 'waypoint', name: 'X' },
  }]);

  const tombstone = store.remove(created.id);
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.items.length, 0, 'a tombstone should not carry data');
  assert.ok(tombstone.updatedAt > 0);
  assert.equal(store.list().length, 0);
});

test('store: replaceAll applies a merge result and drops tombstones', () => {
  const store = new FolderStore({ storage: memoryStorage() });
  store.create('Old');
  store.replaceAll([folder('x', 5, { name: 'From server' }), folder('y', 6, { deleted: true })]);
  assert.deepEqual(store.list().map((f) => f.name), ['From server']);
});

test('store: snapshot is a copy, so the merge cannot mutate live state', () => {
  const store = new FolderStore({ storage: memoryStorage() });
  const created = store.create('Live');
  const snapshot = store.snapshot();
  snapshot[0].name = 'Changed in the copy';
  assert.equal(store.get(created.id).name, 'Live');
});

/*
 * A track goes through the row format whole. Folders sync as one row each and
 * the row carries the items as JSON, so this is the whole of "do tracks sync":
 * the line, its elevation, its stats and its name come back as they went.
 */
test('row: a track round-trips through the row format intact', () => {
  const folder = {
    id: 'f1', name: 'Drive', color: '#a33', visible: true, collapsed: false, updatedAt: 1714557600000,
    items: [{
      id: 'i1',
      feature: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[-84, 36, 300], [-84.1, 36.1, 420], [-84.2, 36.05, 390]] },
        properties: { kind: 'track', name: 'Ridge road', distance_m: 18400, ascent_m: 210 },
      },
    }],
  };
  const back = rowToFolder(folderToRow(folder, 'user-1'));
  assert.deepEqual(back.items, folder.items);
  assert.equal(back.name, 'Drive');
});

/*
 * Nesting travels. Without the column a folder filed inside another would
 * come back from the server at the top, and a sign-in would flatten a tree
 * somebody spent an evening building.
 */
test('sync: which folder a folder is filed under makes the round trip', () => {
  const row = folderToRow({
    id: 'f_child', name: 'Churches', color: '#b4441f', parentId: 'f_parent',
    visible: true, collapsed: false, items: [], updatedAt: 1_700_000_000_000,
  }, 'user-1');
  assert.equal(row.parent_id, 'f_parent');
  assert.equal(rowToFolder({ ...row, client_id: row.client_id }).parentId, 'f_parent');

  // A folder at the top says so as null, both ways.
  const top = folderToRow({ id: 'f_top', name: 'Abandoned', items: [], updatedAt: 1 }, 'user-1');
  assert.equal(top.parent_id, null);
  assert.equal(rowToFolder({ ...top, client_id: top.client_id }).parentId, null);

  // And a row written before the column existed reads as one at the top,
  // rather than as undefined leaking into the tree.
  assert.equal(rowToFolder({ client_id: 'f_old', name: 'Old', items: [] }).parentId, null);
});
