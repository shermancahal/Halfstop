/**
 * A PMTiles v3 reader, written out rather than depended on.
 *
 * PMTiles is one file holding a whole tile pyramid, read a slice at a time
 * with HTTP range requests. That is the property the Protomaps basemap is for:
 * a map that can be *downloaded*, because "the map" is a file rather than a
 * few hundred thousand URLs, and one that costs nothing per view because it is
 * served as static bytes from wherever we put it.
 *
 * The reference implementation is a dependency, and this project has none at
 * runtime — every library it uses arrives from a CDN at the moment it is
 * needed, and adding a build step to bundle one would change what this app is.
 * The format is small enough to read: a fixed 127-byte header, directories of
 * varint-delta entries, and tiles addressed by their position on a Hilbert
 * curve. What is implemented here is all of v3 that a vector basemap uses.
 *
 * What is deliberately not here: brotli and zstd tile compression. Browsers
 * decompress gzip and deflate and nothing else, so an archive built with
 * either would fail — and it fails loudly, naming the compression, rather than
 * returning an empty tile that looks like ocean.
 *
 * Everything below is exercised against archives the test suite builds byte by
 * byte, including one with a leaf directory, because an archive large enough
 * to need leaves is exactly the size we will ship and exactly the path that
 * never runs on a small fixture.
 */

/** The magic at the head of every archive, and the only version this reads. */
export const PMTILES_MAGIC = 'PMTiles';
export const PMTILES_VERSION = 3;
export const HEADER_BYTES = 127;

/** Compression identifiers, as the spec numbers them. */
export const COMPRESSION = {
  unknown: 0,
  none: 1,
  gzip: 2,
  brotli: 3,
  zstd: 4,
};

const COMPRESSION_NAMES = ['unknown', 'none', 'gzip', 'brotli', 'zstd'];

/** Tile content types, same source. */
export const TILE_TYPE = {
  unknown: 0,
  mvt: 1,
  png: 2,
  jpeg: 3,
  webp: 4,
  avif: 5,
};

/*
 * The number of tiles in every zoom level below z, which is where level z's
 * ids start. (4^z - 1) / 3, written as a running sum so it stays exact.
 *
 * Stops at 27 because that is where the id would leave the range integers are
 * exact in. No basemap goes near it; asking is still an error rather than a
 * wrong answer.
 */
const ZOOM_BASE = (() => {
  const out = [0];
  let acc = 0;
  for (let z = 0; z < 27; z += 1) {
    acc += 4 ** z;
    out.push(acc);
  }
  return out;
})();

export const MAX_TILE_ZOOM = 26;

/**
 * The id of a tile, which is its position along a Hilbert curve.
 *
 * Z/X/Y order would scatter neighbouring tiles across the file; Hilbert order
 * keeps them adjacent, which is what makes one range request fetch a usable
 * region and what makes the directories compress. The rotation below is the
 * standard d2xy inverse — it is not obvious, and it is not ours to improve.
 *
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
export function tileId(z, x, y) {
  if (!Number.isInteger(z) || z < 0 || z > MAX_TILE_ZOOM) {
    throw new RangeError(`zoom ${z} is outside 0..${MAX_TILE_ZOOM}`);
  }
  const side = 2 ** z;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= side || y >= side) {
    throw new RangeError(`tile ${x},${y} is outside zoom ${z}`);
  }

  let tx = x;
  let ty = y;
  let d = 0;
  for (let s = side / 2; s > 0; s /= 2) {
    const rx = (tx & s) > 0 ? 1 : 0;
    const ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        tx = s - 1 - tx;
        ty = s - 1 - ty;
      }
      const swap = tx;
      tx = ty;
      ty = swap;
    }
  }
  return ZOOM_BASE[z] + d;
}

/**
 * Read one LEB128 varint.
 *
 * Accumulated by multiplication rather than by shifting: `<<` in JavaScript
 * truncates to 32 bits, and directory offsets in a continental archive pass
 * that inside the first gigabyte. The symptom would be tiles read from the
 * wrong place in the file — decodable garbage, not an error.
 *
 * @param {{bytes: Uint8Array, pos: number}} cursor
 * @returns {number}
 */
