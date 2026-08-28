/**
 * The number has to be legible on the blank it is drawn on.
 *
 * Six states declared white numerals on what the table described as a dark
 * marker - Michigan and North Carolina as dark diamonds, Vermont and South
 * Dakota green, South Carolina blue, Nevada black. Each was a fair sketch of
 * that state's sign and each stopped being true when the real blanks arrived:
 * every blank puts the number in a white field, so the numerals rendered white
 * on white and the shield came up empty.
 *
 * It was reported as a generic circle flashing with its number and then the
 * state shield appearing without one, which is precisely that - the base
 * design drawing first, the blank replacing it, and the text surviving both.
 *
 * Nothing about the JavaScript could see this: the colours are valid, the
 * expressions compile, the images register. The only way to know is to open
 * the picture, so that is what this does - decode the PNG and read the box the
 * text is actually placed in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { STATE_SHIELDS } from '../assets/js/lib/route-shields.js';
import { SHIELD_BOXES } from '../assets/js/lib/shield-boxes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIELDS = path.join(HERE, '..', 'assets', 'shields');

/** Decode a PNG far enough to read pixels out of it. */
function decode(file) {
  const data = readFileSync(file);
  let pos = 8;
  let width = 0; let height = 0; let depth = 0; let kind = 0;
  let palette = null; let alpha = null;
  const parts = [];
  while (pos < data.length) {
    const length = data.readUInt32BE(pos);
    const type = data.toString('ascii', pos + 4, pos + 8);
    const body = data.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; kind = body[9];
    } else if (type === 'IDAT') parts.push(body);
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') alpha = body;
    pos += 12 + length;
  }
  if (depth !== 8) return null;

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[kind];
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[at]; at += 1;
    const line = Buffer.from(raw.subarray(at, at + stride)); at += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    line.copy(out, y * stride); prev = line;
  }

  return { width, height, at: (x, y) => {
    const off = y * stride + x * channels;
    if (kind === 6) return [out[off], out[off + 1], out[off + 2], out[off + 3]];
    if (kind === 2) return [out[off], out[off + 1], out[off + 2], 255];
    if (kind === 3) {
      const i = out[off];
      return [palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2], alpha?.[i] ?? 255];
    }
    return [out[off], out[off], out[off], 255];
  } };
}

const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** The typical brightness of the box the number sits in. */
function fieldLuminance(file, box) {
  const png = decode(file);
  if (!png) return null;
  const { width, height, at } = png;
  const cx = width / 2 + box.dx * (width / 30);
  const cy = height / 2 + box.dy * (height / 19);
  // Inside the declared box rather than all of it: the edges of a text box
  // touch the border on the tighter blanks, and a border is not the field.
  const halfW = (box.w * (width / 30)) / 2 * 0.55;
  const halfH = (box.h * (height / 19)) / 2 * 0.5;
  const seen = [];
  for (let y = Math.max(0, Math.round(cy - halfH)); y <= Math.min(height - 1, Math.round(cy + halfH)); y += 1) {
    for (let x = Math.max(0, Math.round(cx - halfW)); x <= Math.min(width - 1, Math.round(cx + halfW)); x += 1) {
      const pixel = at(x, y);
      if (pixel[3] < 200) continue;
      seen.push(luminance(pixel));
    }
  }
  if (!seen.length) return null;
  seen.sort((a, b) => a - b);
  return seen[Math.floor(seen.length / 2)];
}

test('shields: the number is legible on its own blank', () => {
  const files = readdirSync(SHIELDS).filter((name) => name.endsWith('.png'));
  assert.ok(files.length > 40, 'the blanks are missing, so this test proves nothing');

  const checked = [];
  const failures = [];
  for (const file of files) {
    const key = file.replace(/\.png$/, '');
    const code = key.split('-')[0];
    const entry = STATE_SHIELDS[code];
    const box = SHIELD_BOXES[key];
    if (!entry || !box) continue;

    const field = fieldLuminance(path.join(SHIELDS, file), box);
    if (field === null) continue;
    checked.push(code);

    /*
     * WCAG-style contrast would be the rigorous measure; this is the coarse
     * version of the same question, and coarse is enough because every failure
     * so far has been total - white on white, not merely dim.
     */
    const text = luminance([
      parseInt(entry.fg.slice(1, 3), 16),
      parseInt(entry.fg.slice(3, 5), 16),
      parseInt(entry.fg.slice(5, 7), 16),
    ]);
    if (Math.abs(field - text) < 80) {
      failures.push(`${key}: ${entry.fg} on a field of luminance ${Math.round(field)}`);
    }
  }

  assert.ok(checked.length > 40, `only ${checked.length} blanks were actually examined`);
  assert.deepEqual(failures, [], `numbers that would not be readable:\n  ${failures.join('\n  ')}`);
});
