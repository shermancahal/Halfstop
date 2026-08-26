/**
 * A very small SVG-subset rasteriser, and a PNG encoder to go with it.
 *
 * It exists because the app needs real PNG icons — a web manifest will take an
 * SVG, but `apple-touch-icon` will not, and Capacitor's icon generator wants a
 * 1024px bitmap — and this project installs nothing to build itself. Pulling in
 * sharp or resvg for five files would mean the icons could only be regenerated
 * on a machine with a working toolchain, which is exactly the kind of step that
 * rots.
 *
 * The subset is deliberately tiny: filled rects (with rounded corners), filled
 * circles, and stroked/filled paths with M L H V C S Q T Z, dashes and round
 * caps. That is what assets/img/mark.svg uses. Anything else throws rather than
 * being silently skipped — an icon that renders with a piece missing looks like
 * a design decision, and nobody would catch it.
 */

import { deflateSync } from 'node:zlib';

/* ------------------------------------------------------------------ paths -- */

const NUMBER = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;

/** Split a `d` attribute into `{ command, args }` steps. */
export function parsePathCommands(d) {
  const steps = [];
  const tokens = String(d).match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
  let i = 0;
  const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, Z: 0 };
  let command = null;
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) command = tokens[i++];
    else if (!command) throw new Error(`path data starts with a number: ${d}`);
    // A repeated coordinate set continues the previous command, except that a
    // repeated moveto is an implicit lineto. Getting this wrong draws a stray
    // line across the icon, which is at least visible.
    else if (command === 'M') command = 'L';
    else if (command === 'm') command = 'l';

    const key = command.toUpperCase();
    const arity = ARITY[key];
    if (arity === undefined) throw new Error(`unsupported path command "${command}"`);
    const args = tokens.slice(i, i + arity).map(Number);
    if (args.length < arity) throw new Error(`path command "${command}" wants ${arity} numbers`);
    i += arity;
    steps.push({ command, args });
  }
  return steps;
}

const cubicAt = (t, a, b, c, d) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};

/**
 * Flatten a path to polylines. `segments` is the fixed subdivision count per
 * curve — 32 is smooth well past 1024px for a mark this size, and a fixed count
 * keeps the output identical from run to run.
 */
export function flattenPath(d, { segments = 32 } = {}) {
  const subpaths = [];
  let current = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // Reflection points for the shorthand S and T commands.
  let lastCubic = null;
  let lastQuad = null;

  const open = () => {
    current = { points: [[x, y]], closed: false };
    subpaths.push(current);
  };
  const lineTo = (nx, ny) => {
    if (!current) open();
    current.points.push([nx, ny]);
    x = nx; y = ny;
  };
  const curveTo = (x1, y1, x2, y2, nx, ny) => {
    if (!current) open();
    for (let s = 1; s <= segments; s += 1) {
      const t = s / segments;
      current.points.push([cubicAt(t, x, x1, x2, nx), cubicAt(t, y, y1, y2, ny)]);
    }
    x = nx; y = ny;
  };

  for (const { command, args } of parsePathCommands(d)) {
    const rel = command === command.toLowerCase();
    const key = command.toUpperCase();
    const ax = rel ? x : 0;
    const ay = rel ? y : 0;

    if (key !== 'C' && key !== 'S') lastCubic = null;
    if (key !== 'Q' && key !== 'T') lastQuad = null;

    if (key === 'M') {
      x = args[0] + ax; y = args[1] + ay;
      startX = x; startY = y;
      open();
    } else if (key === 'L') {
      lineTo(args[0] + ax, args[1] + ay);
    } else if (key === 'H') {
      lineTo(args[0] + ax, y);
    } else if (key === 'V') {
      lineTo(x, args[0] + ay);
    } else if (key === 'C') {
      const [x1, y1, x2, y2, nx, ny] = [args[0] + ax, args[1] + ay, args[2] + ax, args[3] + ay, args[4] + ax, args[5] + ay];
      curveTo(x1, y1, x2, y2, nx, ny);
      lastCubic = [x2, y2];
    } else if (key === 'S') {
      const [rx, ry] = lastCubic ? [2 * x - lastCubic[0], 2 * y - lastCubic[1]] : [x, y];
      const [x2, y2, nx, ny] = [args[0] + ax, args[1] + ay, args[2] + ax, args[3] + ay];
      curveTo(rx, ry, x2, y2, nx, ny);
      lastCubic = [x2, y2];
    } else if (key === 'Q' || key === 'T') {
      let cx; let cy; let nx; let ny;
      if (key === 'Q') {
        [cx, cy, nx, ny] = [args[0] + ax, args[1] + ay, args[2] + ax, args[3] + ay];
      } else {
        [cx, cy] = lastQuad ? [2 * x - lastQuad[0], 2 * y - lastQuad[1]] : [x, y];
        [nx, ny] = [args[0] + ax, args[1] + ay];
      }
      // A quadratic is a cubic with the control points at two thirds.
      curveTo(x + (2 / 3) * (cx - x), y + (2 / 3) * (cy - y),
              nx + (2 / 3) * (cx - nx), ny + (2 / 3) * (cy - ny), nx, ny);
      lastQuad = [cx, cy];
    } else if (key === 'Z') {
      if (current) {
        current.points.push([startX, startY]);
        current.closed = true;
        current = null;
      }
      x = startX; y = startY;
    }
  }
  return subpaths.filter((sub) => sub.points.length > 1 || sub.closed);
}

