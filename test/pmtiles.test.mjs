/**
 * Tests for the PMTiles reader.
 *
 * These build archives byte by byte rather than fetching one, for two reasons.
 * The suite runs with no network — that is a property worth keeping — and a
 * fixture downloaded from somewhere would only prove the reader agrees with
 * whatever built it. Written here, the archive is described by the spec on one
 * side and read by our code on the other, and a disagreement is a real one.
 *
 * The writer below is deliberately not the reader run backwards: the varint
 * encoder, the delta encoding and the header layout are all written out from
 * the format description, so a symmetrical mistake cannot cancel itself. The
 * one piece both sides share is the Hilbert numbering, which is why the ids it
 * produces are pinned against the values the spec itself lists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import {
  PMTilesArchive, COMPRESSION, TILE_TYPE, HEADER_BYTES,
  tileId, readVarint, decodeDirectory, findEntry, parseHeader, parseTileURL,
  decompress, registerPMTilesProtocol,
} from '../assets/js/lib/pmtiles.js';
import { memoryTileStore, tileKey } from '../assets/js/lib/pmtiles-store.js';
import { tileKeysFor, downloadArchiveTiles, countTiles } from '../assets/js/lib/offline.js';

// The Cherokee National Forest, roughly — the same box the offline tests use.
const SMOKIES = { west: -84.5, south: 35.4, east: -83.6, north: 36.0 };

/* ----------------------------------------------------------------- writing */

function varint(value) {
  const out = [];
  let n = value;
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

function encodeDirectory(entries) {
  const sorted = [...entries].sort((a, b) => a.tileId - b.tileId);
  const out = [...varint(sorted.length)];
  let last = 0;
  for (const entry of sorted) {
    out.push(...varint(entry.tileId - last));
    last = entry.tileId;
  }
  for (const entry of sorted) out.push(...varint(entry.runLength));
  for (const entry of sorted) out.push(...varint(entry.length));
  for (let i = 0; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const contiguous = i > 0 && sorted[i].offset === previous.offset + previous.length;
    out.push(...varint(contiguous ? 0 : sorted[i].offset + 1));
  }
  return Uint8Array.from(out);
}

const gzip = (bytes) => new Uint8Array(gzipSync(Buffer.from(bytes)));

/**
 * Assemble an archive.
 *
 * @param {Map<string, Uint8Array>} tiles  Keyed "z/x/y".
 * @param {{leaves?: boolean, compression?: number, metadata?: object}} options
 *   `leaves` puts every entry in a leaf directory with a single pointer in the
 *   root — the shape a real continental archive has, and the code path a small
 *   fixture would otherwise never reach.
 */
function buildArchive(tiles, { leaves = false, compression = COMPRESSION.gzip, metadata = { name: 'test' } } = {}) {
  const pack = compression === COMPRESSION.gzip ? gzip : (b) => b;

  const blobs = [];
  const entries = [];
  let cursor = 0;
  const ids = [...tiles.entries()]
    .map(([key, body]) => {
      const [z, x, y] = key.split('/').map(Number);
      return { id: tileId(z, x, y), body };
    })
    .sort((a, b) => a.id - b.id);

  for (const { id, body } of ids) {
    const packed = pack(body);
    blobs.push(packed);
    entries.push({ tileId: id, offset: cursor, length: packed.length, runLength: 1 });
    cursor += packed.length;
  }
  const tileData = Uint8Array.from(blobs.flatMap((b) => [...b]));

  const metadataBytes = pack(new TextEncoder().encode(JSON.stringify(metadata)));

  let rootBytes;
  let leafBytes = new Uint8Array(0);
  if (leaves) {
    const leaf = pack(encodeDirectory(entries));
    leafBytes = leaf;
    rootBytes = pack(encodeDirectory([
      { tileId: entries[0].tileId, offset: 0, length: leaf.length, runLength: 0 },
    ]));
  } else {
    rootBytes = pack(encodeDirectory(entries));
  }

  const rootOffset = HEADER_BYTES;
  const metadataOffset = rootOffset + rootBytes.length;
  const leafOffset = metadataOffset + metadataBytes.length;
  const tileOffset = leafOffset + leafBytes.length;

  const header = new Uint8Array(HEADER_BYTES);
  header.set([...'PMTiles'].map((c) => c.charCodeAt(0)), 0);
  header[7] = 3;
  const view = new DataView(header.buffer);
  const put = (at, value) => view.setBigUint64(at, BigInt(value), true);
  put(8, rootOffset);
  put(16, rootBytes.length);
  put(24, metadataOffset);
  put(32, metadataBytes.length);
  put(40, leafOffset);
  put(48, leafBytes.length);
  put(56, tileOffset);
  put(64, tileData.length);
  put(72, entries.length);
  put(80, entries.length);
  put(88, entries.length);
  header[96] = 1;
  header[97] = compression;
  header[98] = compression;
  header[99] = TILE_TYPE.mvt;
  header[100] = Math.min(...ids.length ? [...tiles.keys()].map((k) => Number(k.split('/')[0])) : [0]);
  header[101] = Math.max(...ids.length ? [...tiles.keys()].map((k) => Number(k.split('/')[0])) : [0]);
  view.setInt32(102, Math.round(-85 * 1e7), true);
  view.setInt32(106, Math.round(35 * 1e7), true);
  view.setInt32(110, Math.round(-83 * 1e7), true);
  view.setInt32(114, Math.round(37 * 1e7), true);

  const file = new Uint8Array(tileOffset + tileData.length);
  file.set(header, 0);
  file.set(rootBytes, rootOffset);
  file.set(metadataBytes, metadataOffset);
  file.set(leafBytes, leafOffset);
  file.set(tileData, tileOffset);
  return file;
}

/**
 * A fetch that serves one buffer over range requests, and counts them.
 *
 * `honourRange: false` is the server that ignores Range and sends the whole
 * file with a 200 — a real behaviour of some static hosts, and one that would
 * otherwise hand the header back where a tile was asked for.
 */
function serve(file, { honourRange = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const range = options.headers?.Range;
    calls.push(range || null);
    if (!honourRange || !range) {
      return { ok: true, status: 200, arrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) };
    }
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range).map(Number);
    const slice = file.subarray(start, Math.min(end + 1, file.length));
    return { ok: true, status: 206, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
  };
  return { fetch: fetchImpl, calls };
}

