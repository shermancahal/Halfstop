/**
 * Read one tile out of an archive and say what is in it.
 *
 *   node tools/inspect-archive.mjs <url> 13/2195/3225
 *
 * check-archive answers "can a browser read this file". This answers the next
 * question, which is the one a wrong-looking map actually raises: the bytes
 * arrived, so what do they contain? A tile holding only `landcover` and a tile
 * holding roads, water, places and boundaries look identical from outside —
 * both are a few kilobytes that decompress cleanly — and the difference is the
 * whole of why a map is blocks of colour rather than a map.
 *
 * The vector tile format is protobuf, and this reads just enough of it to name
 * the layers and count their features. No dependency: the wire format is four
 * field types and we need one of them.
 */

import { pathToFileURL } from 'node:url';

import { PMTilesArchive } from '../assets/js/lib/pmtiles.js';

/* --------------------------------------------------------- protobuf, barely */

function reader(bytes) {
  return { bytes, pos: 0 };
}

function varint(at) {
  let value = 0;
  let shift = 1;
  for (;;) {
    const byte = at.bytes[at.pos];
    at.pos += 1;
    value += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return value;
    shift *= 128;
  }
}

/**
 * Walk one message, handing each field to a visitor.
 *
 * Only two wire types occur in a vector tile at the level this cares about:
 * varints (2 = length-delimited is the other). The rest are skipped by length
 * rather than parsed, which is what lets sixty lines read a format that
 * usually arrives as a library.
 */
function fields(bytes, visit) {
  const at = reader(bytes);
  while (at.pos < bytes.length) {
    const tag = varint(at);
    const field = tag >> 3;
    const wire = tag & 0x7;
    if (wire === 2) {
      const length = varint(at);
      visit(field, bytes.subarray(at.pos, at.pos + length));
      at.pos += length;
    } else if (wire === 0) {
      visit(field, varint(at));
    } else if (wire === 5) {
      at.pos += 4;
    } else if (wire === 1) {
      at.pos += 8;
    } else {
      throw new Error(`unexpected protobuf wire type ${wire}`);
    }
  }
}

const text = (bytes) => new TextDecoder().decode(bytes);

/** Layer name, feature count and attribute keys, for every layer in a tile. */
export function describeTile(tile) {
  const layers = [];
  // Tile.layers is field 3.
  fields(tile, (field, value) => {
    if (field !== 3 || !(value instanceof Uint8Array)) return;
    const layer = { name: '', features: 0, keys: [], extent: 4096 };
    fields(value, (inner, item) => {
      if (inner === 1 && item instanceof Uint8Array) layer.name = text(item);
      else if (inner === 2) layer.features += 1;
      else if (inner === 3 && item instanceof Uint8Array) layer.keys.push(text(item));
      else if (inner === 5 && typeof item === 'number') layer.extent = item;
    });
    layers.push(layer);
  });
  return layers;
}

/* -------------------------------------------------------------------- main */

/*
 * Only when run directly. The tests import `describeTile` to check the parser
 * against tiles they build themselves, and importing a module runs it - so
 * without this guard every test run printed the usage message and exited.
 */
const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!invoked) {
  // Nothing else to do; the export above is the point.
} else await main();

async function main() {
const [url, tileRef] = process.argv.slice(2);
if (!url || !tileRef) {
  console.error('Usage: node tools/inspect-archive.mjs <url> <z>/<x>/<y>');
  console.error('  e.g. node tools/inspect-archive.mjs https://example/byways.pmtiles 13/2195/3225');
  process.exit(2);
}
const [z, x, y] = tileRef.split('/').map(Number);

const archive = new PMTilesArchive(url);
const header = await archive.header();
console.log(`${url}`);
console.log(`  zoom range ${header.minZoom}–${header.maxZoom}, bounds ${header.bounds.west}, ${header.bounds.south} → ${header.bounds.east}, ${header.bounds.north}\n`);

/*
 * The tile asked for, and the same ground at every zoom above it.
 *
 * A map that draws coarse blocks where it should draw roads is usually not one
 * broken tile: it is the deep tiles missing and a shallow one being stretched
 * over the gap. Reading the whole column says which, and the shape of the
 * answer - full at z8, empty at z12 - names the problem outright.
 */
for (let zoom = Math.max(header.minZoom, 0); zoom <= header.maxZoom; zoom += 1) {
  const scale = 2 ** (zoom - z);
  const tx = Math.floor(x * scale);
  const ty = Math.floor(y * scale);
  let tile;
  try {
    tile = await archive.tile(zoom, tx, ty);
  } catch (error) {
    console.log(`  z${String(zoom).padEnd(2)} ${tx}/${ty}  FAILED — ${error.message}`);
    continue;
  }
  if (!tile) {
    console.log(`  z${String(zoom).padEnd(2)} ${tx}/${ty}  absent`);
    continue;
  }
  const layers = describeTile(tile);
  const summary = layers.length
    ? layers.map((layer) => `${layer.name}:${layer.features}`).join(' ')
    : '(no layers)';
  console.log(`  z${String(zoom).padEnd(2)} ${tx}/${ty}  ${String(tile.length).padStart(7)} B  ${summary}`);
}

// And the attribute keys of the deepest tile, since a layer that is present
// but carries none of the fields the style reads is its own failure.
const deepest = await archive.tile(header.maxZoom, Math.floor(x * 2 ** (header.maxZoom - z)), Math.floor(y * 2 ** (header.maxZoom - z)));
if (deepest) {
  console.log(`\nAttribute keys at z${header.maxZoom}:`);
  for (const layer of describeTile(deepest)) {
    console.log(`  ${layer.name.padEnd(12)} ${layer.keys.join(', ') || '(none)'}`);
  }
}
}
