/**
 * Ask a PMTiles archive whether it can actually be used from a browser.
 *
 *   node tools/check-archive.mjs https://tiles.example.com/byways.pmtiles
 *
 * Three things have to be true of whatever hosts the archive, and a host that
 * fails any of them produces a blank map rather than an error: it has to
 * honour Range requests, it has to send CORS headers, and the archive has to
 * be gzipped rather than brotli or zstd. None of those are visible from
 * looking at the file, and all three are cheap to ask about — which is the
 * whole reason this exists rather than a paragraph in the documentation
 * saying to check.
 *
 * It also reads the zoom range out of the header, because
 * ABMAP_PROTOMAPS_MAXZOOM has to be declared before anything is fetched and
 * overstating it draws blank ground.
 *
 * Deliberately not part of `npm test`: it needs a network and a URL, and the
 * suite runs with neither.
 */

import { PMTilesArchive, parseHeader, COMPRESSION, TILE_TYPE } from '../assets/js/lib/pmtiles.js';

const NAMES = {
  compression: ['unknown', 'none', 'gzip', 'brotli', 'zstd'],
  tileType: ['unknown', 'mvt', 'png', 'jpeg', 'webp', 'avif'],
};

const url = process.argv[2];
if (!url) {
  console.error('Usage: node tools/check-archive.mjs <url to a .pmtiles file> [origin]');
  console.error('  e.g. node tools/check-archive.mjs https://tiles.example.com/byways.pmtiles');
  process.exit(2);
}

/*
 * The origin the archive will actually be read from.
 *
 * CORS is not a property of a file, it is a property of a response to a
 * request that carried an `Origin` header, and Node's fetch does not send one.
 * The first version of this check asked for a range with no Origin, read back
 * no `Access-Control-Allow-Origin`, and reported "CORS NONE" — which it would
 * have reported just as confidently against a bucket that was configured
 * perfectly. A check that returns the same answer either way is not a check.
 *
 * So the origin is stated, and every probe below carries it.
 */
const origin = process.argv[3] || process.env.ABMAP_ORIGIN || 'https://shermancahal.github.io';

const problems = [];
const notes = [];

/*
 * The first request is made by hand rather than through the reader, because
 * what is under test here is the response itself — its status, and the headers
 * a browser would enforce. The reader deliberately copes with a host that
 * ignores Range, which is exactly the behaviour this has to report on.
 */
let first;
try {
  first = await fetch(url, { headers: { Range: 'bytes=0-16383', Origin: origin } });
} catch (error) {
  console.error(`Could not reach ${url}`);
  console.error(`  ${error.message}`);
  process.exit(1);
}

console.log(`${url}\n`);
console.log(`  asked as               ${origin}`);
console.log(`  status                 ${first.status} ${first.statusText}`);

if (!first.ok) {
  console.error(`\nThe host answered ${first.status}. Nothing else can be checked.`);
  process.exit(1);
}

if (first.status === 206) {
  console.log(`  range requests         honoured (${first.headers.get('content-range') || 'no content-range header'})`);
} else {
  console.log(`  range requests         IGNORED — answered ${first.status} with the whole file`);
  problems.push(
    'The host ignores Range requests, so reading one tile downloads the entire archive.'
    + ' The app copes with this, but on a phone it is unusable.',
  );
}

const allowed = first.headers.get('access-control-allow-origin');
console.log(`  CORS on the GET        ${allowed || 'NONE'}`);
if (!allowed) {
  problems.push(
    `No Access-Control-Allow-Origin in the answer to a request from ${origin},`
    + ' so a browser will refuse every read and the map will be blank with nothing in the console'
    + ' beyond "Failed to fetch". On R2: the bucket needs a CORS policy naming that origin.',
  );
} else if (allowed !== '*' && allowed !== origin) {
  problems.push(
    `Access-Control-Allow-Origin came back as ${allowed}, which is neither * nor ${origin}.`
    + ' A browser at that origin will refuse the read.',
  );
}
const exposed = (first.headers.get('access-control-expose-headers') || '').toLowerCase();
if (allowed && !exposed.includes('content-range') && !exposed.includes('*')) {
  notes.push(
    'Access-Control-Expose-Headers does not list content-range.'
    + ' Reads still work; the browser simply cannot see how much it got.',
  );
}

/*
 * The preflight, separately — because a Range request is not a simple request.
 *
 * `Range` is not on the CORS safelist, so before the browser sends the GET
 * above it sends an OPTIONS and refuses to proceed unless the answer allows
 * both the method and that header. A bucket can allow the origin and still
 * fail here, by allowing no request headers at all, and the failure is
 * invisible from the GET: curl and Node both get the bytes, and only the
 * browser is stopped. That is exactly the shape of "it works from the
 * terminal and the map is blank".
 */