const body = (text) => new TextEncoder().encode(text);
const text = (bytes) => new TextDecoder().decode(bytes);

const SAMPLE = new Map([
  ['0/0/0', body('the whole world')],
  ['8/70/100', body('somewhere in Tennessee')],
  ['8/70/101', body('one tile south')],
  ['8/71/100', body('one tile east')],
  ['12/1130/1620', body('a hollow with a name')],
]);

/* ------------------------------------------------------------- tile numbers */

/*
 * The Hilbert numbering, pinned against the values the spec lists.
 *
 * This is the one function the writer above shares with the reader, so a
 * mistake in it would be invisible to every round-trip test below. These are
 * the published ids, not ids this code produced.
 */
test('tile ids follow the Hilbert order the spec publishes', () => {
  assert.equal(tileId(0, 0, 0), 0);
  assert.equal(tileId(1, 0, 0), 1);
  assert.equal(tileId(1, 0, 1), 2);
  assert.equal(tileId(1, 1, 1), 3);
  assert.equal(tileId(1, 1, 0), 4);
  assert.equal(tileId(2, 0, 0), 5);
  // Each level begins where every level below it ended: (4^z - 1) / 3.
  assert.equal(tileId(3, 0, 0), (4 ** 3 - 1) / 3);
  assert.equal(tileId(14, 0, 0), (4 ** 14 - 1) / 3);
});

test('tile ids are unique and contiguous across a whole zoom level', () => {
  const seen = new Set();
  for (let x = 0; x < 8; x += 1) {
    for (let y = 0; y < 8; y += 1) seen.add(tileId(3, x, y));
  }
  assert.equal(seen.size, 64, 'every tile at z3 has its own id');
  const sorted = [...seen].sort((a, b) => a - b);
  assert.equal(sorted[0], 21);
  assert.equal(sorted[63], 84, 'and the level fills its range with no gaps');
});

