/**
 * Put MapLibre GL in the repository, at the version the engine asks for.
 *
 * The library used to be fetched from unpkg at runtime, which had three costs
 * that only showed up in the places this app is meant to work:
 *
 *   - The service worker could not cache it. It is cross-origin, and the
 *     worker deliberately touches nothing cross-origin but downloaded tiles,
 *     so a first load with no signal had no map library and drew no map. Only
 *     the browser's own HTTP cache stood between the field app and a blank
 *     screen, and that is evictable.
 *   - It sat on the critical path behind a cold DNS lookup, TCP connection and
 *     TLS handshake to a host the page had no other reason to talk to.
 *   - unpkg could serve any code it liked into the app, under our origin's
 *     users. Pinning a version narrows that; it does not close it.
 *
 * So the file lives here instead, fetched once from the npm registry - which
 * is where unpkg gets it - and committed. `npm start` on a fresh clone then
 * draws a map with no build step and no network, which is the property that
 * made this a static site in the first place.
 *
 * Mapbox GL is deliberately NOT vendored. It is proprietary, its terms require
 * it to be served by Mapbox, and it only loads at all for somebody who has
 * configured a token and accepted those terms.
 *
 *     node tools/vendor-maplibre.mjs [version]
 *
 * With no argument it reads the version out of engine.js, so the default is
 * always "make the tree match what the code asks for".
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The version the app will actually ask for, so the tree cannot drift from it. */
async function versionFromEngine() {
  const source = await readFile(path.join(ROOT, 'assets/js/lib/engine.js'), 'utf8');
  const match = /const MAPLIBRE_VERSION = '([^']+)'/.exec(source);
  if (!match) throw new Error('engine.js no longer declares MAPLIBRE_VERSION');
  return match[1];
}

// dist/ carries a dozen builds; these three are the ones the page loads plus
// the licence that has to travel with them.
const WANTED = [
  ['package/dist/maplibre-gl.js', 'maplibre-gl.js'],
  ['package/dist/maplibre-gl.css', 'maplibre-gl.css'],
  ['package/LICENSE.txt', 'LICENSE.txt'],
];

async function main() {
  const version = process.argv[2] || await versionFromEngine();
  const target = path.join(ROOT, 'assets/vendor', `maplibre-gl-${version}`);
  const work = await mkdtemp(path.join(tmpdir(), 'vendor-maplibre-'));

  try {
    console.log(`Fetching maplibre-gl@${version} from the npm registry…`);
    const { stdout } = await run('npm', ['pack', `maplibre-gl@${version}`, '--silent'], { cwd: work });
    const tarball = stdout.trim().split('\n').pop().trim();

    await run('tar', ['xzf', tarball, ...WANTED.map(([inside]) => inside)], { cwd: work });

    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    for (const [inside, name] of WANTED) {
      const data = await readFile(path.join(work, inside));
      await writeFile(path.join(target, name), data);
      console.log(`  ${name.padEnd(18)} ${data.length.toLocaleString()} bytes`);
    }

    /*
     * Every other version goes, because two of them on disk is two of them
     * deployed and precached - a megabyte of dead weight in the offline cache
     * of an app whose whole point is working without a signal.
     */
    const vendor = path.join(ROOT, 'assets/vendor');
    for (const entry of await readdir(vendor, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === `maplibre-gl-${version}`) continue;
      if (!entry.name.startsWith('maplibre-gl-')) continue;
      await rm(path.join(vendor, entry.name), { recursive: true, force: true });
      console.log(`  removed the previous copy: ${entry.name}`);
    }

    console.log(`\nVendored to assets/vendor/maplibre-gl-${version}/`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