export function readVarint(cursor) {
  let value = 0;
  let multiplier = 1;
  for (let i = 0; i < 10; i += 1) {
    if (cursor.pos >= cursor.bytes.length) throw new Error('varint ran off the end of the buffer');
    const byte = cursor.bytes[cursor.pos];
    cursor.pos += 1;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) throw new Error('varint is too large to be exact');
      return value;
    }
    multiplier *= 128;
  }
  throw new Error('varint did not terminate');
}

/**
 * Decode a directory.
 *
 * The layout is column-major — every id, then every run length, then every
 * length, then every offset — which is what lets the deltas compress. An
 * offset of 0 means "immediately after the previous entry", which is how a
 * clustered archive avoids storing an offset at all for most tiles.
 *
 * @param {Uint8Array} bytes  The decompressed directory.
 * @returns {Array<{tileId: number, offset: number, length: number, runLength: number}>}
 */
export function decodeDirectory(bytes) {
  const cursor = { bytes, pos: 0 };
  const count = readVarint(cursor);
  const entries = new Array(count);

  let id = 0;
  for (let i = 0; i < count; i += 1) {
    id += readVarint(cursor);
    entries[i] = { tileId: id, offset: 0, length: 0, runLength: 0 };
  }
  for (let i = 0; i < count; i += 1) entries[i].runLength = readVarint(cursor);
  for (let i = 0; i < count; i += 1) entries[i].length = readVarint(cursor);
  for (let i = 0; i < count; i += 1) {
    const raw = readVarint(cursor);
    if (raw === 0 && i > 0) entries[i].offset = entries[i - 1].offset + entries[i - 1].length;
    else entries[i].offset = raw - 1;
  }
  return entries;
}

/**
 * The entry covering a tile id, or null.
 *
 * Entries are sorted and may each stand for a *run* of consecutive ids — one
 * entry covering a thousand identical ocean tiles is how the format stays
 * small — so a miss on the binary search still has to look at the entry before
 * the insertion point. A run length of 0 marks a leaf directory rather than a
 * tile, and covers every id up to the next entry.
 *
 * @param {Array} entries
 * @param {number} id
 */
export function findEntry(entries, id) {
  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (id > entries[mid].tileId) low = mid + 1;
    else if (id < entries[mid].tileId) high = mid - 1;
    else return entries[mid];
  }
  // low is now the insertion point, so high is the last entry at or below id.
  if (high < 0) return null;
  const candidate = entries[high];
  if (candidate.runLength === 0) return candidate;
  if (id - candidate.tileId < candidate.runLength) return candidate;
  return null;
}

/**
 * Parse the fixed header.
 *
 * @param {ArrayBuffer|Uint8Array} input  At least the first 127 bytes.
 */