/*
 * Consecutive ids are neighbouring tiles.
 *
 * This is the property the Hilbert curve exists for and the reason PMTiles
 * uses it: tiles near each other on the ground are near each other in the
 * file, so one range request fetches a usable region. Nothing above tests it -
 * the pinned ids are all corner tiles, where the rotation cancels, and any
 * bijection passes the uniqueness check. Deleting the coordinate swap inside
 * the loop leaves every test above green and breaks this one on the first
 * step, which is what the check is for.
 */
test('consecutive ids are tiles that touch, which is the whole point of the curve', () => {
  for (const z of [3, 4, 6]) {
    const side = 2 ** z;
    const at = new Map();
    for (let x = 0; x < side; x += 1) {
      for (let y = 0; y < side; y += 1) at.set(tileId(z, x, y), [x, y]);
    }
    const ids = [...at.keys()].sort((a, b) => a - b);
    for (let i = 1; i < ids.length; i += 1) {
      const [px, py] = at.get(ids[i - 1]);
      const [x, y] = at.get(ids[i]);
      const step = Math.abs(x - px) + Math.abs(y - py);
      assert.equal(step, 1, `z${z}: id ${ids[i - 1]} at ${px},${py} then ${ids[i]} at ${x},${y} — a jump of ${step}`);
    }
  }
});

test('a tile outside its zoom is refused rather than folded into another', () => {
  assert.throws(() => tileId(3, 8, 0), RangeError);
  assert.throws(() => tileId(3, 0, -1), RangeError);
  assert.throws(() => tileId(30, 0, 0), RangeError);
});

/* ---------------------------------------------------------------- varints */

test('varints decode past 32 bits, where a shift would wrap', () => {
  const big = 2 ** 40 + 12345;
  const cursor = { bytes: Uint8Array.from(varint(big)), pos: 0 };
  assert.equal(readVarint(cursor), big);
});

test('a varint running off the end says so instead of returning a short number', () => {
  // 0x80 sets the continuation bit, so the buffer ends mid-number.
  assert.throws(() => readVarint({ bytes: Uint8Array.from([0x80]), pos: 0 }), /ran off the end/);
});

/* ------------------------------------------------------------- directories */

test('a directory round-trips, including the implied contiguous offsets', () => {
  const entries = [
    { tileId: 5, offset: 0, length: 10, runLength: 1 },
    { tileId: 6, offset: 10, length: 20, runLength: 1 },
    // A gap, so this one cannot use the implied offset.
    { tileId: 9, offset: 100, length: 5, runLength: 1 },
  ];
  assert.deepEqual(decodeDirectory(encodeDirectory(entries)), entries);
});

test('a run covers the ids inside it and stops at its end', () => {
  const entries = decodeDirectory(encodeDirectory([
    { tileId: 100, offset: 0, length: 4, runLength: 3 },
    { tileId: 200, offset: 4, length: 4, runLength: 1 },
  ]));
  assert.equal(findEntry(entries, 100).tileId, 100);
  assert.equal(findEntry(entries, 102).tileId, 100, 'the third id of the run is still that entry');
  assert.equal(findEntry(entries, 103), null, 'and the one past it is not');
  assert.equal(findEntry(entries, 201), null, 'a run of one covers only itself');
  assert.equal(findEntry(entries, 99), null, 'nothing below the first entry');
});

test('a run length of zero is a leaf pointer and covers everything above it', () => {
  const entries = decodeDirectory(encodeDirectory([
    { tileId: 50, offset: 0, length: 30, runLength: 0 },
  ]));
  assert.equal(findEntry(entries, 50).runLength, 0);
  assert.equal(findEntry(entries, 5000).tileId, 50, 'a leaf is asked about any id at or above it');
});

/* ------------------------------------------------------------------ header */

