#!/usr/bin/env node
/**
 * Build data/catalog.json from the map files in data/maps/.
 *
 * Reuses the browser parsers (assets/js/lib/*) so the distance, ascent and
 * bounds published in the catalogue are computed exactly the way the viewer
 * computes them — one implementation, no drift.
 *
 * Metadata comes from an optional sidecar next to each map file:
 *
 *   data/maps/cherohala-skyway.gpx
 *   data/maps/cherohala-skyway.meta.json
 *     { "title": "...", "description": "...", "region": "...", "tags": ["..."] }
 *
 * Usage:  node tools/build-catalog.mjs [--check]
 *         --check  verify the committed catalogue is current; exit 1 if not
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMapFile, linePositions } from '../assets/js/lib/parse.js';
import { boundsAreValid, simplify } from '../assets/js/lib/geo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAPS_DIR = path.join(ROOT, 'data', 'maps');
const CATALOG_PATH = path.join(ROOT, 'data', 'catalog.json');
const MAP_EXTENSIONS = new Set(['.gpx', '.kml', '.kmz', '.geojson']);
const PREVIEW_POINTS = 90;

const checkOnly = process.argv.includes('--check');

function slugify(value) {
  return String(value).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'map';
}

/** "cherohala-skyway_2024.gpx" -> "Cherohala Skyway 2024" */
function titleFromFilename(filename) {
  return path.basename(filename, path.extname(filename))
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * A small normalised polyline for the card thumbnails on the landing page.
 * Coordinates are 0..1 within the map's own bounding box, y pointing north.
 */
function buildPreview(doc) {
  const lines = doc.geojson.features
    .filter((f) => f.properties.kind !== 'waypoint' && f.properties.kind !== 'area')
    .map((f) => linePositions(f.geometry))
    .filter((positions) => positions.length >= 2);

  const longest = lines.sort((a, b) => b.length - a.length)[0];
  if (!longest) return null;

  const [west, south, east, north] = doc.bbox;
  const spanX = east - west;
  const spanY = north - south;
  if (!(spanX > 0 || spanY > 0)) return null;
  const span = Math.max(spanX, spanY);

  // Thin aggressively — the thumbnail is 320px wide, so vertex-level fidelity
  // is wasted bytes in every catalogue request.
  let reduced = simplify(longest, span / 400);
  if (reduced.length > PREVIEW_POINTS) {
    const step = Math.ceil(reduced.length / PREVIEW_POINTS);
    reduced = reduced.filter((_, i) => i % step === 0 || i === reduced.length - 1);
  }

  return reduced.map(([lon, lat]) => [
    Number((span ? (lon - west) / span : 0.5).toFixed(4)),
    Number((span ? (lat - south) / span : 0.5).toFixed(4)),
  ]);
}

async function readSidecar(filePath) {
  const sidecar = filePath.replace(/\.[^.]+$/, '.meta.json');
  if (!existsSync(sidecar)) return {};
  try {
    return JSON.parse(await readFile(sidecar, 'utf8'));
  } catch (error) {
    console.warn(`  ! ignoring ${path.basename(sidecar)}: ${error.message}`);
    return {};
  }
}

function round(value, digits = 1) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

async function buildEntry(filename) {
  const filePath = path.join(MAPS_DIR, filename);
  const extension = path.extname(filename).toLowerCase();
  const payload = extension === '.kmz'
    ? (await readFile(filePath)).buffer
    : await readFile(filePath, 'utf8');

  const doc = await parseMapFile(payload, filename);
  if (!doc.geojson.features.length) throw new Error('no mappable features found');

  const meta = await readSidecar(filePath);
  const fileStat = await stat(filePath);
  const title = meta.title || doc.name || titleFromFilename(filename);

  return {
    slug: meta.slug || slugify(title),
    title,
    description: meta.description || doc.description || '',
    region: meta.region || '',
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    file: filename,
    path: `data/maps/${filename}`,
    format: doc.format,
    bytes: fileStat.size,
    // Deliberately not the file mtime: git does not preserve it, so a CI
    // checkout would produce a different catalogue than a local build and the
    // --check gate would fail for no real reason.
    updated: meta.updated
      || (doc.stats.startTime ? new Date(doc.stats.startTime).toISOString() : null)
      || (doc.time ? new Date(doc.time).toISOString() : null),
    bbox: boundsAreValid(doc.bbox) ? doc.bbox.map((v) => Number(v.toFixed(6))) : null,
    stats: {
      distance_m: round(doc.stats.distance_m),
      ascent_m: round(doc.stats.ascent_m),
      descent_m: round(doc.stats.descent_m),
      elevation_min_m: round(doc.stats.elevation_min_m),
      elevation_max_m: round(doc.stats.elevation_max_m),
      duration_s: round(doc.stats.duration_s, 0),
      trackCount: doc.stats.trackCount + doc.stats.routeCount,
      waypointCount: doc.stats.waypointCount,
      areaCount: doc.stats.areaCount,
    },
    preview: buildPreview(doc),
  };
}

async function main() {
  if (!existsSync(MAPS_DIR)) {
    console.error(`No maps directory at ${path.relative(ROOT, MAPS_DIR)}`);
    process.exit(1);
  }

  const filenames = (await readdir(MAPS_DIR))
    .filter((name) => MAP_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort();

  console.log(`Scanning ${path.relative(ROOT, MAPS_DIR)}/ — ${filenames.length} map file(s)`);

  const maps = [];
  const failures = [];
  const seenSlugs = new Set();

  for (const filename of filenames) {
    try {
      const entry = await buildEntry(filename);
      // Slugs are the public URL key (?m=slug); collisions would silently shadow.
      let slug = entry.slug;
      let n = 2;
      while (seenSlugs.has(slug)) slug = `${entry.slug}-${n++}`;
      if (slug !== entry.slug) console.warn(`  ! ${filename}: slug collision, using "${slug}"`);
      entry.slug = slug;
      seenSlugs.add(slug);

      maps.push(entry);
      const distance = entry.stats.distance_m ? `${(entry.stats.distance_m / 1609.344).toFixed(1)} mi` : 'no track';
      console.log(`  ✓ ${filename} → ${entry.slug} (${distance}, ${entry.stats.waypointCount} waypoints)`);
    } catch (error) {
      failures.push({ filename, message: error.message });
      console.error(`  ✗ ${filename}: ${error.message}`);
    }
  }

  // Most recently recorded first; undated maps fall to the end in title order.
  maps.sort((a, b) => {
    if (a.updated && b.updated && a.updated !== b.updated) return b.updated.localeCompare(a.updated);
    if (a.updated && !b.updated) return -1;
    if (!a.updated && b.updated) return 1;
    return a.title.localeCompare(b.title);
  });

  const catalog = {
    // Deliberately not a build timestamp: a rebuild that changes nothing should
    // produce an identical file, so --check stays meaningful and diffs stay clean.
    version: 1,
    generated: maps.find((m) => m.updated)?.updated || null,
    count: maps.length,
    maps,
  };
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;

  if (checkOnly) {
    const current = existsSync(CATALOG_PATH) ? await readFile(CATALOG_PATH, 'utf8') : '';
    if (current !== serialized) {
      console.error('\ndata/catalog.json is out of date — run: npm run build');
      process.exit(1);
    }
    console.log('\ndata/catalog.json is up to date.');
  } else {
    await writeFile(CATALOG_PATH, serialized);
    console.log(`\nWrote ${path.relative(ROOT, CATALOG_PATH)} — ${maps.length} map(s)`);
  }

  if (failures.length) {
    console.error(`\n${failures.length} file(s) could not be indexed.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
