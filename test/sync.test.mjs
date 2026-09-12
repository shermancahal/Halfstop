/**
 * Tests for the folder sync merge.
 *
 * This decides whether your phone or your laptop wins, and gets it wrong
 * silently if it gets it wrong at all — so it is a pure function, tested
 * without a network or a database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeFolders, mergeCoEdited, rowToFolder, folderToRow, describeSync, missingColumn,
} from '../assets/js/lib/sync.js';
import { markShared } from '../assets/js/lib/shares.js';
import { REMOVAL_LIFE } from '../assets/js/lib/folders.js';
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

/*
 * Adding a column to the row broke every push for anybody whose database
 * predated it: Postgres rejects the whole row over one unknown column, so a
 * rename, a new pin and a colour change all stopped travelling - not just the
 * nesting it was added for. The client has to be able to send the row without
 * it, and to recognise being told so.
 */
test('sync: a row can be sent without the column a database may not have', () => {
  const folder = { id: 'f_child', name: 'Railroads', parentId: 'f_parent', items: [], updatedAt: 1 };
  const full = folderToRow(folder, 'user-1');
  const older = folderToRow(folder, 'user-1', { withParent: false });

  assert.equal(full.parent_id, 'f_parent');
  assert.equal('parent_id' in older, false, 'the column is absent, not null');
  assert.deepEqual(Object.keys(older), Object.keys(full).filter((key) => key !== 'parent_id'),
    'and nothing else changes with it');
});

test('sync: the two ways a server says it has never heard of the column', () => {
  assert.equal(missingColumn('column folders.parent_id does not exist', 'parent_id'), true);
  assert.equal(missingColumn("Could not find the 'parent_id' column of 'folders' in the schema cache", 'parent_id'), true);

  // Anything else is a real failure and must not be quietly retried away.
  assert.equal(missingColumn('permission denied for table folders', 'parent_id'), false);
  assert.equal(missingColumn('Failed to fetch', 'parent_id'), false);
  assert.equal(missingColumn('', 'parent_id'), false);
  assert.equal(missingColumn(null, 'parent_id'), false);
});

/*
 * The deadlock a database without parent_id left behind.
 *
 * The push went up whole, the server dropped the column it had never heard
 * of, and the row that came back was identical to the one that went except
 * for the nesting. Both sides then held the same updatedAt for ever - each
 * quietly certain it was up to date - so running the migration afterwards
 * fixed nothing, because nothing had a reason to be sent again.
 */
test('merge: at one instant, the side that knows where a folder is filed wins', () => {
  const nested = folder('a', 5, { parentId: 'transport' });
  const flat = folder('a', 5, { parentId: null });

  const laptop = mergeFolders([nested], [flat]);
  assert.equal(laptop.merged[0].parentId, 'transport', 'the filing is kept');
  assert.deepEqual(laptop.toPush.map((f) => f.id), ['a'], 'and sent, though the clocks agree');

  const phone = mergeFolders([flat], [nested]);
  assert.equal(phone.merged[0].parentId, 'transport', 'the flattened copy takes it back');
  assert.equal(phone.pulled, 1);
  assert.deepEqual(phone.toPush, [], 'and has nothing to say back');
});

test('merge: two different parents at one instant is not that, and stays quiet', () => {
  const result = mergeFolders(
    [folder('a', 5, { parentId: 'transport' })],
    [folder('a', 5, { parentId: 'historic' })],
  );
  assert.equal(result.merged[0].parentId, 'transport', 'local is kept, as for any tie');
  assert.deepEqual(result.toPush, []);
  assert.equal(result.pulled, 0);
});

test('merge: a tie over anything but the parent is still quiet', () => {
  const result = mergeFolders(
    [folder('a', 5, { parentId: 'transport' })],
    [folder('a', 5, { parentId: 'transport' })],
  );
  assert.deepEqual(result.toPush, []);
  assert.equal(result.pulled, 0);
});

/* ------------------------------------------------------- co-editing */

/*
 * The case whole-folder last-write-wins gets wrong, and the reason per-item
 * merging exists. Everything below is about two people on one folder, where
 * "the newer save wins" quietly discards somebody's afternoon.
 */

const shared = (id, updatedAt, extra = {}, role = 'editor') => markShared(
  folder(id, updatedAt, extra),
  { ownerId: 'owner-1', ownerName: 'Sherman', role },
);

const item = (id, updatedAt, name = id) => ({
  id,
  updatedAt,
  feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name } },
});

test('co-edit: two people adding different pins keep both', () => {
  const mine = shared('a', 20, { items: [item('p1', 10), item('p2', 20)] });
  const theirs = shared('a', 30, { items: [item('p1', 10), item('p3', 30)] });

  const merged = mergeCoEdited(mine, theirs);
  assert.deepEqual(
    merged.items.map((entry) => entry.id).sort(),
    ['p1', 'p2', 'p3'],
    'neither side loses the pin the other did not have',
  );
});

test('co-edit: editing different pins in one folder keeps both edits', () => {
  // The exact failure of folder-level last-write-wins: their folder is newer,
  // so the whole of it would have won and my rename would have vanished.
  const mine = shared('a', 20, { items: [item('p1', 20, 'my rename'), item('p2', 5)] });
  const theirs = shared('a', 30, { items: [item('p1', 5), item('p2', 30, 'their rename')] });

  const merged = mergeCoEdited(mine, theirs);
  const byId = new Map(merged.items.map((entry) => [entry.id, entry.feature.properties.name]));
  assert.equal(byId.get('p1'), 'my rename');
  assert.equal(byId.get('p2'), 'their rename');
});

