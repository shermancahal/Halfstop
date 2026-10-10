/**
 * The store screenshot script, checked without taking a picture.
 *
 * Both stores refuse a screenshot of the wrong size at upload, after the whole
 * set has been taken on the Mac, so the sizes are worth knowing are right
 * before anybody runs it. The sample folders are checked against the folder
 * store, because a scene of folders that the app quietly drops is a picture
 * of an empty tab.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVICES, APPLE_SIZES, SCENES, SAMPLE_FOLDERS, devicesFor, pixels, sceneURL,
} from '../tools/build-store-screenshots.mjs';
import { FolderStore, folderTree } from '../assets/js/lib/folders.js';
import { getPinIcon, DEFAULT_PIN_ICON } from '../assets/js/lib/pin-icons.js';

test('store screenshots: every Play device is exactly 9:16 or 16:9, inside its limits', () => {
  for (const [name, device] of Object.entries(DEVICES)) {
    if (device.store !== 'play') continue;
    const { width, height } = pixels(device);
    const [long, short] = [Math.max(width, height), Math.min(width, height)];
    assert.equal(long * 9, short * 16, `${name} is ${width} x ${height}`);
    assert.ok(short >= device.min && long <= device.max, `${name} is outside Play's limits`);
  }
});

test('store screenshots: every App Store device is a size App Store Connect takes', () => {
  for (const [name, device] of Object.entries(DEVICES)) {
    if (device.store !== 'apple') continue;
    const { width, height } = pixels(device);
    assert.ok(APPLE_SIZES[name], `${name} has no list of accepted sizes`);
    assert.ok(APPLE_SIZES[name].some(([w, h]) => w === width && h === height),
      `${name} comes out ${width} x ${height}, which App Store Connect refuses`);
  }
  // The two displays App Store Connect insists on are both there.
  assert.deepEqual(devicesFor('apple'), ['iphone-6.9', 'ipad-13']);
});

test('store screenshots: --only takes a device, a store, or both, and passes nonsense back', () => {
  assert.deepEqual(devicesFor(''), Object.keys(DEVICES));
  assert.deepEqual(devicesFor('play'), ['phone', 'tablet-7', 'tablet-10']);
  assert.deepEqual(devicesFor('ipad-13,apple'), ['ipad-13', 'iphone-6.9']);
  assert.deepEqual(devicesFor('bogus'), ['bogus']);
});

test('store screenshots: within both stores\' limits on how many', () => {
  // Play takes up to eight per device and the App Store up to ten.
  assert.ok(SCENES.length >= 2 && SCENES.length <= 8, `${SCENES.length} scenes`);
  assert.equal(new Set(SCENES.map((scene) => scene.file)).size, SCENES.length, 'two scenes share a file');
  for (const scene of SCENES) assert.match(sceneURL('https://app.halfstop.app/', scene), /\/map\.html/);
});

test('store screenshots: the sample folders are folders the app keeps, nested as meant', () => {
  const memory = new Map();
  const storage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
  };
  storage.setItem('ab-maps-folders-v1', JSON.stringify(SAMPLE_FOLDERS));
  const store = new FolderStore({ storage, vault: null });
  store.load();

  const tree = folderTree(store.list()).map(({ folder, depth }) => `${depth}:${folder.name}`);
  assert.deepEqual(tree, ['0:Grand Teton, October', '1:Sunrise', '1:Sunset', '0:Scouting list']);
  assert.equal(store.totals().waypoints, 8);

  // Every symbol is one the app draws, not the plain pin it falls back to.
  for (const folder of SAMPLE_FOLDERS.folders) {
    for (const item of folder.items) {
      const icon = item.feature.properties.icon;
      assert.ok(icon && icon !== DEFAULT_PIN_ICON && getPinIcon(icon)?.id === icon, `${item.feature.properties.name}: ${icon}`);
    }
  }
});