test('the header reports what was written into it', () => {
  const header = parseHeader(buildArchive(SAMPLE));
  assert.equal(header.rootDirectoryOffset, HEADER_BYTES);
  assert.equal(header.tileType, TILE_TYPE.mvt);
  assert.equal(header.internalCompression, COMPRESSION.gzip);
  assert.equal(header.minZoom, 0);
  assert.equal(header.maxZoom, 12);
  assert.equal(header.clustered, true);
  assert.equal(header.addressedTiles, SAMPLE.size);
  assert.equal(Math.round(header.bounds.west), -85);
  assert.equal(Math.round(header.bounds.north), 37);
});

test('something that is not an archive is refused by name', () => {
  const notAnArchive = new Uint8Array(HEADER_BYTES);
  notAnArchive.set(body('<!doctype'), 0);
  assert.throws(() => parseHeader(notAnArchive), /not a PMTiles archive/);
});

test('a version this cannot read is refused rather than misread', () => {
  const wrong = buildArchive(SAMPLE);
  wrong[7] = 2;
  assert.throws(() => parseHeader(wrong), /PMTiles v2/);
});

test('a truncated header is refused rather than read past the end', () => {
  assert.throws(() => parseHeader(buildArchive(SAMPLE).subarray(0, 64)), /127 bytes/);
});

/* ------------------------------------------------------------------ tiles */

test('every tile written comes back out', async () => {
  const file = buildArchive(SAMPLE);
  const archive = new PMTilesArchive('https://example.test/x.pmtiles', serve(file));
  for (const [key, expected] of SAMPLE) {
    const [z, x, y] = key.split('/').map(Number);
    assert.equal(text(await archive.tile(z, x, y)), text(expected), key);
  }
});

test('a tile the archive does not hold is null, not an error', async () => {
  const archive = new PMTilesArchive('https://example.test/x.pmtiles', serve(buildArchive(SAMPLE)));
  assert.equal(await archive.tile(8, 70, 102), null, 'inside the zoom range, outside the coverage');
  assert.equal(await archive.tile(13, 0, 0), null, 'past the archive maxzoom');
});

test('tiles come back through a leaf directory too', async () => {
  const file = buildArchive(SAMPLE, { leaves: true });
  const archive = new PMTilesArchive('https://example.test/x.pmtiles', serve(file));
  assert.equal(text(await archive.tile(8, 70, 100)), 'somewhere in Tennessee');
  assert.equal(text(await archive.tile(12, 1130, 1620)), 'a hollow with a name');
  assert.equal(await archive.tile(8, 70, 102), null);
});

/*
 * The leaf path is genuinely the leaf path.
 *
 * The check above passes either way if the root happens to hold the tiles, so
 * this reads the archive's own root directory and insists it holds one entry
 * with a run length of zero — the pointer, not the tiles.
 */
test('the leaf fixture really does hide its tiles behind a pointer', async () => {
  const file = buildArchive(SAMPLE, { leaves: true });
  const archive = new PMTilesArchive('https://example.test/x.pmtiles', serve(file));
  const header = await archive.header();
  const root = await archive.directory(header.rootDirectoryOffset, header.rootDirectoryLength);
  assert.equal(root.length, 1);
  assert.equal(root[0].runLength, 0);
  assert.ok(header.leafDirectoryLength > 0);
});

test('an uncompressed archive is read as readily as a gzipped one', async () => {
  const file = buildArchive(SAMPLE, { compression: COMPRESSION.none });
  const archive = new PMTilesArchive('https://example.test/x.pmtiles', serve(file));
  assert.equal(text(await archive.tile(0, 0, 0)), 'the whole world');
});

test('a compression no browser has is named rather than returning empty tiles', async () => {
  await assert.rejects(
    () => decompress(body('anything'), COMPRESSION.brotli),
    /brotli-compressed.*rebuild it with gzip/s,
  );
});

/* -------------------------------------------------------------- transport */

test('a server that ignores Range is handled rather than served the header', async () => {
  const file = buildArchive(SAMPLE);
  const archive = new PMTilesArchive('https://example.test/x.pmtiles', serve(file, { honourRange: false }));
  assert.equal(text(await archive.tile(8, 70, 100)), 'somewhere in Tennessee');
});

