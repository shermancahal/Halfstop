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

/*
 * Every page the build ships, and this list has to stay level with the one in
 * tools/build-dist.mjs. Two pages were written, linked from the footer, and
 * shipped by neither - the build copies a named list and so does this, so a new
 * page is invisible to both until it is named twice.
 */
const PAGES = ['index.html', 'faq.html', 'map.html', 'terms.html', 'privacy.html', 'admin.html'];

/*
 * The two lists, checked against each other rather than by hand.
 *
 * terms.html and privacy.html were written, linked from the footer, and shipped
 * by nothing: the build copies a named list of pages and so does this file, so
 * a new page is invisible to both until somebody remembers to name it twice.
 * Nothing failed. The footer just linked to a 404 on the live site.
 */
test('pages: the build ships exactly the pages this file checks', async () => {
  const source = await readFile(new URL('../tools/build-dist.mjs', import.meta.url), 'utf8');
  const declared = /const INCLUDE_FILES = \[([^\]]*)\]/.exec(source)?.[1];
  assert.ok(declared, 'INCLUDE_FILES is not where this test expects it');
  const shipped = [...declared.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...shipped].sort(), [...PAGES].sort(),
    'tools/build-dist.mjs and this list have drifted apart');
});

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

/*
 * A page that draws the settings menu has to load the CSS that styles it.
 *
 * The menu's markup and its JavaScript were shared across every page before
 * its stylesheet was: the rules lived in viewer.css, which the map alone
 * loads, so the panel opened on the landing page as an unstyled column of
 * inputs spilling down over the headline. Nothing threw, the DOM was correct,
 * and every test passed.
 *
 * Checked by class rather than by filename, because the point is that the
 * rules arrive, not which file carries them.
 */
test('pages: a page with the settings menu loads the CSS that styles it', async () => {
  const styles = new Map();
  for (const file of ['assets/css/site.css', 'assets/css/viewer.css']) {
    styles.set(file, await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
  }

  /*
   * Read out of the modules rather than written down here.
   *
   * The first version of this test carried a hand-written list of four
   * classes, and passed while .hint and .toast were still map-only - so the
   * sign-in explanation rendered near-invisible and every error message landed
   * unstyled at the foot of the document, which is how a failed sign-in came
   * to look like a button that does nothing. A list somebody has to remember
   * to extend is a list that documents the bugs already found.
   *
   * So the shared modules are asked what they draw. Static class attributes
   * only; the two interpolated ones are named below, since a regex cannot
   * evaluate a template literal.
   */
  const SHARED = [
    'assets/js/lib/account-panel.js',
    'assets/js/lib/settings-menu.js',
    'assets/js/lib/page-settings.js',
    'assets/js/lib/ui.js',
  ];
  const emitted = new Set(['toast', 'toast-stack', 'settings-choice']);
  for (const file of SHARED) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/class: '([^']+)'/g)) {
      for (const name of match[1].split(/\s+/)) {
        if (name && !name.startsWith('is-')) emitted.add(name);
      }
    }
  }
  const NEEDED = [...emitted].map((name) => `.${name}`).sort();
  assert.ok(NEEDED.length > 15, `expected to find the panel's classes, found ${NEEDED.length}`);
  const unstyled = [];

  for (const page of PAGES) {
    const html = await readFile(new URL(`../${page}`, import.meta.url), 'utf8');
    if (!html.includes('id="settings-panel"')) continue;

    const sheets = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)]
      .map((match) => match[1]);
    const css = sheets.map((href) => styles.get(href) || '').join('\n');

    /*
     * A rule of its own, not merely the characters somewhere in the file.
     *
     * An earlier version of this asked whether the stylesheet contained the
     * string ".hint", and `#account-panel .hint { overflow-wrap: anywhere }`
     * answered yes - so the check passed while the rule that gives .hint its
     * colour and size was still map-only. Requiring the class at the head of a
     * selector is what tells "styled here" from "mentioned here".
     */
    for (const rule of NEEDED) {
      const standalone = new RegExp(`(?:^|[,{}])\\s*\\${rule}(?![\\w-])`, 'm');
      if (!standalone.test(css)) unstyled.push(`${page} draws the settings menu but no stylesheet it loads defines ${rule}`);
    }
  }

  assert.deepEqual(unstyled, [], 'the panel would render unstyled on these pages');
});

/*
 * The panel that could take a password and do nothing with it.
 *
 * mountPageSettings built an Account and never called init(), and init() is
 * where every moving part is: the existing session is read there, the plan is
 * fetched there, the provider buttons are decided there, and
 * onAuthStateChange - the thing that tells the panel a sign-in worked - is
 * subscribed there.
 *
 * So index, faq, terms and privacy shipped a form that handed credentials to
 * Supabase, got a session back, and redrew nothing. It was reported as "can't
 * sign in - no error message displayed", and there was no error: the sign-in
 * succeeded, server-side, at the minute of the screenshot. The panel simply
 * never heard.
 *
 * Structural rather than behavioural because there is no DOM in this suite,
 * and the failure was structural: a call that was not there.
 */
test('pages: an account the settings menu builds is one it starts', async () => {
  const source = await readFile(new URL('../assets/js/lib/page-settings.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /\bwho\.init\(\)/,
    'mountPageSettings builds an Account but never calls init(), so the panel '
    + 'cannot hear a sign-in, read a session, or fetch a plan',
  );
});

test('pages: a page bringing its own account starts it itself', async () => {
  /*
   * The other half of the rule above. mountPageSettings deliberately does not
   * init an account it was handed - admin.js owns that one, and a second
   * subscription would redraw twice per sign-in - so the page that hands one
   * over has to start it.
   */
  const unstarted = [];
  for (const file of ['assets/js/admin.js', 'assets/js/home.js', 'assets/js/faq.js', 'assets/js/viewer.js']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    const handsOne = /mountPageSettings\(\{[^}]*\baccount\b/.test(source);
    if (handsOne && !/\.init\(\)/.test(source)) unstarted.push(file);
  }
  assert.deepEqual(unstarted, [], 'these pass their own Account to the settings menu and never start it');
});
