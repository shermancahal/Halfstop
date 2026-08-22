/**
 * Minimal ZIP writer — the counterpart to assets/js/lib/kmz.js, which reads them.
 *
 * Exists so `npm run dist -- --zip` works on any machine with Node and nothing
 * else. Shelling out to a `zip` binary would be shorter, but Windows has no zip
 * on PATH by default and this project deliberately has no dependencies.
 *
 * Deflate comes from CompressionStream, available in Node 18+.
 */

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_UTF8 = 0x0800;

/**
 * Fixed DOS timestamp (1980-01-01 00:00), so rebuilding an unchanged site
 * produces a byte-identical archive. Real mtimes would make every build differ.
 */
const DOS_DATE = (1 << 5) | 1;
const DOS_TIME = 0;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Build a ZIP archive.
 *
 * @param {Array<{name: string, data: Uint8Array}>} entries  paths use forward slashes
 * @returns {Promise<Uint8Array>}
 */
export async function createZip(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name.replace(/\\/g, '/'));
    const data = entry.data;
    const checksum = crc32(data);

    // Only keep the compressed form when it actually helps; already-compressed
    // bytes routinely inflate under deflate.
    const deflated = await deflateRaw(data);
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_SIGNATURE, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, FLAG_UTF8, true);
    localView.setUint16(8, method, true);
    localView.setUint16(10, DOS_TIME, true);
    localView.setUint16(12, DOS_DATE, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, payload.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const record = new Uint8Array(46 + nameBytes.length);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, CENTRAL_SIGNATURE, true);
    recordView.setUint16(4, 20, true);
    recordView.setUint16(6, 20, true);
    recordView.setUint16(8, FLAG_UTF8, true);
    recordView.setUint16(10, method, true);
    recordView.setUint16(12, DOS_TIME, true);
    recordView.setUint16(14, DOS_DATE, true);
    recordView.setUint32(16, checksum, true);
    recordView.setUint32(20, payload.length, true);
    recordView.setUint32(24, data.length, true);
    recordView.setUint16(28, nameBytes.length, true);
    recordView.setUint32(38, 0o644 << 16, true); // external attrs: unix rw-r--r--
    recordView.setUint32(42, offset, true);
    record.set(nameBytes, 46);

    chunks.push(local, payload);
    central.push(record);
    offset += local.length + payload.length;
  }

  const centralSize = central.reduce((sum, record) => sum + record.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, EOCD_SIGNATURE, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of [...chunks, ...central, eocd]) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}