test('an error status is reported, not decoded', async () => {
  const archive = new PMTilesArchive('https://example.test/x.pmtiles', {
    fetch: async () => ({ ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) }),
  });
  await assert.rejects(() => archive.tile(0, 0, 0), /answered 403/);
});

/*
 * Header and root directory arrive together.
 *
 * The spec requires the root to fit in the first 16kB, and reading both in one
 * request is the difference between two round trips and one before anything
 * draws. Counted rather than asserted about, because "it is faster" is exactly
 * the kind of claim that quietly stops being true.
 */
test('the first tile costs two requests, not three', async () => {
  const served = serve(buildArchive(SAMPLE));
  const archive = new PMTilesArchive('https://example.test/x.pmtiles', served);
  await archive.tile(8, 70, 100);
  assert.equal(served.calls.length, 2, `header+root, then the tile — got ${served.calls.join(' | ')}`);
});

test('directories are read once and reused across tiles', async () => {
  const served = serve(buildArchive(SAMPLE, { leaves: true }));
  const archive = new PMTilesArchive('https://example.test/x.pmtiles', served);
  await archive.tile(8, 70, 100);
  const afterFirst = served.calls.length;
  await archive.tile(8, 70, 101);
  await archive.tile(8, 71, 100);
  assert.equal(served.calls.length, afterFirst + 2, 'two more tiles, two more requests — the leaf was not re-read');
});

test('the metadata the builder wrote is readable', async () => {
  const file = buildArchive(SAMPLE, { metadata: { name: 'Byways', vector_layers: [{ id: 'roads' }] } });
  const archive = new PMTilesArchive('https://example.test/x.pmtiles', serve(file));
  const metadata = await archive.metadata();
  assert.equal(metadata.name, 'Byways');
  assert.equal(metadata.vector_layers[0].id, 'roads');
});

/* ----------------------------------------------------------------- the URL */

test('a tile URL splits at the last three segments, not the first', () => {
  assert.deepEqual(parseTileURL('pmtiles://https://cdn.example.com/tiles/byways.pmtiles/12/1130/1620'), {
    archive: 'https://cdn.example.com/tiles/byways.pmtiles', z: 12, x: 1130, y: 1620,
  });
  assert.deepEqual(parseTileURL('pmtiles://./tiles/byways.pmtiles/0/0/0'), {
    archive: './tiles/byways.pmtiles', z: 0, x: 0, y: 0,
  });
  assert.equal(parseTileURL('https://example.com/1/2/3'), null, 'another scheme is not ours');
  assert.equal(parseTileURL('pmtiles://x.pmtiles'), null, 'and neither is a URL with no tile on it');
});

/* ------------------------------------------------------------- the protocol */

function fakeMapLibre() {
  const handlers = new Map();
  return {
    addProtocol: (name, handler) => handlers.set(name, handler),
    handlers,
  };
}

test('the protocol serves a tile as an ArrayBuffer MapLibre can parse', async () => {
  const gl = fakeMapLibre();
  const served = serve(buildArchive(SAMPLE));
  assert.equal(registerPMTilesProtocol(gl, { fetch: served.fetch, resolve: (u) => u }), true);

  const response = await gl.handlers.get('pmtiles')({ url: 'pmtiles://x.pmtiles/8/70/100' });
  assert.ok(response.data instanceof ArrayBuffer);
  assert.equal(text(new Uint8Array(response.data)), 'somewhere in Tennessee');
});

test('a tile the archive lacks is empty rather than a rejected request', async () => {
  const gl = fakeMapLibre();
  const served = serve(buildArchive(SAMPLE));
  registerPMTilesProtocol(gl, { fetch: served.fetch, resolve: (u) => u });
  const response = await gl.handlers.get('pmtiles')({ url: 'pmtiles://x.pmtiles/8/70/102' });
  assert.equal(response.data.byteLength, 0);
});

test('one archive is opened once however many tiles are asked for', async () => {
  const gl = fakeMapLibre();
  const served = serve(buildArchive(SAMPLE));
  registerPMTilesProtocol(gl, { fetch: served.fetch, resolve: (u) => u });
  const handler = gl.handlers.get('pmtiles');
  await handler({ url: 'pmtiles://x.pmtiles/8/70/100' });
  await handler({ url: 'pmtiles://x.pmtiles/8/70/101' });
  assert.equal(served.calls.length, 3, 'header+root once, then one request per tile');
});

