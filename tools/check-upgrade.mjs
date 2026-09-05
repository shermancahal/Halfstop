/**
 * Does a deploy strand a returning reader on half of the previous build?
 *
 *   node tools/check-upgrade.mjs
 *
 * The failure this exists for, reported from a phone: after a deploy the app
 * showed its chrome and nothing else. No map, no basemap list, no layers - the
 * static headings and empty space under them.
 *
 * The mechanism is the service worker's caching strategy meeting the way ES
 * modules are addressed. Only the files a page *names* get a `?v=` stamp: the
 * stylesheet and the entry script. Everything the entry script imports is
 * requested by its path on disk, unstamped, and unstamped assets are served
 * cache-first. So after a deploy, while the old worker is still in control:
 *
 *   map.html            network-first  -> new
 *   viewer.js?v=NEW     not in the old cache under that URL -> new
 *   lib/engine.js       cache-first, hit in the OLD cache   -> OLD
 *
 * A new viewer.js importing a name a stale engine.js does not export is a
 * module link error. Nothing in the graph evaluates, nothing is caught, and the
 * page renders exactly as much as the HTML alone describes.
 *
 * This builds the site, loads it until a worker is activated, changes one
 * imported module the way a deploy would, rebuilds, reloads, and asks the page
 * whether it can see the change. Nothing about the map is involved - the map
 * library is never even loaded - because the question is only whether the
 * module graph is coherent.
 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const ENGINE = path.join(ROOT, 'assets', 'js', 'lib', 'engine.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const build = () => execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-dist.mjs')], { stdio: 'ignore' });

let failures = 0;
function check(what, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${ok ? '' : `  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`}`);
}

/*
 * The subpath GitHub Pages serves this repository from, which is the
 * repository's own name. Written once: the prefix and the number of characters
 * to strip off it used to be two separate literals, so renaming the repository
 * would have left every asset served from the wrong place with nothing saying
 * so.
 */
const SUBPATH = '/Halfstop/';

build();
const server = createServer(async (request, response) => {
  let name = decodeURIComponent(new URL(request.url, 'http://x').pathname);
  name = name.startsWith(SUBPATH) ? name.slice(SUBPATH.length) : name.replace(/^\//, '');
  if (name === '' || name.endsWith('/')) name += 'index.html';
  const file = path.join(DIST, name);
  if (!file.startsWith(DIST)) return response.writeHead(403).end();
  try {
    const body = await readFile(file);
    // no-store, so nothing here is the HTTP cache doing the service worker's
    // job for it and hiding the thing under test.
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    }).end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const SITE = `http://127.0.0.1:${server.address().port}${SUBPATH}`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext();
/*
 * Everything third-party is refused rather than reached for: a check that
 * depends on a network it does not need is a check that fails for reasons that
 * are not its subject.
 *
 * The map library is no longer among the refused - it is served from this
 * origin now - so this check exercises a page that really can finish starting
 * up, which is closer to what it was always trying to ask about.
 */
await context.route('**/*', (route) => (
  route.request().url().startsWith(new URL(SITE).origin)
    ? route.continue()
    : route.fulfill({ status: 200, contentType: 'text/javascript', body: '' })
));

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error.message || error)));

const workerState = () => page.evaluate(async () => {
  const registration = await navigator.serviceWorker.getRegistration();
  return registration?.active?.state || 'none';
});

/** Ask the page itself what it gets when it imports the module. */
const canaryVisible = () => page.evaluate(async () => {
  try {
    const module = await import('./assets/js/lib/engine.js');
    return Boolean(module.UPGRADE_CANARY);
  } catch (error) {
    return `threw: ${error.message}`;
  }
});

/*
 * The homepage, not the map.
 *
 * The map page cannot finish initialising without the GL library, which is
 * refused above - and the worker is registered from the end of that init, so
 * the check would report "no worker" and point at the wrong thing entirely.
 * The homepage needs nothing third-party, and the worker precaches every asset
 * on install regardless of which page installed it, so lib/engine.js is in the
 * cache either way. That is the file under test.
 */
console.log(`\nBuild A — a reader arrives and the worker installs\n  ${SITE}`);
await page.goto(SITE, { waitUntil: 'load' });
for (let i = 0; i < 60 && await workerState() !== 'activated'; i += 1) {
  await page.waitForTimeout(100);
}
check('a worker is activated', await workerState(), 'activated');
check('and the module has no canary yet', await canaryVisible(), false);

console.log('\nBuild B — one imported module changes, as a deploy changes it');
const original = await readFile(ENGINE, 'utf8');
try {
  await writeFile(ENGINE, `${original}\nexport const UPGRADE_CANARY = 'build-b';\n`);
  build();
} finally {
  // Restored immediately: dist holds build B, and the source tree is left
  // exactly as it was whether or not the rest of this runs.
  await writeFile(ENGINE, original);
}
await writeFile(path.join(DIST, 'assets', 'js', 'token.js'), "window.ABMAP_MAPBOX_TOKEN = '';\n");

errors.length = 0;
await page.reload({ waitUntil: 'load' });
/*
 * The worker from build B installs and then waits, because this client is
 * still controlled by build A's. That is not a quirk of the test - it is
 * exactly the state a reader is in when they reload after a deploy, and the
 * reason "just refresh" does not fix it.
 */
check('build A’s worker is still the one in control', await workerState(), 'activated');

const seen = await canaryVisible();
check('the reloaded page sees the NEW module, not the cached old one', seen, true);
if (seen !== true) {
  console.log('\n  The worker served a module from the previous build alongside new HTML.');
  console.log('  A page importing a name the stale copy does not export fails to link,');
  console.log('  and renders as much as its HTML alone describes.');
}

const linkErrors = errors.filter((message) => /does not provide an export|Failed to fetch dynamically/.test(message));
check('and nothing failed to link', linkErrors.length, 0);
for (const message of linkErrors) console.log(`        ${message}`);

await browser.close();
server.close();

console.log(failures ? `\n${failures} check(s) failed.` : '\nThe upgrade path is clean.');
process.exit(failures ? 1 : 0);
