/**
 * The icon pipeline: one master picture, six files cut from it.
 *
 * What is worth testing here is not that a resize works. It is the two things
 * that get an app rejected and are invisible until it is: an icon that is not
 * what the master says it should be, and artwork that falls outside the safe
 * zone a launcher crops to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { decodePNG, encodePNG, resizeRGBA, cropRGBA } from '../tools/raster.mjs';
import { ICONS, TIGHT, SAFE, renderIcon, readMaster } from '../tools/build-app-icons.mjs';

const solid = (size, [r, g, b, a = 255]) => {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a; }
  return { width: size, height: size, rgba };
};
const at = ({ width, rgba }, x, y) => [...rgba.slice((y * width + x) * 4, (y * width + x) * 4 + 4)];

/* ------------------------------------------------------------------ codec */

test('a PNG we write reads back as the pixels we wrote', () => {
  const image = solid(4, [200, 100, 50]);
  image.rgba.set([1, 2, 3, 255], 0);
  const round = decodePNG(encodePNG(4, 4, image.rgba));
  assert.equal(round.width, 4);
  assert.deepEqual(at(round, 0, 0), [1, 2, 3, 255]);
  assert.deepEqual(at(round, 3, 3), [200, 100, 50, 255]);
});

test('anything the decoder cannot read says so rather than guessing', () => {
  assert.throws(() => decodePNG(new Uint8Array(16)), /not a PNG/);
});

/* ----------------------------------------------------------------- resize */

test('resizing averages the pixels it covers rather than sampling one', () => {
  /*
   * The whole reason for a box filter. A checkerboard sampled at one pixel per
   * cell comes back black or white depending where the grid lands; averaged,
   * it is grey - which is what stops a bezel of tick marks turning into noise
   * that changes between sizes.
   */
  const size = 16;
  const board = solid(size, [0, 0, 0]);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if ((x + y) % 2) board.rgba.set([255, 255, 255, 255], (y * size + x) * 4);
    }
  }
  const small = resizeRGBA(board, 2);
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const [r] = at(small, x, y);
    assert.ok(r > 100 && r < 155, `expected grey, got ${r}`);
  }
});

test('a crop takes the square it is asked for', () => {
  const image = solid(8, [10, 10, 10]);
  image.rgba.set([255, 0, 0, 255], ((3 * 8) + 3) * 4);
  const cut = cropRGBA(image, { x: 3, y: 3, size: 2 });
  assert.deepEqual(at(cut, 0, 0), [255, 0, 0, 255]);
  assert.equal(cut.width, 2);
});

/* ------------------------------------------------------------------ icons */

test('the committed icons are what the master renders to', async () => {
  const master = await readMaster();
  for (const icon of ICONS) {
    const { width, height, rgba } = renderIcon(master, icon);
    const committed = await readFile(new URL(`../assets/img/${icon.file}`, import.meta.url));
    assert.ok(committed.equals(encodePNG(width, height, rgba)),
      `${icon.file} differs — run: node tools/build-app-icons.mjs`);
  }
});

test('the master is square, which every store requires of what comes out of it', async () => {
  const master = await readMaster();
  assert.equal(master.width, master.height);
  assert.ok(master.width >= 1024, `the App Store needs 1024; the master is ${master.width}`);
});

test('the bleed icons are opaque to the corner, and not pre-rounded', async () => {
  /*
   * Apple applies its own mask and Android crops to the launcher's shape. An
   * icon that arrives already rounded is rounded twice - the artwork's corners
   * cut off inside white ones - and a transparent corner is rejected outright.
   */
  const master = await readMaster();
  for (const icon of ICONS.filter((i) => i.shape === 'bleed')) {
    const image = renderIcon(master, icon);
    const last = icon.size - 1;
    for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]]) {
      assert.equal(at(image, x, y)[3], 255, `${icon.file} has a see-through corner at ${x},${y}`);
    }
  }
});

test('the medallion stays inside the safe zone a launcher crops to', async () => {
  /*
   * Android masks adaptive icons to a circle on most launchers, keeping the
   * middle 80% by width. The bezel is the outermost part of the artwork and
   * the first thing a crop would bite into.
   */
  const master = await readMaster();
  const maskable = renderIcon(master, ICONS.find((i) => i.file === 'icon-maskable-512.png'));
  const size = maskable.width;
  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  let minX = size; let maxX = 0; let minY = size; let maxY = 0;
  for (let y = 0; y < size; y += 2) {
    for (let x = 0; x < size; x += 2) {
      if (lum(at(maskable, x, y)) < 120) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const margin = size * 0.1;
  assert.ok(minX >= margin && maxX <= size - margin,
    `the bezel runs from x=${minX} to ${maxX}; the safe zone is ${margin} to ${size - margin}`);
  assert.ok(minY >= margin && maxY <= size - margin,
    `the bezel runs from y=${minY} to ${maxY}; the safe zone is ${margin} to ${size - margin}`);
});

test('the tight crop keeps the whole medallion, not part of it', () => {
  // The medallion measures 86% of the master, so a tight crop has very little
  // room: below this it starts cutting the bezel rather than the margin.
  assert.ok(TIGHT >= 0.8 && TIGHT < 1, `TIGHT is ${TIGHT}`);
});

test('the maskable icon shrinks the artwork rather than trusting it to fit', () => {
  // 86% of the master, times this, has to land inside Android's 80%.
  assert.ok(0.86 * SAFE < 0.8, `86% x ${SAFE} is ${(0.86 * SAFE).toFixed(3)}`);
});
