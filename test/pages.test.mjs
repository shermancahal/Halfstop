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

/*
 * The one that nearly shipped.
 *
 * `bodyOf` asks `matches` before `querySelector`, because querySelector looks
 * at descendants only - so a section carrying both attributes on the same
 * element resolves to itself and then, one save later, to itself emptied. The
 * library code handles it now; the markup should still never ask.
 */
test('pages: no element is both an editable section and its own body', async () => {
  for (const page of PAGES) {
    const html = live(await read(page));
    for (const section of sections(html)) {
      if (!/\bdata-editable=/.test(section.attrs)) continue;
      assert.ok(!/\bdata-editable-body\b/.test(section.attrs),
        `${page}: a section is marked as its own body`);
      /*
       * Naming a body is optional, and the help page names none: a flat
       * heading-and-paragraphs section falls through to "keep the h2, replace
       * the rest", which is the older rule and still the right one for that
       * shape. Naming two, though, means the second is prose that looks
       * editable and silently is not.
       */
      const bodies = section.body.match(/\bdata-editable-body\b/g) || [];
      assert.ok(bodies.length <= 1,
        `${page}: an editable section names ${bodies.length} bodies`);
    }
  }
});

/*
 * Text the config renders may not sit inside text an editor replaces.
 *
 * applyBranding writes SITE.name, the tagline and the parent org into these
 * ids on every load. Put one inside an editable body and there are two sources
 * of truth for the same words: the editor's save wins until the next reload,
 * when the config quietly overwrites it - or, if the save dropped the element,
 * the config has nowhere to write and the name simply freezes.
 */
test('pages: config-rendered text stays out of editable bodies', async () => {
  const bound = ['brand-name', 'brand-parent', 'parent-name', 'footer-name',
    'footer-tagline', 'footer-holder', 'footer-parent-link'];

  for (const page of PAGES) {
    const html = live(await read(page));
    for (const section of sections(html)) {
      if (!/\bdata-editable=/.test(section.attrs)) continue;
      /*
       * A named body starts at its attribute; an unnamed one is the whole
       * section bar the heading. Both over-read rather than under-read - a
       * false alarm here is a comment away from being fixed, a miss is a
       * frozen brand.
       */
      const at = section.body.indexOf('data-editable-body');
      const region = at === -1 ? section.body : section.body.slice(at);
      for (const id of bound) {
        assert.ok(!region.includes(`id="${id}"`),
          `${page}: #${id} is inside an editable body`);
      }
    }
  }
});

/*
 * home.js keys its early return on one element and then uses eight.
 *
 * The catalogue markup is commented out as a block, so all of it is absent
 * together and the guard holds. Uncomment half of it - the grid without the
 * stat strip, say - and renderStats reaches for #stat-maps, throws, and the
 * homepage logs an error on every load. They travel together or not at all.
 */
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
