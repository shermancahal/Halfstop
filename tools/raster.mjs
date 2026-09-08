/**
 * PNG in, PNG out, and the arithmetic between them.
 *
 * It exists because this project installs nothing to build itself. Pulling in
 * sharp or resvg to cut six icons out of one picture would mean the icons
 * could only be regenerated on a machine with a working native toolchain,
 * which is exactly the kind of step that rots. Node ships zlib, which is the
 * hard half of both directions.
 *
 * This was an SVG rasteriser until the mark became a painting. Several hundred
 * lines of path flattening, dashing and coverage sampling went with it: once
 * the icons were cut from a PNG, nothing drew the mark, and the only thing
 * still calling that code was the tests written for it.
 *
 * Reading is deliberately narrow - 8-bit RGB or RGBA, no interlace, which is
 * what an export tool writes and what the committed master is. Anything else
 * throws rather than returning quietly wrong pixels: an icon that renders with
 * a piece missing looks like a design decision, and nobody would catch it.
 */

import { deflateSync, inflateSync } from 'node:zlib';

/* -------------------------------------------------------------------- png -- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(body).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** Encode straight RGBA bytes as an 8-bit truecolour-with-alpha PNG. */
export function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none. These are tiny; the win is not worth the code.
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ reading */

/**
 * A PNG back into pixels, for the icons that start life as artwork.
 *
 * The sizes are still derived from one master rather than exported by hand, so
 * this has to read as well as write. Node ships the hard half (zlib), which
 * leaves the chunk walk and undoing the per-row filters.
 */
export function decodePNG(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (sig.some((b, i) => data[i] !== b)) throw new Error('not a PNG');

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];

  while (at < data.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(data[at + 4], data[at + 5], data[at + 6], data[at + 7]);
    const body = data.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      if (body[8] !== 8) throw new Error(`PNG bit depth ${body[8]} is not supported; use 8`);
      if (body[9] !== 2 && body[9] !== 6) throw new Error(`PNG colour type ${body[9]} is not supported; use RGB or RGBA`);
      if (body[12] !== 0) throw new Error('interlaced PNG is not supported');
      channels = body[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') break;
    at += 12 + length;
  }
  if (!width || !height) throw new Error('PNG has no header');

  const joined = new Uint8Array(idat.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of idat) { joined.set(part, offset); offset += part.length; }
  const raw = new Uint8Array(inflateSync(joined));

  const stride = width * channels;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let value = row[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (filter !== 0) throw new Error(`unknown PNG row filter ${filter}`);
      line[i] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      rgba[to] = line[from];
      rgba[to + 1] = line[from + 1];
      rgba[to + 2] = line[from + 2];
      rgba[to + 3] = channels === 4 ? line[from + 3] : 255;
    }
    prev.set(line);
  }
  return { width, height, rgba };
}

/**
 * Resize by averaging the source pixels each destination pixel covers.
 *
 * A box average rather than picking the nearest: every icon here is a large
 * downscale, and sampling one source pixel out of a 32-pixel square throws
 * away the other 1,023 — which on a design with fine detail turns tick marks
 * into noise that changes between sizes. Averaging is what makes the 32px
 * favicon read as the same object as the 1024px icon.
 */
export function resizeRGBA({ width, height, rgba }, size) {
  const out = new Uint8ClampedArray(size * size * 4);
  const scaleX = width / size;
  const scaleY = height / size;

  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.ceil((y + 1) * scaleY));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.ceil((x + 1) * scaleX));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < height; sy += 1) {
        for (let sx = x0; sx < x1 && sx < width; sx += 1) {
          const i = (sy * width + sx) * 4;
          r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3];
          n += 1;
        }
      }
      const to = (y * size + x) * 4;
      out[to] = r / n; out[to + 1] = g / n; out[to + 2] = b / n; out[to + 3] = a / n;
    }
  }
  return { width: size, height: size, rgba: out };
}

/** A square out of an image, clamped to its edges. */
export function cropRGBA({ width, height, rgba }, { x = 0, y = 0, size }) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    const sy = Math.min(height - 1, Math.max(0, y + row));
    for (let col = 0; col < size; col += 1) {
      const sx = Math.min(width - 1, Math.max(0, x + col));
      const from = (sy * width + sx) * 4;
      const to = (row * size + col) * 4;
      out[to] = rgba[from]; out[to + 1] = rgba[from + 1];
      out[to + 2] = rgba[from + 2]; out[to + 3] = rgba[from + 3];
    }
  }
  return { width: size, height: size, rgba: out };
}