test('an engine without addProtocol is declined, not crashed into', () => {
  assert.equal(registerPMTilesProtocol({}, {}), false, 'Mapbox GL JS has no addProtocol');
  assert.equal(registerPMTilesProtocol(null, {}), false);
});

test('registering twice does not stack two handlers on one scheme', () => {
  const gl = fakeMapLibre();
  registerPMTilesProtocol(gl, { resolve: (u) => u });
  const first = gl.handlers.get('pmtiles');
  assert.equal(registerPMTilesProtocol(gl, { resolve: (u) => u }), true);
  assert.equal(gl.handlers.get('pmtiles'), first);
});

/*
 * The archive's real depth is reported back.
 *
 * The style has to declare a maxzoom before anything has been fetched, and
 * overstating it draws blank ground rather than raising anything. The header
 * is the only place the true answer is written down, so it is handed to the
 * caller the first time an archive opens.
 */
test('the header is reported once per archive, whatever else is asked of it', async () => {
  const gl = fakeMapLibre();
  const served = serve(buildArchive(SAMPLE));
  const seen = [];
  registerPMTilesProtocol(gl, {
    fetch: served.fetch, resolve: (u) => u, onArchive: (url, header) => seen.push([url, header.maxZoom]),
  });
  const handler = gl.handlers.get('pmtiles');
  await handler({ url: 'pmtiles://x.pmtiles/8/70/100' });
  await handler({ url: 'pmtiles://x.pmtiles/8/70/101' });
  // The report is fired off alongside the tile rather than awaited with it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, [['x.pmtiles', 12]]);
});

test('a callback that throws does not take the tile down with it', async () => {
  const gl = fakeMapLibre();
  const served = serve(buildArchive(SAMPLE));
  registerPMTilesProtocol(gl, {
    fetch: served.fetch, resolve: (u) => u, onArchive: () => { throw new Error('nope'); },
  });
  const response = await gl.handlers.get('pmtiles')({ url: 'pmtiles://x.pmtiles/8/70/100' });
  assert.equal(text(new Uint8Array(response.data)), 'somewhere in Tennessee');
});

/* ------------------------------------------------------------- offline */

/*
 * The store is consulted before anything reaches for the network.
 *
 * Order is the whole of this feature. Asking the archive and falling back to
 * the store would pass every test that runs with a working fetch and fail in
 * exactly the situation it exists for: every network read begins with the
 * header, and offline that is the request that hangs. So the fetch here is one
 * that throws — which is what "no signal" looks like from inside — and a tile
 * still has to come back.
 */
test('a stored tile is served with no network at all', async () => {
  const gl = fakeMapLibre();
  const store = memoryTileStore();
  await store.put(tileKey('x.pmtiles', 8, 70, 100), body('saved earlier'));

  registerPMTilesProtocol(gl, {
    fetch: () => { throw new Error('the network is down'); },
    resolve: (u) => u,
    store,
  });
  const response = await gl.handlers.get('pmtiles')({ url: 'pmtiles://x.pmtiles/8/70/100' });
  assert.equal(text(new Uint8Array(response.data)), 'saved earlier');
});

test('a tile that was not downloaded still goes to the archive', async () => {
  const gl = fakeMapLibre();
  const served = serve(buildArchive(SAMPLE));
  registerPMTilesProtocol(gl, { fetch: served.fetch, resolve: (u) => u, store: memoryTileStore() });
  const response = await gl.handlers.get('pmtiles')({ url: 'pmtiles://x.pmtiles/8/70/100' });
  assert.equal(text(new Uint8Array(response.data)), 'somewhere in Tennessee');
});

