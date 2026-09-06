import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { SITE } from '../assets/js/config.js';

/*
 * What the shipped HTML has to be true about itself.
 *
 * These pages are hand-written and there is no template engine to keep them
 * honest, so the things that must agree across three files - the app's name,
 * which prose an editor may replace, which markup the JavaScript reaches for -
 * agree only because somebody remembered. Each check below is a thing that has
 * gone wrong or came within one commit of going wrong.
 */

const PAGES = ['index.html', 'faq.html', 'map.html'];

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

/**
 * The document minus its comments.
 *
 * Not cosmetic: the library section and the Contribute section are commented
 * out rather than deleted, and a check that counted them would be reading
 * markup no browser ever builds. Every question here is about what ships.
 */
const live = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

/** Each `<section …>…</section>` in the document, opening tag and contents. */
function sections(html) {
  const found = [];
  const re = /<section\b([^>]*)>/g;
  let match;
  while ((match = re.exec(html))) {
    const end = html.indexOf('</section>', re.lastIndex);
    assert.notEqual(end, -1, 'a <section> was never closed');
    found.push({ attrs: match[1], body: html.slice(re.lastIndex, end) });
  }
  return found;
}

test('pages: the app calls itself the same thing everywhere', async () => {
  for (const page of PAGES) {
    const html = await read(page);
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
    assert.ok(title?.includes(SITE.name), `${page}: <title> "${title}" omits ${SITE.name}`);

    const ios = /<meta name="apple-mobile-web-app-title" content="([^"]*)">/.exec(html)?.[1];
    assert.equal(ios, SITE.shortName, `${page}: the iOS home-screen name disagrees with config`);

    const brand = /id="brand-name">([^<]*)</.exec(html)?.[1];
    assert.equal(brand, SITE.name, `${page}: the header brand disagrees with config`);
  }
});

test('pages: the manifest and the native shell call it that too', async () => {
  const manifest = JSON.parse(await read('manifest.webmanifest'));
  assert.equal(manifest.name, SITE.name);
  assert.equal(manifest.short_name, SITE.shortName);
  assert.equal(JSON.parse(await read('capacitor.config.json')).appName, SITE.name);
});

test('pages: every shortcut in the manifest points at a page that exists', async () => {
  const manifest = JSON.parse(await read('manifest.webmanifest'));
  for (const shortcut of manifest.shortcuts || []) {
    await assert.doesNotReject(read(shortcut.url), `${shortcut.url} is a 404`);
  }
});

test('pages: the homepage catalogue is present or absent as one piece', async () => {
  const html = live(await read('index.html'));
  const used = ['catalog-grid', 'catalog-message', 'search', 'filter-region',
    'filter-tag', 'library-count', 'stat-strip', 'stat-maps', 'stat-distance',
    'stat-waypoints', 'stat-regions'];
  const present = used.filter((id) => html.includes(`id="${id}"`));
  assert.ok(present.length === 0 || present.length === used.length,
    `index.html ships ${present.length} of the catalogue's ${used.length} elements: `
    + `missing ${used.filter((id) => !present.includes(id)).join(', ')}`);
});

/*
 * A comment that contains "--" is not a comment for its whole length.
 *
 * The Contribute section is commented out and its prose mentions CSS custom
 * properties; writing those verbatim would close the comment early and put
 * half a hidden section back on the page. It has been written as "- -" once
 * already for exactly this reason.
 */
test('pages: no commented-out markup closes its own comment early', async () => {
  for (const page of PAGES) {
    for (const [, inner] of (await read(page)).matchAll(/<!--([\s\S]*?)-->/g)) {
      assert.ok(!inner.includes('--'), `${page}: a comment contains "--"`);
    }
  }
});

/*
 * The module graph, discovered at parse time instead of one wave at a time.
 *
 * A browser cannot know map.html needs lib/xml.js until it has fetched and
 * parsed lib/kml.js, which it could not know about until viewer.js: five
 * sequential waves before the GL library was so much as requested. The preload
 * links collapse that, and they are only worth having while they are complete
 * and exact - a stale list silently goes back to discovering the missing half
 * the slow way, and nothing on screen says so.
 */
const importsOf = (source) => [
  ...source.matchAll(/^\s*import\s+(?:[\w*{},\s]+\s+from\s+)?['"](\.[^'"]+)['"]/gm),
].map((m) => m[1]);

async function moduleGraph(entry) {
  const reached = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    let source;
    try {
      source = await read(file);
    } catch {
      continue;
    }
    for (const specifier of importsOf(source)) {
      const resolved = new URL(specifier, new URL(file, 'file:///')).pathname.slice(1);
      if (reached.has(resolved)) continue;
      reached.add(resolved);
      queue.push(resolved);
    }
  }
  return reached;
}

test('pages: the map preloads every module it will import, and only those', async () => {
  const html = await read('map.html');
  const declared = new Set(
    [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]),
  );
  const needed = await moduleGraph('assets/js/viewer.js');

  const missing = [...needed].filter((href) => !declared.has(href)).sort();
  const extra = [...declared].filter((href) => !needed.has(href)).sort();
  const lines = (list) => list.map((href) => `<link rel="modulepreload" href="${href}">`).join('\n');

  assert.deepEqual({ missing, extra }, { missing: [], extra: [] },
    `map.html's preload list has drifted from the import graph.\n`
    + (missing.length ? `\nAdd:\n${lines(missing)}\n` : '')
    + (extra.length ? `\nRemove:\n${lines(extra)}\n` : ''));
});

/*
 * A preload only preloads if its URL is the one the import will ask for.
 *
 * The build stamps ?v=<hash> onto the assets a page names directly, and module
 * specifiers inside the JavaScript are never rewritten - viewer.js still
 * imports './lib/geo.js'. Stamp a preload and it warms a cache entry nothing
 * reads while the real request goes out unstamped: every file fetched twice,
 * and the optimisation becomes a straight cost. Nothing on the page would look
 * wrong, which is why this is checked here.
 */
test('pages: no preload carries a cache-busting query the import will not', async () => {
  for (const page of PAGES) {
    for (const [, href] of (await read(page)).matchAll(/<link rel="modulepreload" href="([^"]+)">/g)) {
      assert.ok(!href.includes('?'), `${page}: ${href} is preloaded at a URL no import requests`);
    }
  }
});
