import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

import {
  parsePathCommands, flattenPath, dashPolyline, parseColor,
  createCanvas, canvasToRGBA, encodePNG, fillRect, fillCircle, strokePolylines,
} from '../tools/raster.mjs';
import { readMark, renderMark, markBounds, ICONS } from '../tools/build-app-icons.mjs';

/** Decode our own PNG far enough to read pixels back. Filter 0 only, which is all we write. */
function decodePNG(buffer) {
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colour: body[9] };
    } else if (type === 'IDAT') idat.push(body);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = header.width * 4;
  const pixels = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y += 1) {
    assert.equal(raw[y * (stride + 1)], 0, 'only filter 0 is written');
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { ...header, pixels, at(x, y) { const i = (y * header.width + x) * 4; return [...pixels.subarray(i, i + 4)]; } };
}

test('a repeated coordinate pair after a moveto is an implicit lineto', () => {
  // The alternative reading — a second moveto — draws nothing and looks the
  // same as a missing shape, so this is worth pinning.
  const steps = parsePathCommands('M0 0 5 5 10 0');
  assert.deepEqual(steps.map((s) => s.command), ['M', 'L', 'L']);
});

test('flattening ends exactly on the path endpoint', () => {
  const d = 'M9.5 26c0-4.6 4.2-5.4 7-7 2.8-1.6 3.4-3 1.4-4.6-2-1.6-6-1.3-6-4.4C11.9 7.4 14.6 6 18 6';
  const [sub] = flattenPath(d);
  assert.deepEqual(sub.points[0], [9.5, 26]);
  const [ex, ey] = sub.points.at(-1);
  assert.ok(Math.hypot(ex - 18, ey - 6) < 1e-9, `ends at ${ex},${ey}`);
});

test('relative and absolute cubics describe the same curve', () => {
  const absolute = flattenPath('M0 0 C 10 0 10 10 20 10')[0].points;
  const relative = flattenPath('M0 0 c 10 0 10 10 20 10')[0].points;
  assert.deepEqual(relative, absolute);
});

test('an unsupported command throws rather than being skipped', () => {
  // Arcs are the likely one. Dropping a shape silently would ship a broken icon.
  assert.throws(() => flattenPath('M0 0 A 5 5 0 0 1 10 10'), /unsupported path command "A"/);
});

test('dashes cut a line into the number of marks the pattern implies', () => {
  const runs = dashPolyline([[0, 0], [10, 0]], [1, 1]);
  assert.equal(runs.length, 5);
  assert.deepEqual(runs[0], [[0, 0], [1, 0]]);
  assert.deepEqual(runs[1], [[2, 0], [3, 0]]);
});

test('a zero-length dash survives as a single point, so round caps can make it a dot', () => {
  // The mark draws its route as dots this way: stroke-dasharray="0.1 5.2".
  // Collapsing an empty run would erase every waypoint on the icon.
  const runs = dashPolyline([[0, 0], [20, 0]], [0.001, 4]);
  assert.ok(runs.length >= 4);
  for (const run of runs) assert.ok(run.length >= 1);
  assert.ok(runs.every((run) => Math.hypot(run.at(-1)[0] - run[0][0], run.at(-1)[1] - run[0][1]) < 0.01));
});

test('an odd-length dash pattern repeats to an even one', () => {
  // SVG says [3] means 3 on, 3 off. Reading it as [3] alone would draw solid.
  assert.deepEqual(dashPolyline([[0, 0], [12, 0]], [3]), dashPolyline([[0, 0], [12, 0]], [3, 3]));
});

test('colours parse from #rgb and #rrggbb, and anything else is refused', () => {
  assert.deepEqual(parseColor('#b4441f'), [180, 68, 31]);
  assert.deepEqual(parseColor('#fff'), [255, 255, 255]);
  assert.throws(() => parseColor('rebeccapurple'), /unsupported colour/);
});

test('a filled rect covers its interior fully and leaves the outside transparent', () => {
  const canvas = createCanvas(20, 20);
  fillRect(canvas, { x: 5, y: 5, width: 10, height: 10 }, [10, 20, 30], 1, 4);
  const rgba = canvasToRGBA(canvas);
  const at = (x, y) => [...rgba.subarray((y * 20 + x) * 4, (y * 20 + x) * 4 + 4)];
  assert.deepEqual(at(10, 10), [10, 20, 30, 255]);
  assert.deepEqual(at(1, 1), [0, 0, 0, 0]);
});