test('the key names the archive, so two archives do not overwrite each other', async () => {
  const store = memoryTileStore();
  await store.put(tileKey('a.pmtiles', 8, 70, 100), body('from A'));
  await store.put(tileKey('b.pmtiles', 8, 70, 100), body('from B'));
  assert.equal(text(await store.get(tileKey('a.pmtiles', 8, 70, 100))), 'from A');
  assert.equal(text(await store.get(tileKey('b.pmtiles', 8, 70, 100))), 'from B');
  assert.equal(await store.count(), 2);
});

test('downloading a region fills the store, and a second run refetches nothing', async () => {
  const served = serve(buildArchive(SAMPLE));
  const archive = new PMTilesArchive('https://example.test/x.pmtiles', served);
  const store = memoryTileStore();
  const tiles = [
    { z: 8, x: 70, y: 100 }, { z: 8, x: 70, y: 101 }, { z: 8, x: 71, y: 100 },
    // Inside the archive's zoom range, outside its coverage.
    { z: 8, x: 70, y: 102 },
  ];

  const first = await downloadArchiveTiles(tiles, { archive, store, name: 'x.pmtiles', concurrency: 2 });
  assert.equal(first.done, 3);
  assert.equal(first.absent, 1, 'a tile the archive does not hold is absent, not failed');
  assert.equal(first.failed, 0);
  assert.equal(await store.count(), 3);

  const before = served.calls.length;
  const second = await downloadArchiveTiles(tiles, { archive, store, name: 'x.pmtiles' });
  assert.equal(second.done, 3);
  assert.equal(
    served.calls.length - before, 0,
    'the stored tiles cost no requests, and the miss costs none either'
    + ' — the directory saying it is not there is already in memory',
  );
});

test('a download reports what it stored rather than what it was asked for', async () => {
  /*
   * The distinction that gets found out on a mountain. A region drawn slightly
   * over the edge of an archive asks for tiles that do not exist, and reporting
   * those as saved is the kind of reassurance there is no way to check until
   * there is no signal to check it with.
   */
  const served = serve(buildArchive(SAMPLE));
  const archive = new PMTilesArchive('https://example.test/x.pmtiles', served);
  const store = memoryTileStore();
  const outside = Array.from({ length: 5 }, (unused, i) => ({ z: 8, x: 200, y: 100 + i }));
  const result = await downloadArchiveTiles(outside, { archive, store, name: 'x.pmtiles' });
  assert.equal(result.done, 0);
  assert.equal(result.absent, 5);
  assert.equal(await store.count(), 0);
});

test('a download can be stopped, and keeps what it already had', async () => {
  const served = serve(buildArchive(SAMPLE));
  const archive = new PMTilesArchive('https://example.test/x.pmtiles', served);
  const store = memoryTileStore();
  const controller = new AbortController();
  const tiles = [{ z: 8, x: 70, y: 100 }, { z: 8, x: 70, y: 101 }, { z: 8, x: 71, y: 100 }];

  const result = await downloadArchiveTiles(tiles, {
    archive, store, name: 'x.pmtiles', concurrency: 1,
    onProgress: () => controller.abort(),
    signal: controller.signal,
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.done, 1, 'the one that finished before the stop is kept');
  assert.equal(await store.count(), 1);
});

test('the region planner and the archive downloader count the same tiles', () => {
  /*
   * The number on the button and the number in the loop have to be the one
   * number. They are computed by different code — countTiles from the bounds,
   * tileKeysFor by walking them — and a person deciding whether a download will
   * finish before they leave is reading the first while the second runs.
   */
  const tiers = [10, 11].map((zoom) => ({ zoom, boxes: [SMOKIES] }));
  const tiles = tileKeysFor(tiers);
  const counted = tiers.reduce((sum, tier) => sum + countTiles(tier.boxes[0], tier.zoom, tier.zoom), 0);
  assert.equal(tiles.length, counted);
  assert.ok(tiles.length > 0);
});

test('overlapping tiers are downloaded once, not once per tier', () => {
  const tiles = tileKeysFor([
    { zoom: 10, boxes: [SMOKIES] },
    { zoom: 10, boxes: [SMOKIES] },
  ]);
  assert.equal(tiles.length, tileKeysFor([{ zoom: 10, boxes: [SMOKIES] }]).length);
});
