/**
 * Put supabase-js in the repository, at the version account.js asks for.
 *
 * The library used to be fetched from jsdelivr at runtime, for the same three
 * reasons MapLibre used to come from unpkg, and one more that only matters
 * once this is wrapped as an app:
 *
 *   - The service worker could not cache it. It is cross-origin, and the
 *     worker deliberately touches nothing cross-origin but downloaded tiles,
 *     so signing in needed the network even where nothing else did.
 *   - It sat behind a cold DNS lookup, TCP connection and TLS handshake to a
 *     host the page had no other reason to talk to.
 *   - jsdelivr could serve any code it liked into the app, under our origin's
 *     users and holding their session. Pinning a version narrows that; it does
 *     not close it.
 *   - Inside a native shell it is executable code downloaded at runtime that
 *     Apple never reviewed, which App Store review takes a dim view of.
 *
 * So the file lives here instead, fetched once from the npm registry - which
 * is where jsdelivr gets it - and committed.
 *
 * Only dist/umd/supabase.js is taken. The package also ships a 223-byte
 * companion chunk, which is a stub that throws for the Node `ws` module; the
 * browser bundle contains no chunk loading at all and never asks for it.
 *
 *     node tools/vendor-supabase.mjs [version]
 *
 * With no argument it reads the version out of account.js, so the default is
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
async function versionFromAccount() {
  const source = await readFile(path.join(ROOT, 'assets/js/lib/account.js'), 'utf8');
  const match = /const SUPABASE_VERSION = '([^']+)'/.exec(source);
  if (!match) throw new Error('account.js no longer declares SUPABASE_VERSION');
  return match[1];
}

const WANTED = [
  ['package/dist/umd/supabase.js', 'supabase.js'],
  ['package/LICENSE', 'LICENSE'],
];

async function main() {
  const version = process.argv[2] || await versionFromAccount();
  const target = path.join(ROOT, 'assets/vendor', `supabase-js-${version}`);
  const work = await mkdtemp(path.join(tmpdir(), 'vendor-supabase-'));

  try {
    console.log(`Fetching @supabase/supabase-js@${version} from the npm registry…`);
    const { stdout } = await run('npm', ['pack', `@supabase/supabase-js@${version}`, '--silent'], { cwd: work });
    const tarball = stdout.trim().split('\n').pop().trim();

    await run('tar', ['xzf', tarball, ...WANTED.map(([inside]) => inside)], { cwd: work });

    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    for (const [inside, name] of WANTED) {
      const data = await readFile(path.join(work, inside));
      await writeFile(path.join(target, name), data);
      console.log(`  ${name.padEnd(14)} ${data.length.toLocaleString()} bytes`);
    }

    // Every other version goes, for the same reason MapLibre's do: two copies
    // on disk is two copies deployed and precached, in an app whose whole
    // point is working without a signal.
    const vendor = path.join(ROOT, 'assets/vendor');
    for (const entry of await readdir(vendor, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === `supabase-js-${version}`) continue;
      if (!entry.name.startsWith('supabase-js-')) continue;
      await rm(path.join(vendor, entry.name), { recursive: true, force: true });
      console.log(`  removed the previous copy: ${entry.name}`);
    }

    console.log(`\nVendored to assets/vendor/supabase-js-${version}/`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