test('co-edit: the same pin edited twice keeps the later edit', () => {
  const mine = shared('a', 20, { items: [item('p1', 20, 'mine')] });
  const theirs = shared('a', 30, { items: [item('p1', 30, 'theirs')] });

  assert.equal(mergeCoEdited(mine, theirs).items[0].feature.properties.name, 'theirs');
  assert.equal(mergeCoEdited(theirs, mine).items[0].feature.properties.name, 'theirs');
});

test('co-edit: a deletion travels, rather than being undone by the other side', () => {
  // Absence alone cannot say this: without the tombstone, their copy of p2
  // simply looks like a pin my device has not been told about yet.
  const mine = shared('a', 40, { items: [item('p1', 10)], removedItems: [{ id: 'p2', at: 40 }] });
  const theirs = shared('a', 30, { items: [item('p1', 10), item('p2', 20)] });

  // An explicit clock, because a tombstone is pruned once it is older than the
  // removal life and these timestamps are small numbers rather than real ones.
  const merged = mergeCoEdited(mine, theirs, { now: 100 });
  assert.deepEqual(merged.items.map((entry) => entry.id), ['p1']);
  assert.deepEqual(merged.removedItems, [{ id: 'p2', at: 40 }], 'and stays deleted next time');
});

test('co-edit: a pin edited after it was deleted comes back', () => {
  // Deliberate. The edit is the later statement of what somebody wanted, and
  // an unwanted pin is easier to delete again than a lost edit is to retype.
  const mine = shared('a', 40, { items: [], removedItems: [{ id: 'p1', at: 20 }] });
  const theirs = shared('a', 50, { items: [item('p1', 30, 'still wanted')] });

  const merged = mergeCoEdited(mine, theirs, { now: 100 });
  assert.deepEqual(merged.items.map((entry) => entry.id), ['p1']);
});

test('co-edit: a tombstone older than the removal life stops holding a pin down', () => {
  // The bound on how long a deletion is remembered, and the cost of it: a
  // device that has been in a drawer for longer than this re-adds what it is
  // still carrying. Bounded on purpose - kept for ever, a folder worked on for
  // years carries a record of every pin ever dropped in it.
  const mine = shared('a', 40, { items: [], removedItems: [{ id: 'p1', at: 1000 }] });
  const theirs = shared('a', 50, { items: [item('p1', 500)] });

  const merged = mergeCoEdited(mine, theirs, { now: 1000 + REMOVAL_LIFE + 1 });
  assert.deepEqual(merged.items.map((entry) => entry.id), ['p1']);
  assert.deepEqual(merged.removedItems, [], 'and the tombstone is not carried for ever');
});

test('co-edit: the folder itself goes with the newer save, whole', () => {
  const mine = shared('a', 20, { name: 'Mine', color: '#111111' });
  const theirs = shared('a', 30, { name: 'Theirs', color: '#222222' });

  const merged = mergeCoEdited(mine, theirs);
  assert.equal(merged.name, 'Theirs');
  assert.equal(merged.color, '#222222', 'not half of each');
});

test('co-edit: the role always comes from the server', () => {
  // A withdrawn editor invitation must not keep working because the device
  // that had it kept saving and therefore kept winning the timestamp.
  const mine = shared('a', 90, {}, 'editor');
  const theirs = shared('a', 10, {}, 'viewer');
  assert.equal(mergeCoEdited(mine, theirs).sharedFrom.role, 'viewer');
});

/* --------------------------------------------- co-editing through a sync */

test('sync: a folder shared read-only is never pushed back', () => {
  const mine = shared('a', 99, { items: [item('p1', 99)] }, 'viewer');
  const result = mergeFolders([mine], [], [shared('a', 10, { items: [] }, 'viewer')]);

  assert.deepEqual(result.toPushShared, [], 'looking at it is not editing it');
  assert.deepEqual(result.merged.map((entry) => entry.id), ['a']);
  assert.deepEqual(result.merged[0].items, [], 'the server is what a viewer sees');
});

test('sync: a co-edited folder is pushed when this device added a pin', () => {
  const mine = shared('a', 20, { items: [item('p1', 10), item('p2', 20)] });
  const theirs = shared('a', 20, { items: [item('p1', 10)] });

  const result = mergeFolders([mine], [], [theirs]);
  assert.equal(result.toPushShared.length, 1, 'the timestamps tie, so only the items say so');
  assert.deepEqual(result.toPushShared[0].items.map((entry) => entry.id), ['p1', 'p2']);
});

test('sync: a co-edited folder with nothing new is left alone', () => {
  const both = { items: [item('p1', 10)] };
  const result = mergeFolders([shared('a', 20, both)], [], [shared('a', 20, both)]);
  assert.deepEqual(result.toPushShared, []);
});

test('sync: a shared folder is never offered up as one of your own', () => {
  const result = mergeFolders([shared('a', 20)], [], [shared('a', 20)]);
  assert.deepEqual(result.toPush, [], 'toPush is for folders this account owns');
});

test('sync: a failed read of what is shared keeps what is already in hand', () => {
  // Silence is not the news that every invitation was withdrawn.
  const mine = shared('a', 20, { items: [item('p1', 10)] });
  const result = mergeFolders([mine], [], null);
  assert.deepEqual(result.merged.map((entry) => entry.id), ['a']);
  assert.deepEqual(result.toPushShared, []);
});

test('sync: an invitation withdrawn removes the folder from this device', () => {
  const result = mergeFolders([shared('a', 20)], [], []);
  assert.deepEqual(result.merged, [], 'the server is the authority on what is shared');
});
