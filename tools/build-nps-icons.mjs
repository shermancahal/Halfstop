/**
 * Turn the National Park Service symbol library into map icons.
 *
 * The recreation layer was drawn with this app's own pin glyphs — thin white
 * line drawings meant for a coloured circle in the waypoint editor — and on a
 * busy topo map they were reported as hard to tell apart. The NPS symbols are
 * the ones every trailhead sign in the country already uses, which is a better
 * answer than drawing new ones: a reader has seen them before.
 *
 * Run against a checkout of the library:
 *
 *   git clone --depth 1 --branch gh-pages \
 *     https://github.com/nationalparkservice/symbol-library /tmp/nps
 *   node tools/build-nps-icons.mjs /tmp/nps
 *
 * Output is committed, so the app has no build step and no dependency on that
 * repository being reachable. This exists so the next person can regenerate it
 * rather than hand-editing path data, which is how a glyph ends up subtly wrong
 * with nothing to compare it against.
 *
 * The 22px white variants: filled shapes on a 22x22 grid, drawn in white
 * because the badge behind them is the colour. Polygons and rects are converted
 * to paths so the runtime needs one drawing primitive instead of four.
 *
 * Licence: the library is BSD (Copyright 2013, Mapbox LLC) and the symbols
 * themselves are US government work. The notice is carried into the generated
 * file and into the app's attribution.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/*
 * Which symbols, and what each one stands for here.
 *
 * Deliberately not "all of them" — the library has over three hundred, and a
 * key with three hundred entries explains nothing. These are the ones the USGS
 * structures service actually gives us data for, plus the handful that a
 * second source could fill later.
 */
const WANTED = [
  { id: 'campground', symbol: 'campground', name: 'Campground' },
  { id: 'rv', symbol: 'rv-campground', name: 'RV campground' },
  { id: 'picnic', symbol: 'picnic-area', name: 'Picnic area' },
  { id: 'trailhead', symbol: 'trailhead', name: 'Trailhead' },
  { id: 'cabin', symbol: 'cabin', name: 'Cabin or shelter' },
  { id: 'ranger', symbol: 'ranger-station', name: 'Ranger station' },
  { id: 'information', symbol: 'information', name: 'Visitor center' },
  { id: 'historic', symbol: 'historic-feature', name: 'Historic site' },
  { id: 'restroom', symbol: 'restrooms', name: 'Restrooms' },
  { id: 'water', symbol: 'drinking-water', name: 'Drinking water' },
  { id: 'boat', symbol: 'boat-launch', name: 'Boat launch' },
  { id: 'parking', symbol: 'parking', name: 'Parking' },
  { id: 'fourwd', symbol: 'four-wheel-drive-road', name: 'Four-wheel-drive road' },
  { id: 'viewpoint', symbol: 'scenic-viewpoint', name: 'Scenic viewpoint' },
];

const numbers = (text) => (text.match(/-?\d*\.?\d+/g) || []).map(Number);

/** `points="1,2 3,4"` becomes `M1,2L3,4Z`, so everything downstream is a path. */
function polygonToPath(points) {
  const values = numbers(points);
  const pairs = [];
  for (let at = 0; at + 1 < values.length; at += 2) pairs.push(`${values[at]},${values[at + 1]}`);
  return pairs.length ? `M${pairs.join('L')}Z` : '';
}

/*
 * One attribute, matched on its own.
 *
 * `\b` in front matters: without it, asking for `r` on a circle also matches
 * the `r` inside `stroke-width`, and asking for `x` matches the one inside a
 * `transform`. Both would read a number out of the wrong attribute and produce
 * a glyph that is subtly wrong rather than obviously broken.
 */
const attr = (attrs, name) => Number(new RegExp(`\\b${name}="([^"]+)"`).exec(attrs)?.[1] ?? 0);