/** Cut polylines into dashes. `pattern` is an SVG stroke-dasharray, in user units. */
export function dashPolyline(points, pattern) {
  if (!pattern || !pattern.length) return [points];
  const lengths = pattern.length % 2 ? [...pattern, ...pattern] : [...pattern];
  const total = lengths.reduce((sum, n) => sum + n, 0);
  if (!(total > 0)) return [points];

  const out = [];
  let index = 0;
  let left = lengths[0];
  let on = true;
  let run = on ? [points[0]] : null;
  // The nominal length of the dash the open run belongs to. A run that ends up
  // a single point is a dot when the pattern asked for a zero-length dash, and
  // a phantom when the path merely ran out on a dash boundary; SVG draws the
  // first and not the second, and they are indistinguishable after the fact.
  let nominal = lengths[0];

  for (let i = 1; i < points.length; i += 1) {
    let [px, py] = points[i - 1];
    const [qx, qy] = points[i];
    let remaining = Math.hypot(qx - px, qy - py);
    while (remaining > 1e-12) {
      // A zero-length dash is a dot once round caps are applied, so it has to
      // survive as a one-point run rather than being collapsed away.
      const step = Math.min(left, remaining);
      const t = step / remaining;
      const nx = px + (qx - px) * t;
      const ny = py + (qy - py) * t;
      if (on) run.push([nx, ny]);
      remaining -= step;
      left -= step;
      px = nx; py = ny;
      if (left <= 1e-12) {
        do {
          if (on && run) out.push(run);
          on = !on;
          index = (index + 1) % lengths.length;
          left = lengths[index];
          nominal = left;
          run = on ? [[px, py]] : null;
        } while (left <= 1e-12);
      }
    }
  }
  if (on && run && (run.length > 1 || nominal <= 1e-9)) out.push(run);
  return out;
}

/* ------------------------------------------------------------- rasterising -- */

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

export function parseColor(value) {
  const text = String(value || '').trim();
  const hex = text.replace('#', '');
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return [...hex].map((c) => parseInt(c + c, 16));
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }
  throw new Error(`unsupported colour "${value}" — use #rgb or #rrggbb`);
}

/** An RGBA canvas with straight (non-premultiplied) 0..1 channels. */
export function createCanvas(width, height) {
  return { width, height, data: new Float32Array(width * height * 4) };
}

/**
 * Blend one coverage mask over the canvas.
 *
 * Coverage is accumulated per shape and composited once, rather than blended
 * per sample: a stroke overlaps itself at every joint, and blending twice at
 * partial coverage draws a visible dark bead along the inside of every corner.
 */
function composite(canvas, coverage, [r, g, b], opacity) {
  const { data } = canvas;
  for (let i = 0; i < coverage.length; i += 1) {
    const a = coverage[i] * opacity;
    if (a <= 0) continue;
    const o = i * 4;
    const inv = 1 - a;
    const outA = a + data[o + 3] * inv;
    if (outA <= 0) continue;
    data[o] = (r / 255 * a + data[o] * data[o + 3] * inv) / outA;
    data[o + 1] = (g / 255 * a + data[o + 1] * data[o + 3] * inv) / outA;
    data[o + 2] = (b / 255 * a + data[o + 2] * data[o + 3] * inv) / outA;
    data[o + 3] = outA;
  }
}

