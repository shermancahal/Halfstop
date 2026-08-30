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
import { PROTOMAPS_SCHEMA } from '../assets/js/lib/byways-style.js';

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

/** A Value message: seven possible fields, one of which is set. */
function value(bytes) {
  let out;
  fields(bytes, (field, item) => {
    if (field === 1 && item instanceof Uint8Array) out = text(item);
    else if (field === 4 || field === 5) out = item;
    else if (field === 7) out = Boolean(item);
    else if (out === undefined) out = '(number)';
  });
  return out;
}

/** The packed varints of a feature's tags: key index, value index, repeating. */
function packed(bytes) {
  const at = reader(bytes);
  const out = [];
  while (at.pos < bytes.length) out.push(varint(at));
  return out;
}

/**
 * Layer name, feature count, attribute keys — and the distinct values each key
 * takes, which is the part that settles an argument.
 *
 * "The roads layer is present with 33 features" and "the roads layer is
 * present with 33 features whose kind_detail is a word this style never
 * filters on" look identical until the values are read. The first says the
 * archive is fine; the second says exactly which line of the style is wrong.
 */
export function describeTile(tile) {
  const layers = [];
  // Tile.layers is field 3.
  fields(tile, (field, raw) => {
    if (field !== 3 || !(raw instanceof Uint8Array)) return;
    const layer = { name: '', features: 0, keys: [], values: [], extent: 4096, tags: [] };
    fields(raw, (inner, item) => {
      if (inner === 1 && item instanceof Uint8Array) layer.name = text(item);
      else if (inner === 2 && item instanceof Uint8Array) {
        layer.features += 1;
        fields(item, (part, body) => {
          if (part === 2 && body instanceof Uint8Array) layer.tags.push(packed(body));
        });
      } else if (inner === 2) layer.features += 1;
      else if (inner === 3 && item instanceof Uint8Array) layer.keys.push(text(item));
      else if (inner === 4 && item instanceof Uint8Array) layer.values.push(value(item));
      else if (inner === 5 && typeof item === 'number') layer.extent = item;
    });

    // Key -> the set of values it takes across this layer's features.
    layer.seen = new Map();
    for (const tags of layer.tags) {
      for (let i = 0; i + 1 < tags.length; i += 2) {
        const key = layer.keys[tags[i]];
        if (key === undefined) continue;
        if (!layer.seen.has(key)) layer.seen.set(key, new Set());
        layer.seen.get(key).add(layer.values[tags[i + 1]]);
      }
    }
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
  console.log(`\nWhat the deepest tile actually classifies things as:`);
  // Only the keys a style branches on. Names and populations are noise here.
  const classifying = ['kind', 'kind_detail', 'network', 'shield_text', 'surface'];
  for (const layer of describeTile(deepest)) {
    console.log(`  ${layer.name}`);
    for (const key of classifying) {
      const seen = layer.seen.get(key);
      if (!seen) continue;
      const values = [...seen].filter((one) => one !== undefined).sort();
      console.log(`    ${key.padEnd(12)} ${values.slice(0, 24).join(', ')}${values.length > 24 ? ` … +${values.length - 24}` : ''}`);
    }
    const others = layer.keys.filter((key) => !classifying.includes(key));
    if (others.length) console.log(`    ${'(also)'.padEnd(12)} ${others.join(', ')}`);
  }

  reconcile(describeTile(deepest));
}
}

/**
 * The schema's claims against the tile's contents, both directions.
 *
 * This is the one check the test suite structurally cannot do, and the test
 * file says so in as many words: every schema test reads the schema for both
 * sides of the comparison, so a schema that names a value the data has never
 * heard of is self-consistent and passes everything. The style then filters on
 * it, matches nothing, and draws an empty layer - which looks exactly like a
 * layer that is correctly empty.
 *
 * `label-water` is the case that prompted this. The schema calls lakes 'lake';
 * Protomaps calls them 'water'. Every test passed, the filter matched a
 * quarter of what it should, and the only symptom was unnamed lakes.
 *
 * Both directions matter and they mean different things. A value the schema
 * names and the tile has never seen is a filter that may be dead - "may",
 * because one tile is not the world and there really are no oceans in
 * Tennessee. A value the tile carries and the schema never names is ground the
 * map is silently declining to draw. Neither is reported as a failure, because
 * one tile cannot prove either; they are reported as questions worth asking,
 * which is more than nothing was asking before.
 */
export function reconcile(layers) {
  const seenIn = (layerName, key) => {
    const layer = layers.find((one) => one.name === layerName);
    return new Set([...(layer?.seen.get(key) || [])].filter((one) => one !== undefined));
  };

  /*
   * Every list of values the schema branches on, with the layer and field each
   * is read out of. Written here rather than derived, because the schema is a
   * flat bag of names and only the style knows which field each list is
   * matched against - and a wrong pairing here would produce confident
   * nonsense.
   */
  const claims = [
    ['waterClasses', PROTOMAPS_SCHEMA.layers.waterLabel, PROTOMAPS_SCHEMA.fields.classField, PROTOMAPS_SCHEMA.waterClasses],
    ['protectedClasses', PROTOMAPS_SCHEMA.layers.landuseOverlay, PROTOMAPS_SCHEMA.fields.classField, PROTOMAPS_SCHEMA.protectedClasses],
    ['landcover', PROTOMAPS_SCHEMA.layers.landcover, PROTOMAPS_SCHEMA.fields.classField,
      Object.values(PROTOMAPS_SCHEMA.landcover || {}).flat()],
    ['landuse', PROTOMAPS_SCHEMA.layers.landuse, PROTOMAPS_SCHEMA.fields.classField,
      Object.values(PROTOMAPS_SCHEMA.landuse || {}).flat()],
    ['place', PROTOMAPS_SCHEMA.layers.place, PROTOMAPS_SCHEMA.fields.classField,
      Object.values(PROTOMAPS_SCHEMA.place || {}).flat()],
    ['boundaryClasses', PROTOMAPS_SCHEMA.layers.boundary, PROTOMAPS_SCHEMA.fields.classField,
      Object.values(PROTOMAPS_SCHEMA.boundaryClasses || {}).flat()],
    ['roadClasses', PROTOMAPS_SCHEMA.layers.road, PROTOMAPS_SCHEMA.fields.roadClassField,
      [...Object.values(PROTOMAPS_SCHEMA.roadClasses || {}),
        ...Object.values(PROTOMAPS_SCHEMA.roadLinks || {})]],
  ];

  const findings = [];
  console.log('\nThe schema against this tile');
  for (const [what, layerName, field, values] of claims) {
    if (!layerName || !field || !values?.length) continue;
    const present = seenIn(layerName, field);
    if (!present.size) {
      findings.push({ what, field: `${layerName}.${field}`, silent: true });
      console.log(`  ${what.padEnd(17)} ${layerName}.${field} carries nothing in this tile — cannot say`);
      continue;
    }
    const named = new Set(values.map(String));
    const unused = [...named].filter((one) => !present.has(one));
    const undrawn = [...present].filter((one) => !named.has(String(one))).map(String);
    findings.push({ what, field: `${layerName}.${field}`, unused, undrawn });
    console.log(`  ${what.padEnd(17)} ${layerName}.${field}`);
    if (unused.length) console.log(`    named, not in this tile   ${unused.join(', ')}`);
    if (undrawn.length) console.log(`    in this tile, not named   ${undrawn.join(', ')}`);
    if (!unused.length && !undrawn.length) console.log('    every value lines up');
  }

  /*
   * And whether the labelled layers carry a name at all, since every label
   * layer filters on one and a layer with no name field labels nothing.
   */
  console.log('\n  Does anything here have a name?');
  for (const layer of layers) {
    const names = layer.seen.get(PROTOMAPS_SCHEMA.fields.name);
    const count = names ? [...names].filter((one) => one !== undefined).length : 0;
    console.log(`    ${layer.name.padEnd(12)} ${count ? `${count} distinct` : `no "${PROTOMAPS_SCHEMA.fields.name}" field`}`);
  }
  return findings;
}