/** A rect, as an explicit rectangle path. */
function rectToPath(attrs) {
  const x = attr(attrs, 'x');
  const y = attr(attrs, 'y');
  const w = attr(attrs, 'width');
  const h = attr(attrs, 'height');
  if (!w || !h) return '';
  return `M${x},${y}h${w}v${h}h${-w}Z`;
}

/** A circle as four beziers — none of these glyphs use arc commands. */
function circleToPath(attrs) {
  const cx = attr(attrs, 'cx');
  const cy = attr(attrs, 'cy');
  const r = attr(attrs, 'r');
  if (!r) return '';
  const k = r * 0.5523;
  return `M${cx},${cy - r}`
    + `C${cx + k},${cy - r} ${cx + r},${cy - k} ${cx + r},${cy}`
    + `C${cx + r},${cy + k} ${cx + k},${cy + r} ${cx},${cy + r}`
    + `C${cx - k},${cy + r} ${cx - r},${cy + k} ${cx - r},${cy}`
    + `C${cx - r},${cy - k} ${cx - k},${cy - r} ${cx},${cy - r}Z`;
}

/** Every filled shape in one SVG, in document order — which is paint order. */
function shapesOf(svg) {
  const out = [];
  for (const [, tag, attrs] of svg.matchAll(/<(path|polygon|polyline|rect|circle)\b([^>]*)\/?>/g)) {
    if (tag === 'path') {
      const d = /\bd="([^"]+)"/.exec(attrs)?.[1];
      if (d) out.push(d.replace(/\s+/g, ' ').trim());
    } else if (tag === 'polygon' || tag === 'polyline') {
      const points = /\bpoints="([^"]+)"/.exec(attrs)?.[1];
      if (points) out.push(polygonToPath(points));
    } else if (tag === 'rect') {
      out.push(rectToPath(attrs));
    } else {
      out.push(circleToPath(attrs));
    }
  }
  return out.filter(Boolean);
}

const root = process.argv[2];
if (!root) {
  console.error('usage: node tools/build-nps-icons.mjs <path to a symbol-library checkout>');
  process.exit(1);
}

const entries = [];
for (const want of WANTED) {
  const file = path.join(root, 'src', 'standalone', `${want.symbol}-white-22.svg`);
  const svg = await readFile(file, 'utf8');
  const shapes = shapesOf(svg);
  if (!shapes.length) {
    console.error(`  ${want.symbol}: no shapes found — the library's markup has changed`);
    process.exit(1);
  }
  entries.push({ ...want, f: shapes });
  console.log(`  ${want.id.padEnd(12)} ${shapes.length} shape(s) from ${want.symbol}-white-22.svg`);
}

const body = `/**
 * National Park Service map symbols, as filled paths on a 22x22 grid.
 *
 * GENERATED by tools/build-nps-icons.mjs — do not hand-edit. Regenerate from a
 * checkout of https://github.com/nationalparkservice/symbol-library rather than
 * adjusting a path here, or the glyph drifts from the one on the sign.
 *
 * These are the symbols on trailhead and campground signs across the country,
 * which is the reason to use them: a reader has already learned what they mean
 * somewhere other than this app.
 *
 * Drawn white and filled — the colour is the badge behind them. That is the NPS
 * convention and it is also what makes them legible on a busy topo map, where
 * the app's own thin line glyphs were reported as hard to tell apart.
 *
 * Symbol library: BSD licence, Copyright 2013 Mapbox LLC; the symbols are a
 * work of the United States government.
 */

/** @type {{id: string, name: string, f: string[]}[]} */
export const NPS_ICONS = ${JSON.stringify(entries.map(({ id, name, f }) => ({ id, name, f })), null, 2)};

/** The grid every path above is drawn on. */
export const NPS_VIEWBOX = 22;

export const npsIcon = (id) => NPS_ICONS.find((icon) => icon.id === id) || null;
export const npsIconIds = () => NPS_ICONS.map((icon) => icon.id);
`;

await writeFile('assets/js/lib/nps-icons.js', body);
console.log(`\nWrote assets/js/lib/nps-icons.js — ${entries.length} symbols.`);
