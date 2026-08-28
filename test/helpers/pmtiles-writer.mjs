/**
 * A PMTiles writer, for building fixtures.
 *
 * Deliberately not the reader run backwards: the varint encoder, the delta
 * encoding and the header layout are written out from the format description,
 * so a symmetrical mistake in the two cannot cancel itself. The one piece it
 * shares with the reader is the Hilbert numbering, which is why the ids that
 * produces are pinned against published values in the tests.
 *
 * Lives outside `test/*.test.mjs` so the runner does not treat it as a suite,
 * and so `tools/serve-archive.mjs` can build the same archives to serve over a
 * real HTTP connection.
 */

import { gzipSync } from 'node:zlib';
import { tileId, COMPRESSION, TILE_TYPE, HEADER_BYTES } from '../../assets/js/lib/pmtiles.js';

export function varint(value) {
  const out = [];
  let n = value;
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

export function encodeDirectory(entries) {
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
export function buildArchive(tiles, {
  leaves = false, compression = COMPRESSION.gzip, metadata = { name: 'test' },
  bounds = { west: -85, south: 35, east: -83, north: 37 },
} = {}) {
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
  view.setInt32(102, Math.round(bounds.west * 1e7), true);
  view.setInt32(106, Math.round(bounds.south * 1e7), true);
  view.setInt32(110, Math.round(bounds.east * 1e7), true);
  view.setInt32(114, Math.round(bounds.north * 1e7), true);

  const file = new Uint8Array(tileOffset + tileData.length);
  file.set(header, 0);
  file.set(rootBytes, rootOffset);
  file.set(metadataBytes, metadataOffset);
  file.set(leafBytes, leafOffset);
  file.set(tileData, tileOffset);
  return file;
}