export function parseHeader(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < HEADER_BYTES) {
    throw new Error(`a PMTiles header is ${HEADER_BYTES} bytes; got ${bytes.length}`);
  }
  const magic = String.fromCharCode(...bytes.subarray(0, 7));
  if (magic !== PMTILES_MAGIC) {
    throw new Error(`not a PMTiles archive (it begins ${JSON.stringify(magic)})`);
  }
  if (bytes[7] !== PMTILES_VERSION) {
    throw new Error(`PMTiles v${bytes[7]}; this reads v${PMTILES_VERSION}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = (at) => {
    const value = view.getBigUint64(at, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`header value at ${at} is too large`);
    return Number(value);
  };
  const e7 = (at) => view.getInt32(at, true) / 1e7;

  return {
    rootDirectoryOffset: u64(8),
    rootDirectoryLength: u64(16),
    metadataOffset: u64(24),
    metadataLength: u64(32),
    leafDirectoryOffset: u64(40),
    leafDirectoryLength: u64(48),
    tileDataOffset: u64(56),
    tileDataLength: u64(64),
    addressedTiles: u64(72),
    tileEntries: u64(80),
    tileContents: u64(88),
    clustered: bytes[96] === 1,
    internalCompression: bytes[97],
    tileCompression: bytes[98],
    tileType: bytes[99],
    minZoom: bytes[100],
    maxZoom: bytes[101],
    bounds: { west: e7(102), south: e7(106), east: e7(110), north: e7(114) },
    centerZoom: bytes[118],
    center: { lon: e7(119), lat: e7(123) },
  };
}

/**
 * Undo whatever the archive compressed a run of bytes with.
 *
 * `DecompressionStream` covers gzip and deflate. Brotli and zstd are in the
 * spec and in no browser, so they are named and refused — an archive built
 * with one is a build mistake to fix, not a runtime condition to absorb.
 */
export async function decompress(bytes, compression) {
  if (compression === COMPRESSION.none || compression === COMPRESSION.unknown) return bytes;
  if (compression !== COMPRESSION.gzip) {
    const name = COMPRESSION_NAMES[compression] || `id ${compression}`;
    throw new Error(`this archive is ${name}-compressed, which no browser can decompress; rebuild it with gzip`);
  }
  if (typeof DecompressionStream !== 'function') {
    throw new Error('DecompressionStream is unavailable, so gzipped tiles cannot be read');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * One archive, read over HTTP range requests.
 *
 * Directories are cached because they are read on the way to every tile: the
 * root on all of them, and a leaf on most. Without that, a pan across a city
 * re-reads and re-decompresses the same leaf a hundred times.
 */
export class PMTilesArchive {
  /**
   * @param {string} url
   * @param {{fetch?: Function, maxDirectories?: number}} [options]
   */
  constructor(url, { fetch: fetchImpl, maxDirectories = 64 } = {}) {
    this.url = url;
    this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.maxDirectories = maxDirectories;
    this.directories = new Map();
    this._header = null;
  }

  /**
   * A slice of the file.
   *
   * A server that ignores `Range` answers 200 with the whole archive, and
   * treating that as the slice would hand back the header where a tile was
   * asked for. So the status decides: 206 is the slice, 200 is the file and
   * gets cut down here.
   */
  async range(offset, length) {
    if (length === 0) return new Uint8Array(0);
    const response = await this.fetch(this.url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
    });
    if (!response.ok) throw new Error(`${this.url} answered ${response.status}`);
    const body = new Uint8Array(await response.arrayBuffer());
    if (response.status === 206) return body;
    /*
     * A 200 means the server ignored the Range header and sent everything, so
     * the slice has to be cut here. The end is a clamp rather than a promise -
     * the header read asks for 16kB and a small archive is shorter than that,
     * which is not an error - but a start past the end is one.
     */
    if (offset >= body.length) {
      throw new Error(`${this.url} is ${body.length} bytes; the slice asked to start at ${offset}`);
    }
    return body.subarray(offset, Math.min(offset + length, body.length));
  }

  async header() {
    if (!this._header) {
      /*
       * 16kB rather than 127 bytes, because the root directory is required to
       * fit in the first 16kB and is read immediately after. One request for
       * both is the difference between two round trips and one on a map that
       * has not drawn anything yet.
       */
      const first = await this.range(0, 16384);
      const header = parseHeader(first);
      this._header = header;
      if (header.rootDirectoryOffset + header.rootDirectoryLength <= first.length) {
        const raw = first.subarray(
          header.rootDirectoryOffset,
          header.rootDirectoryOffset + header.rootDirectoryLength,
        );
        this._cacheDirectory(
          header.rootDirectoryOffset,
          header.rootDirectoryLength,
          decodeDirectory(await decompress(raw, header.internalCompression)),
        );
      }
    }
    return this._header;
  }

  /** The archive's own TileJSON-ish metadata, as the builder wrote it. */
  async metadata() {
    const header = await this.header();
    if (!header.metadataLength) return {};
    const raw = await this.range(header.metadataOffset, header.metadataLength);
    const text = new TextDecoder().decode(await decompress(raw, header.internalCompression));
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  _cacheDirectory(offset, length, entries) {
    const key = `${offset}:${length}`;
    this.directories.set(key, entries);
    // Oldest out first. A Map iterates in insertion order, so the first key is
    // the least recently added.
    while (this.directories.size > this.maxDirectories) {
      const oldest = this.directories.keys().next().value;
      this.directories.delete(oldest);
    }
    return entries;
  }

  async directory(offset, length) {
    const key = `${offset}:${length}`;
    const cached = this.directories.get(key);
    if (cached) return cached;
    const header = await this.header();
    const raw = await this.range(offset, length);
    const entries = decodeDirectory(await decompress(raw, header.internalCompression));
    return this._cacheDirectory(offset, length, entries);
  }

  /**
   * One tile, decompressed, or null where the archive has none.
   *
   * Null is a real answer and not a failure: an archive covering one state has
   * nothing outside it, and drawing nothing there is correct.
   *
   * @returns {Promise<Uint8Array|null>}
   */
  async tile(z, x, y) {
    const header = await this.header();
    if (z < header.minZoom || z > header.maxZoom) return null;
    const id = tileId(z, x, y);

    let offset = header.rootDirectoryOffset;
    let length = header.rootDirectoryLength;
    /*
     * Three levels, which is one more than any archive uses.
     *
     * The format allows leaves of leaves; in practice a planet archive is two
     * levels deep. The bound is here because a corrupt directory pointing at
     * itself would otherwise loop forever inside a tile request, which on a
     * map looks like a hang with no error anywhere.
     */
    for (let depth = 0; depth < 4; depth += 1) {
      const entries = await this.directory(offset, length);
      const entry = findEntry(entries, id);
      if (!entry) return null;
      if (entry.runLength > 0) {
        const raw = await this.range(header.tileDataOffset + entry.offset, entry.length);
        return decompress(raw, header.tileCompression);
      }
      offset = header.leafDirectoryOffset + entry.offset;
      length = entry.length;
    }
    throw new Error('directory nesting is deeper than any real archive; the file is probably corrupt');
  }
}

/** `pmtiles://<archive>/{z}/{x}/{y}`, which is the only shape we ask for. */
const TILE_URL = /^pmtiles:\/\/(.+)\/(\d+)\/(\d+)\/(\d+)$/;

/**
 * Split a protocol URL into the archive it names and the tile it wants.
 *
 * Exported because it is the half that is easy to get wrong and easy to test:
 * the archive URL contains slashes and digits of its own, and a lazier pattern
 * would eat the first path segment of `https://host/tiles/x.pmtiles`.
 */
export function parseTileURL(url) {
  const match = TILE_URL.exec(String(url));
  if (!match) return null;
  return {
    archive: match[1],
    z: Number(match[2]),
    x: Number(match[3]),
    y: Number(match[4]),
  };
}

/**
 * Teach a MapLibre instance to read `pmtiles://` URLs.
 *
 * MapLibre only. Mapbox GL JS has no `addProtocol`, which is the whole reason
 * the Protomaps basemap implies the MapLibre engine rather than being a source
 * swap — returning false here rather than throwing lets the caller decide,
 * since a map with one basemap missing still works.
 *
 * @param {object} gl  The `maplibregl` global.
 * @param {{fetch?: Function, resolve?: (url: string) => string}} [options]
 * @returns {boolean} Whether the protocol was registered.
 */
export function registerPMTilesProtocol(gl, { fetch: fetchImpl, resolve } = {}) {
  if (!gl || typeof gl.addProtocol !== 'function') return false;
  if (gl.__abmapPMTiles) return true;

  const archives = new Map();
  const absolute = resolve || ((url) => (
    typeof document === 'undefined' ? url : new URL(url, document.baseURI).href
  ));

  gl.addProtocol('pmtiles', async (params) => {
    const request = parseTileURL(params.url);
    if (!request) throw new Error(`not a pmtiles tile URL: ${params.url}`);
    const key = absolute(request.archive);
    let archive = archives.get(key);
    if (!archive) {
      archive = new PMTilesArchive(key, { fetch: fetchImpl });
      archives.set(key, archive);
    }
    const bytes = await archive.tile(request.z, request.x, request.y);
    // An absent tile is empty, not an error: MapLibre draws nothing and keeps
    // going, which is what "the archive stops at the state line" should look
    // like.
    return { data: bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0) };
  });

  gl.__abmapPMTiles = archives;
  return true;
}
