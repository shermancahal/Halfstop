/**
 * A download that is still there after a refresh, and says so.
 *
 * Reported as offline downloads not sticking: after an update and a reload,
 * no sign of them. Nothing recorded that a region had been downloaded - the
 * "tiles saved" line lived in the row and went with it - so every region
 * offered "Download for offline" again. The list under Folders counted only
 * Byways Topo's archive, so a region taken on USGS Topo or an aerial said
 * "not downloaded" for ever. The archive stamp a download wrote was dropped
 * by the store. And removing a stale service worker deleted the downloaded
 * tiles along with the app's own cache.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  OfflineStore, TILE_CACHE, SAVED_SAMPLE, spreadSample, presentSample, savedRecord, savedPresence,
  describeSaved,
} from '../assets/js/lib/offline.js';

function fakeStorage(seed = {}) {
  const held = new Map(Object.entries(seed));
  return {
    getItem: (key) => (held.has(key) ? held.get(key) : null),
    setItem: (key, value) => { held.set(key, String(value)); },
    removeItem: (key) => { held.delete(key); },
  };
}

const BOX = { west: -84.2, south: 35.5, east: -83.9, north: 35.8 };

test('offline keep: a download is remembered across a reload, archive stamp and all', () => {
  const storage = fakeStorage();
  const store = new OfflineStore({ storage });
  const region = store.add({ name: 'Cades Cove', bounds: BOX, minZoom: 8, maxZoom: 13 });
  store.update(region.id, { archive: 'https://maps.example/byways.pmtiles', archiveDepth: 14 });
  store.update(region.id, {
    saved: { at: Date.parse('2026-10-05T15:00:00Z'), tiles: 4312, failed: 2, urls: ['https://t.example/8/1/2.png'], keys: ['k|8/1/2'] },
  });

  const again = new OfflineStore({ storage }).get(region.id);
  assert.equal(again.archive, 'https://maps.example/byways.pmtiles', 'the archive stamp was dropped');
  assert.equal(again.archiveDepth, 14);
  assert.equal(again.saved.tiles, 4312);
  assert.equal(again.saved.failed, 2);
  assert.deepEqual(again.saved.urls, ['https://t.example/8/1/2.png']);
  assert.equal(again.saved.complete, true);

  // Discarding the tiles clears the record with them.
  store.update(region.id, { archive: '', archiveDepth: 0, saved: null });
  assert.equal(new OfflineStore({ storage }).get(region.id).saved, null);
});

test('offline keep: moving or re-zooming a downloaded region marks what is held as the old ground', () => {
  const store = new OfflineStore({ storage: fakeStorage() });
  const region = store.add({ name: 'Ridge', bounds: BOX, minZoom: 8, maxZoom: 12 });
  store.update(region.id, { saved: { tiles: 900 } });

  store.update(region.id, { name: 'Ridge road' });
  assert.equal(store.get(region.id).saved.outdated, false, 'a rename is not new ground');
  store.update(region.id, { maxZoom: 14 });
  assert.equal(store.get(region.id).saved.outdated, true);
  assert.match(describeSaved(store.get(region.id)), /changed since; download again/);

  // A fresh download is the current ground again.
  store.update(region.id, { saved: { tiles: 2400 } });
  assert.equal(store.get(region.id).saved.outdated, false);
});

test('offline keep: a region the browser would not store is known about', () => {
  const full = fakeStorage();
  full.setItem = () => { const error = new Error('quota'); error.name = 'QuotaExceededError'; throw error; };
  const store = new OfflineStore({ storage: full });
  assert.ok(store.add({ name: 'Gorge', bounds: BOX }));
  assert.equal(store.unsaved, true);

  const fine = new OfflineStore({ storage: fakeStorage() });
  fine.add({ name: 'Gorge', bounds: BOX });
  assert.equal(fine.unsaved, false);
});

test('offline keep: the sample spans the whole download, and keeps only what arrived', async () => {
  const list = Array.from({ length: 100 }, (_, index) => `t${index}`);
  const sample = spreadSample(list, 5);
  assert.deepEqual(sample, ['t0', 't25', 't50', 't74', 't99']);
  assert.deepEqual(spreadSample(['a', 'b'], 5), ['a', 'b']);

  // Odd tiles failed at the service; none of them may be in the sample.
  const kept = await presentSample(list, async (item) => Number(item.slice(1)) % 2 === 0);
  assert.ok(kept.length > 0 && kept.length <= SAVED_SAMPLE);
  assert.ok(kept.every((item) => Number(item.slice(1)) % 2 === 0));
  assert.deepEqual(savedRecord({ urls: list }).urls.length, SAVED_SAMPLE, 'the record holds a sample, not the download');
});

test('offline keep: presence is read from the tile cache and the tile store', async () => {
  const cached = new Set(['https://t.example/8/1/2.png', 'https://t.example/9/2/4.png']);
  const caches = {
    async open(name) {
      assert.equal(name, TILE_CACHE);
      return { async match(url) { return cached.has(url) ? {} : undefined; } };
    },
  };
  const stored = new Set(['k|8/1/2']);
  const store = { async has(key) { return stored.has(key); } };
  const saved = savedRecord({
    tiles: 4, urls: [...cached, 'https://t.example/10/4/8.png'], keys: ['k|8/1/2', 'k|9/2/4'],
  });
  assert.deepEqual(await savedPresence(saved, { caches, store }), { checked: 5, present: 3 });
  assert.deepEqual(await savedPresence(null, { caches, store }), { checked: 0, present: 0 });
  // A browser with no Cache API checks what it can.
  assert.deepEqual(await savedPresence(saved, { caches: undefined, store }), { checked: 2, present: 1 });
});

test('offline keep: the row says downloaded, gone or partly gone, in words', () => {
  const region = { saved: savedRecord({ at: Date.parse('2026-10-05T15:00:00Z'), tiles: 4312 }) };
  assert.equal(describeSaved({}), 'Not downloaded yet.');
  assert.match(describeSaved(region, null, { locale: 'en-US' }), /^Downloaded Oct 5, 4,312 tiles\.$/);
  assert.match(describeSaved(region, { checked: 12, present: 12 }, { locale: 'en-US' }),
    /on this device and ready to use offline\.$/);
  assert.match(describeSaved(region, { checked: 12, present: 0 }), /no longer on this device .* Download again\.$/);
  assert.match(describeSaved(region, { checked: 12, present: 7 }), /some are no longer on this device/);

  const stopped = { saved: savedRecord({ tiles: 300, complete: false }) };
  assert.match(describeSaved(stopped, { checked: 3, present: 3 }), /^Stopped part way on .*, 300 tiles kept, on this device\.$/);
  const gaps = { saved: savedRecord({ tiles: 10, failed: 3 }) };
  assert.match(describeSaved(gaps, { checked: 2, present: 2 }), /3 could not be fetched from the service\.$/);
});

test('offline keep: the downloaded-tiles cache has one name, and removing a worker spares it', async () => {
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  assert.equal(/const TILES = '([^']+)'/.exec(sw)?.[1], TILE_CACHE, 'sw.js reads tiles from another cache');
  const pwaSource = await readFile(new URL('../assets/js/lib/pwa.js', import.meta.url), 'utf8');
  assert.equal(/const DOWNLOADED_TILES = '([^']+)'/.exec(pwaSource)?.[1], TILE_CACHE);

  // Run it: a worker left behind, three caches, one of them somebody's tiles.
  const deleted = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: { serviceWorker: { async getRegistrations() { return [{ async unregister() { return true; } }]; } } },
    configurable: true, writable: true,
  });
  globalThis.caches = {
    async keys() { return ['abmap-1a2b3c', TILE_CACHE, 'other-site-cache']; },
    async delete(name) { deleted.push(name); return true; },
  };
  const { unregisterServiceWorker } = await import(`../assets/js/lib/pwa.js?keep=${Date.now()}`);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await unregisterServiceWorker(), true);
  } finally {
    console.warn = warn;
    delete globalThis.caches;
  }
  assert.deepEqual(deleted, ['abmap-1a2b3c'], 'the downloaded tiles went with the worker');
});

test('offline keep: every download writes its record, and both lists read it', async () => {
  const viewer = await readFile(new URL('../assets/js/viewer.js', import.meta.url), 'utf8');
  const downloads = viewer.match(/await downloadArchiveTiles\(|await downloadTiles\(/g) || [];
  const records = viewer.match(/await recordDownload\(region/g) || [];
  // One download button runs both kinds and records once; the re-download
  // runs the archive alone and records once.
  assert.ok(downloads.length >= 3, `found ${downloads.length} download calls`);
  assert.equal(records.length, 2, 'a download path no longer records what it kept');
  assert.equal((viewer.match(/(?<!function )savedLine\(region\)/g) || []).length, 2, 'a region list does not say whether it is downloaded');
  assert.doesNotMatch(viewer, /tiles held` : ' · not downloaded'/, 'the archive-wide count is back on every row');
});