try {
  const preflight = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'range',
    },
  });
  const preflightOrigin = preflight.headers.get('access-control-allow-origin');
  const preflightHeaders = (preflight.headers.get('access-control-allow-headers') || '').toLowerCase();
  console.log(`  CORS preflight         ${preflight.status} · origin ${preflightOrigin || 'NONE'} · headers ${preflightHeaders || 'NONE'}`);
  if (!preflight.ok || !preflightOrigin) {
    problems.push(
      `The CORS preflight (OPTIONS with Access-Control-Request-Headers: range) answered ${preflight.status}`
      + `${preflightOrigin ? '' : ' with no Access-Control-Allow-Origin'}.`
      + ' A browser stops there and never sends the read, so every tile fails.',
    );
  } else if (!preflightHeaders.includes('range') && !preflightHeaders.includes('*')) {
    problems.push(
      `The preflight allows the origin but not the Range header (it allows: ${preflightHeaders || 'nothing'}).`
      + ' Reading one tile means asking for a byte range, so a browser will refuse every read'
      + ' while curl and this check\'s own GET keep working. Add "range" to the bucket\'s allowed headers.',
    );
  }
} catch (error) {
  console.log(`  CORS preflight         could not be asked — ${error.message}`);
  notes.push(`The OPTIONS preflight could not be sent: ${error.message}`);
}

const bytes = new Uint8Array(await first.arrayBuffer());
let header;
try {
  header = parseHeader(bytes);
} catch (error) {
  console.error(`\n  ${error.message}`);
  process.exit(1);
}

const compression = NAMES.compression[header.tileCompression] || `id ${header.tileCompression}`;
console.log(`  tile compression       ${compression}`);
console.log(`  internal compression   ${NAMES.compression[header.internalCompression] || header.internalCompression}`);
console.log(`  tile type              ${NAMES.tileType[header.tileType] || header.tileType}`);
console.log(`  zoom range             ${header.minZoom} – ${header.maxZoom}`);
console.log(`  bounds                 ${header.bounds.west}, ${header.bounds.south} → ${header.bounds.east}, ${header.bounds.north}`);
console.log(`  tiles                  ${header.addressedTiles.toLocaleString()} addressed, ${header.tileEntries.toLocaleString()} entries`);
console.log(`  clustered              ${header.clustered}`);
console.log(`  leaf directories       ${header.leafDirectoryLength ? `${header.leafDirectoryLength.toLocaleString()} bytes` : 'none'}`);

for (const [what, value] of [['tile', header.tileCompression], ['directory', header.internalCompression]]) {
  if (value !== COMPRESSION.gzip && value !== COMPRESSION.none) {
    problems.push(
      `The ${what} data is ${NAMES.compression[value] || value}-compressed, which no browser can decompress.`
      + ' Rebuild the archive with gzip.',
    );
  }
}
if (header.tileType !== TILE_TYPE.mvt) {
  problems.push(`This archive holds ${NAMES.tileType[header.tileType] || 'unknown'} tiles; Byways Topo needs vector tiles (mvt).`);
}

/*
 * And then actually read a tile, because everything above is the file
 * describing itself. A header can be perfectly well-formed over an archive
 * whose directories do not decompress.
 */
const archive = new PMTilesArchive(url);
const middle = {
  z: header.maxZoom,
  x: Math.floor(((header.bounds.west + header.bounds.east) / 2 + 180) / 360 * 2 ** header.maxZoom),
  y: Math.floor((() => {
    const lat = ((header.bounds.south + header.bounds.north) / 2) * Math.PI / 180;
    return (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * 2 ** header.maxZoom;
  })()),
};
try {
  const tile = await archive.tile(middle.z, middle.x, middle.y);
  if (tile) {
    console.log(`  a tile at its centre   ${tile.length.toLocaleString()} bytes at z${middle.z}/${middle.x}/${middle.y}`);
  } else {
    console.log(`  a tile at its centre   NOT PRESENT at z${middle.z}/${middle.x}/${middle.y}`);
    problems.push(
      `The archive has no tile at the centre of its own declared bounds, at its own maximum zoom.`
      + ' Either the bounds or the zoom range in the header is wrong.',
    );
  }
} catch (error) {
  console.log(`  a tile at its centre   FAILED — ${error.message}`);
  problems.push(`Reading a tile failed: ${error.message}`);
}

console.log('');
if (notes.length) {
  console.log('Worth knowing:');
  for (const note of notes) console.log(`  · ${note}`);
  console.log('');
}

console.log(`Set these in assets/js/token.js, or as repository variables:

  window.ABMAP_PROTOMAPS_ARCHIVE = '${url}';
  window.ABMAP_PROTOMAPS_MAXZOOM = '${header.maxZoom}';
`);

if (problems.length) {
  console.error(`${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}
console.log('This archive can be used from a browser.');
