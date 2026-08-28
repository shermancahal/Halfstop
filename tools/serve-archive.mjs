/**
 * Serve a synthetic PMTiles archive over real HTTP, for checking the reader
 * end to end without a network.
 *
 *   node tools/serve-archive.mjs            # serves on 8788
 *   node tools/serve-archive.mjs --port 9000 --ignore-range
 *
 * Everything else that exercises the reader hands it a stub `fetch`, which is
 * the right shape for a unit test and cannot see the things that actually go
 * wrong with a hosted archive: a `Range` header that has to be parsed, a 206
 * with a `Content-Range`, a host that answers 200 with the whole file, CORS
 * headers a browser would enforce. This serves an archive over a real socket
 * so `tools/check-archive.mjs` can be run against something and be seen to
 * work before it is pointed at a bucket that costs money.
 *
 * `--ignore-range` makes it behave like a host that does not support ranges,
 * which is one of the three failure modes the checker exists to report.
 */

import { createServer } from 'node:http';
import { buildArchive } from '../test/helpers/pmtiles-writer.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const port = Number(value('port', 8788));
const ignoreRange = flag('ignore-range');
const noCors = flag('no-cors');

/*
 * A few hundred tiles over east Tennessee, deep enough to need a leaf
 * directory — which is the shape a real archive has and the code path a
 * three-tile fixture never reaches.
 */
const tiles = new Map();
for (let z = 6; z <= 12; z += 1) {
  const scale = 2 ** (z - 6);
  for (let x = 17 * scale; x < 17 * scale + Math.min(6, scale * 2); x += 1) {
    for (let y = 25 * scale; y < 25 * scale + Math.min(6, scale * 2); y += 1) {
      tiles.set(`${z}/${x}/${y}`, new TextEncoder().encode(`tile ${z}/${x}/${y}`.padEnd(64, ' ')));
    }
  }
}
/*
 * Bounds computed from the tiles rather than written down beside them.
 *
 * The first version declared a box the tiles did not fill, and check-archive
 * caught it — it asks the archive for a tile at the centre of its own declared
 * bounds, at its own maximum zoom, which is the cheapest way to find a header
 * that describes a different file from the one it is attached to. A fixture
 * that fails the check it exists to demonstrate is worse than no fixture.
 */
const corners = [...tiles.keys()].map((key) => key.split('/').map(Number)).filter(([z]) => z === 12);
const span = 2 ** 12;
const lon = (x) => (x / span) * 360 - 180;
const lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / span))) * 180) / Math.PI;
const xs = corners.map(([, x]) => x);
const ys = corners.map(([, , y]) => y);
const bounds = {
  west: lon(Math.min(...xs)),
  east: lon(Math.max(...xs) + 1),
  north: lat(Math.min(...ys)),
  south: lat(Math.max(...ys) + 1),
};

const archive = buildArchive(tiles, {
  leaves: true, bounds, metadata: { name: 'Byways (synthetic)' },
});

const server = createServer((request, response) => {
  const headers = {
    'content-type': 'application/octet-stream',
    'accept-ranges': 'bytes',
  };
  if (!noCors) {
    headers['access-control-allow-origin'] = '*';
    headers['access-control-expose-headers'] = 'content-range, content-length';
  }

  const range = ignoreRange ? null : /bytes=(\d+)-(\d+)?/.exec(request.headers.range || '');
  if (!range) {
    response.writeHead(200, { ...headers, 'content-length': archive.length });
    response.end(Buffer.from(archive));
    return;
  }

  const start = Number(range[1]);
  // The end is a clamp, not a promise: a request for the first 16kB of a 9kB
  // file is answered with the 9kB, which is exactly the case that broke the
  // reader the first time.
  const end = Math.min(range[2] ? Number(range[2]) : archive.length - 1, archive.length - 1);
  if (start >= archive.length) {
    response.writeHead(416, { ...headers, 'content-range': `bytes */${archive.length}` });
    response.end();
    return;
  }
  const slice = archive.subarray(start, end + 1);
  response.writeHead(206, {
    ...headers,
    'content-range': `bytes ${start}-${end}/${archive.length}`,
    'content-length': slice.length,
  });
  response.end(Buffer.from(slice));
});

server.listen(port, () => {
  console.log(`${(archive.length / 1024).toFixed(1)} kB archive, ${tiles.size} tiles, z6–12`);
  console.log(`  covering ${bounds.west.toFixed(3)}, ${bounds.south.toFixed(3)} → ${bounds.east.toFixed(3)}, ${bounds.north.toFixed(3)}`);
  console.log(`  http://127.0.0.1:${port}/byways.pmtiles`);
  if (ignoreRange) console.log('  (answering every request with the whole file)');
  if (noCors) console.log('  (sending no CORS headers)');
  console.log(`\nCheck it with:\n  node tools/check-archive.mjs http://127.0.0.1:${port}/byways.pmtiles`);
});
