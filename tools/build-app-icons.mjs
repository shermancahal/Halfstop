#!/usr/bin/env node
/**
 * Render assets/img/mark.svg to the PNG icons the installable app needs.
 *
 * Usage:  node tools/build-app-icons.mjs [--check]
 *         --check  render and compare against what is committed, without
 *                  writing. Exits non-zero if they differ.
 *
 * Why PNGs at all, when the site already has an SVG favicon: a web manifest
 * will accept SVG, but iOS `apple-touch-icon` will not, Android's maskable
 * icons want a bitmap, and Capacitor's asset generator takes a 1024px PNG. One
 * source of truth is the SVG; these are derived from it, so a change to the
 * mark reaches every icon by re-running this.
 *
 * Two shapes are produced, and the difference matters:
 *
 *   "rounded"  the mark as drawn, its own corner radius, transparent outside.
 *              For the manifest's `any` icons and the favicon fallback.
 *
 *   "bleed"    the background colour edge to edge, glyph shrunk to the middle.
 *              For `maskable` and for apple-touch-icon. Android crops maskable
 *              icons to whatever shape the launcher uses — a circle on most —
 *              and iOS applies its own rounding on top. Handing either one an
 *              already-rounded icon gets it rounded twice, with the corners of
 *              the artwork clipped off. Android's safe zone is the middle 80%
 *              by width, so the glyph is kept well inside that.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createCanvas, canvasToRGBA, encodePNG, parseColor,
  fillRect, fillCircle, strokePolylines, flattenPath, dashPolyline,
} from './raster.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'assets', 'img', 'mark.svg');
const OUT_DIR = path.join(ROOT, 'assets', 'img');

/**
 * What gets written. Sizes are not arbitrary:
 *   192, 512  the two the web manifest is expected to carry
 *   512 maskable  Android adaptive icons
 *   180  apple-touch-icon, Safari's "Add to Home Screen"
 *   1024  the master Capacitor's @capacitor/assets slices the native sets from
 */
export const ICONS = [
  { file: 'icon-192.png', size: 192, shape: 'rounded' },
  { file: 'icon-512.png', size: 512, shape: 'rounded' },
  { file: 'icon-maskable-512.png', size: 512, shape: 'bleed', glyph: 0.56 },
  { file: 'apple-touch-icon.png', size: 180, shape: 'bleed', glyph: 0.68 },
  { file: 'icon-1024.png', size: 1024, shape: 'bleed', glyph: 0.60 },
];

const attr = (tag, name) => {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return match ? match[1] : null;
};
const num = (tag, name, fallback = 0) => {
  const value = attr(tag, name);
  return value === null ? fallback : Number(value);
};