test('a rounded rect clears its corners but keeps its edges', () => {
  const canvas = createCanvas(40, 40);
  fillRect(canvas, { x: 0, y: 0, width: 40, height: 40, rx: 12, ry: 12 }, [255, 255, 255], 1, 4);
  const alpha = (x, y) => canvasToRGBA(canvas)[(y * 40 + x) * 4 + 3];
  assert.equal(alpha(0, 0), 0, 'the extreme corner is outside the radius');
  assert.equal(alpha(20, 0), 255, 'the middle of the top edge is inside');
  assert.equal(alpha(20, 20), 255);
});

test('a stroke does not darken itself where segments meet', () => {
  // Compositing per segment instead of accumulating coverage first draws a
  // bead of double-blended colour along every joint. At full opacity over an
  // empty canvas the two look identical, so this checks a half-opacity stroke
  // where the error is visible: the shared joint must match the straight run.
  const canvas = createCanvas(30, 30);
  strokePolylines(canvas, [[[5, 15], [15, 15], [25, 15]]], 6, [0, 0, 0], 0.5, 4);
  const rgba = canvasToRGBA(canvas);
  const alpha = (x, y) => rgba[(y * 30 + x) * 4 + 3];
  assert.equal(alpha(15, 15), alpha(9, 15), 'the joint is no more opaque than the run');
});

test('the PNG we write decodes back to the pixels we drew', () => {
  const canvas = createCanvas(8, 8);
  fillCircle(canvas, { cx: 4, cy: 4, r: 3 }, [200, 100, 50], 1, 4);
  const png = encodePNG(8, 8, canvasToRGBA(canvas));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const decoded = decodePNG(png);
  assert.equal(decoded.width, 8);
  assert.equal(decoded.colour, 6, 'truecolour with alpha');
  assert.deepEqual(decoded.at(4, 4), [200, 100, 50, 255]);
  assert.equal(decoded.at(0, 0)[3], 0);
});

test('the committed icons are what mark.svg renders to', async () => {
  // Generated files drift the moment the thing they are generated from changes,
  // and nobody opens an icon again after the first look.
  const mark = readMark(await readFile(new URL('../assets/img/mark.svg', import.meta.url), 'utf8'));
  for (const icon of ICONS) {
    const png = encodePNG(icon.size, icon.size, canvasToRGBA(renderMark(mark, icon)));
    const committed = await readFile(new URL(`../assets/img/${icon.file}`, import.meta.url));
    assert.ok(committed.equals(png), `${icon.file} differs — run: node tools/build-app-icons.mjs`);
  }
});

test('maskable artwork stays inside Android\'s safe zone', async () => {
  // Android crops a maskable icon to the launcher's shape — a circle on most.
  // Anything outside the middle 80% by width can be cut off, so the glyph is
  // checked against that circle rather than against the square.
  const mark = readMark(await readFile(new URL('../assets/img/mark.svg', import.meta.url), 'utf8'));
  const spec = ICONS.find((icon) => icon.file === 'icon-maskable-512.png');
  const size = spec.size;
  const decoded = decodePNG(encodePNG(size, size, canvasToRGBA(renderMark(mark, spec))));

  const plate = decoded.at(2, 2);
  assert.deepEqual(plate.slice(0, 3), [180, 68, 31], 'the plate reaches the edge');
  assert.equal(plate[3], 255, 'maskable icons must be fully opaque');

  const safe = size * 0.4; // radius of the middle 80%
  let outside = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = decoded.at(x, y);
      const isPlate = Math.abs(r - 180) < 12 && Math.abs(g - 68) < 12 && Math.abs(b - 31) < 12;
      if (!isPlate && Math.hypot(x - size / 2, y - size / 2) > safe) outside += 1;
    }
  }
  assert.equal(outside, 0, `${outside} artwork pixels fall outside the safe circle`);
});

test('the artwork bounds exclude the background plate', async () => {
  const mark = readMark(await readFile(new URL('../assets/img/mark.svg', import.meta.url), 'utf8'));
  const bounds = markBounds(mark.shapes.slice(1));
  assert.ok(bounds.minX > 0 && bounds.maxX < 32, `${bounds.minX}..${bounds.maxX} should sit inside the viewBox`);
  assert.ok(bounds.width < 32 && bounds.height < 32);
});