/**
 * Sample a shape over its bounding box only.
 *
 * `inside(x, y)` is called at `samples²` points per pixel. Restricting the loop
 * to the shape's own box is what keeps a 1024px icon to a couple of seconds
 * instead of a couple of minutes: a dashed stroke is thousands of tiny shapes,
 * and each one only touches a handful of pixels.
 */
function paint(canvas, box, inside, color, opacity, samples) {
  const x0 = Math.max(0, Math.floor(box[0]));
  const y0 = Math.max(0, Math.floor(box[1]));
  const x1 = Math.min(canvas.width, Math.ceil(box[2]));
  const y1 = Math.min(canvas.height, Math.ceil(box[3]));
  if (x1 <= x0 || y1 <= y0) return null;

  const coverage = new Float32Array(canvas.width * canvas.height);
  const step = 1 / samples;
  const offset = step / 2;
  const per = 1 / (samples * samples);
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        const y = py + offset + sy * step;
        for (let sx = 0; sx < samples; sx += 1) {
          if (inside(px + offset + sx * step, y)) hits += 1;
        }
      }
      if (hits) coverage[py * canvas.width + px] = hits * per;
    }
  }
  if (color) composite(canvas, coverage, color, opacity);
  return coverage;
}

/** Distance from a point to a segment; a degenerate segment is a point. */
function segmentDistance(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = 0;
  if (len > 1e-18) t = clamp01(((x - ax) * dx + (y - ay) * dy) / len);
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
}

export function fillRect(canvas, { x, y, width, height, rx = 0, ry = rx }, color, opacity = 1, samples = 4) {
  const a = Math.min(rx, width / 2);
  const b = Math.min(ry === undefined ? rx : ry, height / 2);
  const inside = (px, py) => {
    if (px < x || px > x + width || py < y || py > y + height) return false;
    if (a <= 0 || b <= 0) return true;
    // Only the four corner boxes can be outside a rounded rectangle.
    const cx = px < x + a ? x + a : px > x + width - a ? x + width - a : px;
    const cy = py < y + b ? y + b : py > y + height - b ? y + height - b : py;
    if (cx === px && cy === py) return true;
    const u = (px - cx) / a;
    const v = (py - cy) / b;
    return u * u + v * v <= 1;
  };
  paint(canvas, [x, y, x + width, y + height], inside, color, opacity, samples);
}

export function fillCircle(canvas, { cx, cy, r }, color, opacity = 1, samples = 4) {
  const inside = (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
  paint(canvas, [cx - r, cy - r, cx + r, cy + r], inside, color, opacity, samples);
}

/**
 * Stroke polylines with round caps and joins.
 *
 * Round joins are not a stylistic choice here — they fall out of measuring the
 * distance to the nearest segment, which is also the cheapest thing to compute.
 * The mark asks for round caps anyway.
 */
export function strokePolylines(canvas, runs, width, color, opacity = 1, samples = 4) {
  const half = width / 2;
  const coverage = new Float32Array(canvas.width * canvas.height);
  for (const points of runs) {
    if (!points.length) continue;
    const segments = points.length > 1
      ? points.slice(1).map((p, i) => [points[i][0], points[i][1], p[0], p[1]])
      : [[points[0][0], points[0][1], points[0][0], points[0][1]]];
    for (const [ax, ay, bx, by] of segments) {
      const box = [
        Math.min(ax, bx) - half, Math.min(ay, by) - half,
        Math.max(ax, bx) + half, Math.max(ay, by) + half,
      ];
      const mask = paint(canvas, box, (px, py) => segmentDistance(px, py, ax, ay, bx, by) <= half, null, 1, samples);
      if (!mask) continue;
      // Max, not sum: neighbouring segments share their joint.
      for (let i = 0; i < mask.length; i += 1) {
        if (mask[i] > coverage[i]) coverage[i] = mask[i];
      }
    }
  }
  composite(canvas, coverage, color, opacity);
}

export function canvasToRGBA(canvas) {
  const out = new Uint8Array(canvas.width * canvas.height * 4);
  for (let i = 0; i < out.length; i += 4) {
    const a = clamp01(canvas.data[i + 3]);
    out[i] = Math.round(clamp01(canvas.data[i]) * 255);
    out[i + 1] = Math.round(clamp01(canvas.data[i + 1]) * 255);
    out[i + 2] = Math.round(clamp01(canvas.data[i + 2]) * 255);
    out[i + 3] = Math.round(a * 255);
  }
  return out;
}

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
