/**
 * Photos on pins, between devices.
 *
 * The rules that decide what is uploaded, where it lives and what is taken
 * down, and the account's three calls to storage - with a fake client, since
 * what is under test is what this code asks for. What the bucket then allows
 * is the server's half, probed against the live project: supabase/rls-probe.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  PHOTO_BUCKET, PHOTO_SYNC_LIMIT, photoPath, isUploaded, photosToUpload, ownUploads,
} from '../assets/js/lib/photo-sync.js';
import { FolderStore } from '../assets/js/lib/folders.js';
import { folderToRow, rowToFolder } from '../assets/js/lib/sync.js';
import { Account } from '../assets/js/lib/account.js';

const ME = '4190718c-9134-4af3-bfcb-0f857938cd05';
const pin = (id, photos) => ({
  id,
  feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [-84, 36] }, properties: { kind: 'waypoint', name: id, photos } },
});

test('photo sync: a photo with no uploader is waiting; one with an uploader is there', () => {
  assert.equal(isUploaded({ id: 'p1' }), false);
  assert.equal(isUploaded({ id: 'p1', by: '' }), false);
  assert.equal(isUploaded({ id: 'p1', by: ME }), true);
  assert.equal(photoPath(ME, 'p1'), `${ME}/p1`);
  assert.equal(PHOTO_BUCKET, 'pin-photos');
  // The bucket's own limit, which supabase/schema.sql sets in bytes.
  assert.equal(PHOTO_SYNC_LIMIT, 262144);
});

test('photo sync: uploads what this device may record, and nothing else', () => {
  const folders = [
    { id: 'mine', items: [pin('a', [{ id: 'p1' }, { id: 'p2', by: ME }])] },
    { id: 'gone', deleted: true, items: [pin('b', [{ id: 'p3' }])] },
    // Shared to look at: recording an upload would be a change to their folder.
    { id: 'viewed', sharedFrom: { role: 'viewer' }, items: [pin('c', [{ id: 'p4' }])] },
    // Shared to work on: this device's photos on it are this device's to upload.
    { id: 'edited', sharedFrom: { role: 'editor' }, items: [pin('d', [{ id: 'p5' }])] },
  ];
  assert.deepEqual(photosToUpload(folders), [
    { folderId: 'mine', itemId: 'a', photoId: 'p1' },
    { folderId: 'edited', itemId: 'd', photoId: 'p5' },
  ]);
  assert.deepEqual(photosToUpload([]), []);
  assert.deepEqual(photosToUpload([null, { id: 'x' }]), []);
});

test('photo sync: takes down only its own uploads, and not one still on another pin', () => {
  const items = [pin('a', [{ id: 'p1', by: ME }, { id: 'p2', by: 'someone-else' }, { id: 'p3' }, { id: 'p4', by: ME }])];
  assert.deepEqual(ownUploads(items, ME), [`${ME}/p1`, `${ME}/p4`]);
  assert.deepEqual(ownUploads(items, ME, { stillUsed: ['p4'] }), [`${ME}/p1`]);
  assert.deepEqual(ownUploads(items, ''), []);
  // The same photo on two removed pins is one path, not two.
  assert.deepEqual(ownUploads([pin('a', [{ id: 'p1', by: ME }]), pin('b', [{ id: 'p1', by: ME }])], ME), [`${ME}/p1`]);
});

function memoryStore() {
  const memory = new Map();
  const storage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
  };
  return new FolderStore({ storage, vault: null });
}

test('photo sync: an upload is recorded on the pin, in one announcement, and travels', () => {
  const store = memoryStore();
  const folder = store.create('Trip');
  store.addFeatures(folder.id, [pin('x', []).feature]);
  const item = store.get(folder.id).items[0];
  store.addPhotos(folder.id, item.id, [{ id: 'p1', name: 'one.webp' }, { id: 'p2' }]);

  let announced = 0;
  store.onChange(() => { announced += 1; });
  const marked = store.markPhotosUploaded([
    { folderId: folder.id, itemId: item.id, photoId: 'p1' },
    { folderId: folder.id, itemId: item.id, photoId: 'p2' },
    { folderId: folder.id, itemId: 'nope', photoId: 'p9' },
  ], ME);
  assert.equal(marked, 2);
  assert.equal(announced, 1, 'one announcement for the batch');
  const photos = store.get(folder.id).items[0].feature.properties.photos;
  assert.deepEqual(photos.map((photo) => photo.by), [ME, ME]);
  assert.equal(photos[0].name, 'one.webp', 'the rest of the record is kept');
  assert.deepEqual(photosToUpload(store.list()), []);

  // Again is nothing, and says nothing.
  assert.equal(store.markPhotosUploaded([{ folderId: folder.id, itemId: item.id, photoId: 'p1' }], ME), 0);
  assert.equal(store.markPhotosUploaded([{ folderId: folder.id, itemId: item.id, photoId: 'p1' }], ''), 0);

  // Through the database row and back, which is how another device gets it.
  const row = folderToRow(store.get(folder.id), ME);
  const back = rowToFolder({ ...row, updated_at: new Date().toISOString() });
  assert.deepEqual(back.items[0].feature.properties.photos.map((photo) => photo.by), [ME, ME]);

  // And through this device's own storage.
  const again = new FolderStore({ storage: store.storage, vault: null });
  again.load();
  assert.deepEqual(again.get(folder.id).items[0].feature.properties.photos.map((photo) => photo.by), [ME, ME]);
});

function storageClient({ uploadError = null, download = null, downloadError = null } = {}) {
  const calls = [];
  return {
    calls,
    storage: {
      from(bucket) {
        return {
          async upload(path, blob, options) {
            calls.push(['upload', bucket, path, blob.type, options]);
            return { data: uploadError ? null : { path }, error: uploadError };
          },
          async download(path) {
            calls.push(['download', bucket, path]);
            return { data: downloadError ? null : download, error: downloadError };
          },
          async remove(paths) {
            calls.push(['remove', bucket, paths]);
            return { data: [], error: null };
          },
        };
      },
    },
  };
}

function signedIn(client) {
  const account = new Account({ list: () => [] }, { client: async () => client, configured: () => true });
  account.user = { id: ME, email: 'me@example.com' };
  return account;
}

test('photo sync: uploading puts the photo in this account\'s place, never over another', async () => {
  const client = storageClient();
  const account = signedIn(client);
  const blob = new Blob(['x'], { type: 'image/webp' });
  assert.deepEqual(await account.uploadPhoto('p1', blob), { ok: true });
  const [, bucket, path, type, options] = client.calls[0];
  assert.equal(bucket, 'pin-photos');
  assert.equal(path, `${ME}/p1`);
  assert.equal(type, 'image/webp');
  assert.equal(options.upsert, false, 'a photo is never replaced in place');
  assert.equal(options.contentType, 'image/webp');
});

test('photo sync: a photo already there counts as uploaded; a refusal says why', async () => {
  const there = signedIn(storageClient({ uploadError: { statusCode: '409', message: 'The resource already exists' } }));
  assert.deepEqual(await there.uploadPhoto('p1', new Blob(['x'], { type: 'image/webp' })), { ok: true });

  const refused = signedIn(storageClient({ uploadError: { statusCode: '403', message: 'new row violates row-level security policy' } }));
  const result = await refused.uploadPhoto('p1', new Blob(['x'], { type: 'image/webp' }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /row-level security/);
});

test('photo sync: no session, or no signal, is not an upload attempt', async () => {
  const client = storageClient();
  const account = signedIn(client);
  account.offline = true;
  assert.deepEqual(await account.uploadPhoto('p1', new Blob(['x'])), { ok: false, reason: 'offline' });
  assert.equal(await account.downloadPhoto(ME, 'p1'), null);
  account.offline = false;
  account.user = null;
  assert.deepEqual(await account.uploadPhoto('p1', new Blob(['x'])), { ok: false, reason: 'offline' });
  assert.equal(client.calls.length, 0);
});

test('photo sync: downloading asks the uploader\'s place and hands back the picture', async () => {
  const picture = new Blob(['img'], { type: 'image/webp' });
  const client = storageClient({ download: picture });
  const account = signedIn(client);
  assert.equal(await account.downloadPhoto('their-id', 'p7'), picture);
  assert.deepEqual(client.calls[0], ['download', 'pin-photos', 'their-id/p7']);

  const missing = signedIn(storageClient({ downloadError: { message: 'Object not found' } }));
  assert.equal(await missing.downloadPhoto('their-id', 'p7'), null);
  assert.equal(await account.downloadPhoto('', 'p7'), null);
});

test('photo sync: removing asks for exactly the paths it was given', async () => {
  const client = storageClient();
  const account = signedIn(client);
  await account.removePhotos([`${ME}/p1`, `${ME}/p2`]);
  assert.deepEqual(client.calls, [['remove', 'pin-photos', [`${ME}/p1`, `${ME}/p2`]]]);
  await account.removePhotos([]);
  assert.equal(client.calls.length, 1, 'nothing to remove is no request');
});

test('photo sync: the server half - a private bucket, Premium to upload, no overwrites', async () => {
  const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  const section = schema.slice(schema.indexOf('-- pin photos'));
  assert.match(section, /values \('pin-photos', 'pin-photos', false, 262144/);
  assert.match(section, /for insert[\s\S]*?private\.holds_premium\(\(select auth\.uid\(\)\)\)/);
  assert.match(section, /for select[\s\S]*?private\.pin_photo_visible\(name\)/);
  assert.match(section, /for delete[\s\S]*?\(storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)\)::text/);
  assert.doesNotMatch(section, /on storage\.objects\s+for update/, 'a photo is never changed in place');
  // Reading never asks about a plan: a lapsed subscription keeps its pictures.
  const read = section.slice(section.indexOf('for select'), section.indexOf('for delete'));
  assert.doesNotMatch(read, /holds_premium/);
});

test('photo sync: closing an account takes its photos with it, before anything else', async () => {
  const source = await readFile(new URL('../supabase/functions/delete-account/index.ts', import.meta.url), 'utf8');
  const photos = source.indexOf('await removePhotos(admin, user.id)');
  const rows = source.indexOf('.from(TABLE).delete()');
  const user = source.indexOf('auth.admin.deleteUser');
  assert.ok(photos > 0, 'photos are removed');
  assert.ok(photos < rows && rows < user, 'photos, then rows, then the account');
  assert.match(source, /const PHOTOS = 'pin-photos'/);
});
