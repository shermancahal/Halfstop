#!/usr/bin/env node
/**
 * Every icon size, cut from one master image.
 *
 * Usage:  node tools/build-app-icons.mjs [--check]
 *         --check  render and compare against what is committed, without
 *                  writing. Exits non-zero if they differ.
 *
 * The master used to be an SVG this repository drew with its own rasteriser.
 * It is a painting now - gradients, a star field, a brushed metal bezel - and
 * none of that survives being redrawn as vector, so the master is a PNG and
 * these are derived from it. Same property either way, which is the point of
 * the check: one file to change, and a test that fails when the committed
 * icons no longer match it.
 *
 * Two shapes, and the difference is what gets a submission rejected:
 *
 *   "bleed"  the artwork edge to edge, square, fully opaque. Apple requires
 *            this and applies its own rounding; hand it a pre-rounded icon and
 *            the corners of the artwork are cut off inside white ones. Android
 *            crops maskable icons to whatever the launcher uses, usually a
 *            circle, with a safe zone of the middle 80% - the medallion sits
 *            at 59% of the frame, well inside it.
 *
 *   "tight"  cropped in to the medallion, for the sizes where the margin costs
 *            more than it gives. At 32px the frame is 32 pixels; spending nine
 *            of them on empty navy leaves a smudge.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePNG, resizeRGBA, cropRGBA, encodePNG } from './raster.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'assets', 'img', 'mark-master.png');
const OUT_DIR = path.join(ROOT, 'assets', 'img');

/**
 * How much of the master the "tight" crop keeps.
 *
 * The medallion measures 456px across a 768px frame in the artwork, which is
 * 59%. Two thirds keeps it whole with a little air, and no more.
 */
export const TIGHT = 0.80;

/*
 * How much of a maskable icon the artwork is allowed to fill.
 *
 * Android crops adaptive icons to whatever shape the launcher uses, usually a
 * circle, and guarantees only the middle 80% by width. The medallion measures
 * 86% of the master - it very nearly fills the panel it was drawn on - so on a
 * circular launcher its bezel would be cut into an arc. Shrinking it onto the
 * same navy ground puts it at about 72%, inside the guarantee with room to
 * spare, and the ground is the artwork's own so the join is invisible.
 */
export const SAFE = 0.84;

/**
 * What gets written. Sizes are not arbitrary:
 *   32        the browser tab
 *   180       apple-touch-icon, Safari's "Add to Home Screen"
 *   192, 512  the two the web manifest is expected to carry
 *   512 maskable  Android adaptive icons
 *   1024      the App Store, and the master @capacitor/assets slices from
 */
export const ICONS = [
  { file: 'favicon-32.png', size: 32, shape: 'tight' },
  // The mark in the page header, drawn at 30px. Sized for a retina screen
  // rather than reusing icon-192: a 68 KB file behind a 30px slot is fetched
  // on every page, and this is three.
  { file: 'brand-64.png', size: 64, shape: 'tight' },
  { file: 'apple-touch-icon.png', size: 180, shape: 'bleed' },
  { file: 'icon-192.png', size: 192, shape: 'bleed' },
  { file: 'icon-512.png', size: 512, shape: 'bleed' },
  { file: 'icon-maskable-512.png', size: 512, shape: 'safe' },
  { file: 'icon-1024.png', size: 1024, shape: 'bleed' },
];

/**
 * The colour the artwork's own ground is, at the corner.
 *
 * Averaged over a patch rather than read from one pixel: the ground is a
 * gradient and a single sample lands on whichever end of it the corner
 * happens to be, which shows as a seam where the padding meets the artwork.
 */
function groundColour({ width, rgba }, patch = 24) {
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (let y = 0; y < patch; y += 1) {
    for (let x = 0; x < patch; x += 1) {
      const i = (y * width + x) * 4;
      r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2];
      n += 1;
    }
  }
  return [r / n, g / n, b / n];
}

/** One icon's pixels, from the master. */
export function renderIcon(master, icon) {
  if (icon.shape === 'bleed') return resizeRGBA(master, icon.size);

  if (icon.shape === 'tight') {
    const side = Math.round(master.width * TIGHT);
    const inset = Math.round((master.width - side) / 2);
    return resizeRGBA(cropRGBA(master, { x: inset, y: inset, size: side }), icon.size);
  }

  // safe: the whole artwork, shrunk onto its own ground so a circular crop
  // cannot reach it.
  const inner = Math.round(icon.size * SAFE);
  const art = resizeRGBA(master, inner);
  const [r, g, b] = groundColour(master);
  const rgba = new Uint8ClampedArray(icon.size * icon.size * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  }
  const offset = Math.round((icon.size - inner) / 2);
  for (let y = 0; y < inner; y += 1) {
    for (let x = 0; x < inner; x += 1) {
      const from = (y * inner + x) * 4;
      const to = ((y + offset) * icon.size + (x + offset)) * 4;
      rgba[to] = art.rgba[from]; rgba[to + 1] = art.rgba[from + 1];
      rgba[to + 2] = art.rgba[from + 2]; rgba[to + 3] = 255;
    }
  }
  return { width: icon.size, height: icon.size, rgba };
}

export async function readMaster(file = SOURCE) {
  return decodePNG(await readFile(file));
}

async function main() {
  const check = process.argv.includes('--check');
  if (!existsSync(SOURCE)) {
    console.error(`Missing ${path.relative(ROOT, SOURCE)}`);
    process.exit(1);
  }
  const master = await readMaster();
  if (master.width !== master.height) {
    console.error(`The master must be square; it is ${master.width}x${master.height}.`);
    process.exit(1);
  }

  let differ = 0;
  for (const icon of ICONS) {
    const { width, height, rgba } = renderIcon(master, icon);
    const png = encodePNG(width, height, rgba);
    const out = path.join(OUT_DIR, icon.file);

    if (check) {
      const committed = existsSync(out) ? await readFile(out) : null;
      if (!committed || !committed.equals(png)) {
        console.error(`${icon.file} is not what the master renders to`);
        differ += 1;
      }
      continue;
    }
    await writeFile(out, png);
    console.log(`  ${icon.file.padEnd(24)} ${icon.size}px ${icon.shape}`);
  }

  if (check && differ) {
    console.error('\nRun: node tools/build-app-icons.mjs');
    process.exit(1);
  }
  if (check) console.log('Icons match the master.');
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