/** Read the subset of SVG this project's mark actually uses. */
export function readMark(svg) {
  const root = svg.match(/<svg\b[^>]*>/);
  if (!root) throw new Error('no <svg> element');
  const box = (attr(root[0], 'viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (box.length !== 4) throw new Error('the mark needs a viewBox');

  const shapes = [];
  for (const [, name, tag] of svg.matchAll(/<(rect|circle|path)\b([^>]*?)\/?>/g)) {
    const full = `<${name}${tag}>`;
    const common = {
      fill: attr(full, 'fill'),
      stroke: attr(full, 'stroke'),
      strokeWidth: num(full, 'stroke-width', 1),
      opacity: num(full, 'opacity', 1),
      dash: (attr(full, 'stroke-dasharray') || '').trim()
        ? attr(full, 'stroke-dasharray').trim().split(/[\s,]+/).map(Number)
        : null,
    };
    if (name === 'rect') {
      shapes.push({ type: 'rect', ...common, x: num(full, 'x'), y: num(full, 'y'),
        width: num(full, 'width'), height: num(full, 'height'),
        rx: num(full, 'rx'), ry: attr(full, 'ry') === null ? num(full, 'rx') : num(full, 'ry') });
    } else if (name === 'circle') {
      shapes.push({ type: 'circle', ...common, cx: num(full, 'cx'), cy: num(full, 'cy'), r: num(full, 'r') });
    } else {
      const d = attr(full, 'd');
      if (!d) throw new Error('a <path> has no d attribute');
      shapes.push({ type: 'path', ...common, d });
    }
  }
  if (!shapes.length) throw new Error('the mark has no drawable shapes');
  return { viewBox: box, shapes };
}

/**
 * The bounding box of the artwork, stroke included, in viewBox units.
 *
 * The mark is not centred in its own 32x32 box and does not fill it — the
 * route runs from about x=8 to x=26. Scaling the bleed icons against the
 * viewBox therefore left the glyph small and visibly off-centre inside
 * Android's safe zone, so they are scaled and centred against this instead.
 */
export function markBounds(shapes) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  const grow = (x, y, pad = 0) => {
    if (x - pad < minX) minX = x - pad;
    if (y - pad < minY) minY = y - pad;
    if (x + pad > maxX) maxX = x + pad;
    if (y + pad > maxY) maxY = y + pad;
  };
  for (const item of shapes) {
    if (item.type === 'rect') {
      grow(item.x, item.y);
      grow(item.x + item.width, item.y + item.height);
    } else if (item.type === 'circle') {
      grow(item.cx, item.cy, item.r);
    } else {
      const pad = (item.stroke && item.stroke !== 'none') ? item.strokeWidth / 2 : 0;
      for (const sub of flattenPath(item.d)) for (const [x, y] of sub.points) grow(x, y, pad);
    }
  }
  if (!Number.isFinite(minX)) throw new Error('the mark has no measurable artwork');
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Render the mark at `size` pixels.
 *
 * `samples` is the supersampling factor per axis, so 4 means 16 samples per
 * pixel. Coverage is computed per shape over its own bounding box, so the cost
 * tracks ink rather than canvas area.
 */
export function renderMark(mark, { size, shape = 'rounded', glyph = 1, samples = 4 }) {
  const [vx, vy, vw, vh] = mark.viewBox;
  const canvas = createCanvas(size, size);
  const background = mark.shapes[0];
  if (background.type !== 'rect' || !background.fill) {
    throw new Error('expected the first shape in the mark to be the filled background plate');
  }

  const bleed = shape === 'bleed';
  // In "bleed" the plate covers the canvas and the artwork is scaled to occupy
  // `glyph` of the canvas's shorter side, centred on the artwork's own bounds.
  // Otherwise everything scales together and the plate keeps its own corners.
  const art = bleed ? markBounds(mark.shapes.filter((s) => s !== background)) : null;
  const scale = bleed
    ? (size * glyph) / Math.max(art.width, art.height)
    : size / Math.max(vw, vh);
  const [anchorX, anchorY] = bleed
    ? [art.minX + art.width / 2, art.minY + art.height / 2]
    : [vx + vw / 2, vy + vh / 2];
  const px = (x) => size / 2 + (x - anchorX) * scale;
  const py = (y) => size / 2 + (y - anchorY) * scale;

  if (bleed) {
    fillRect(canvas, { x: 0, y: 0, width: size, height: size, rx: 0, ry: 0 },
      parseColor(background.fill), 1, 1);
  }

  for (const item of mark.shapes) {
    if (bleed && item === background) continue;
    const opacity = item.opacity;
    if (item.type === 'rect') {
      fillRect(canvas, {
        x: px(item.x), y: py(item.y), width: item.width * scale, height: item.height * scale,
        rx: item.rx * scale, ry: item.ry * scale,
      }, parseColor(item.fill), opacity, samples);
    } else if (item.type === 'circle') {
      fillCircle(canvas, { cx: px(item.cx), cy: py(item.cy), r: item.r * scale },
        parseColor(item.fill), opacity, samples);
    } else {
      if (!item.stroke || item.stroke === 'none') {
        throw new Error('filled paths are not supported by this rasteriser — the mark only strokes them');
      }
      const runs = [];
      for (const sub of flattenPath(item.d)) {
        const points = sub.points.map(([x, y]) => [px(x), py(y)]);
        const dash = item.dash ? item.dash.map((n) => n * scale) : null;
        runs.push(...dashPolyline(points, dash));
      }
      strokePolylines(canvas, runs, item.strokeWidth * scale, parseColor(item.stroke), opacity, samples);
    }
  }
  return canvas;
}

async function main() {
  const check = process.argv.includes('--check');
  const mark = readMark(await readFile(SOURCE, 'utf8'));
  console.log(`${path.relative(ROOT, SOURCE)} — ${mark.shapes.length} shapes, viewBox ${mark.viewBox.join(' ')}\n`);

  let changed = 0;
  for (const icon of ICONS) {
    const canvas = renderMark(mark, icon);
    const png = encodePNG(icon.size, icon.size, canvasToRGBA(canvas));
    const target = path.join(OUT_DIR, icon.file);
    const existing = existsSync(target) ? await readFile(target) : null;
    const same = existing && existing.equals(png);
    if (!same) changed += 1;
    if (!check && !same) await writeFile(target, png);
    const note = same ? 'unchanged' : check ? 'DIFFERS' : 'written';
    console.log(`  ${icon.file.padEnd(24)} ${String(icon.size).padStart(4)}px  ${icon.shape.padEnd(8)} ${String(png.length).padStart(7)} bytes  ${note}`);
  }

  if (check && changed) {
    console.error(`\n${changed} icon(s) do not match assets/img/mark.svg. Run: node tools/build-app-icons.mjs`);
    process.exit(1);
  }
  console.log(check ? '\nIcons match the mark.' : `\n${changed} icon(s) updated.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
