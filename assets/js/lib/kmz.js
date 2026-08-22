/**
 * Minimal KMZ (zip) reader — enough to pull the KML entry out of a GaiaGPS or
 * Google Earth export.
 *
 * A KMZ is a zip whose first .kml entry is the document. We read the central
 * directory, then inflate the one entry we need with DecompressionStream, which
 * is available in modern browsers and in Node 18+. No dependency, no bundler.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

function findEndOfCentralDirectory(view) {
  // The EOCD sits at the end, after a comment of up to 64 KiB. Scan backwards.
  const maxScan = Math.min(view.byteLength, 0x10000 + 22);
  for (let offset = view.byteLength - 22; offset >= view.byteLength - maxScan; offset--) {
    if (offset < 0) break;
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot expand KMZ files. Please upload the .kml or .gpx instead.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Entries in the zip, as { name, offset, compressedSize, uncompressedSize, method }. */
function readCentralDirectory(buffer) {
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd === -1) throw new Error('Not a valid KMZ file (no zip directory found).');

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLength));
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readEntry(buffer, entry) {
  const view = new DataView(buffer);
  // The local header repeats the name/extra lengths, and they can differ from the
  // central directory's, so the data offset must come from the local header.
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const bytes = new Uint8Array(buffer, start, entry.compressedSize);
  if (entry.method === 0) return bytes.slice();
  if (entry.method === 8) return inflateRaw(bytes);
  throw new Error(`Unsupported compression in KMZ entry "${entry.name}".`);
}

/** Extract the KML document text from a KMZ ArrayBuffer. */
export async function extractKMLFromKMZ(buffer) {
  const entries = readCentralDirectory(buffer);
  const kmlEntry = entries.find((e) => /\.kml$/i.test(e.name) && !e.name.startsWith('__MACOSX'))
    || entries.find((e) => /doc\.kml$/i.test(e.name));
  if (!kmlEntry) throw new Error('No .kml document inside this KMZ file.');
  return new TextDecoder().decode(await readEntry(buffer, kmlEntry));
}
