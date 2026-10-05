/**
 * The map page does not zoom; the map does.
 *
 * On an iPhone, tapping the place search (14px text) had Safari zoom the
 * whole page in on it, and a page zoom is undone with a pinch - which on the
 * map page lands on the map. The page stayed zoomed, the header and panel
 * off the edges of the screen, until the app was closed. See
 * assets/js/lib/page-zoom.js for the three layers that stop it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { MAP_VIEWPORT, holdPageScale } from '../assets/js/lib/page-zoom.js';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const viewportOf = (html) => /<meta name="viewport" content="([^"]+)">/.exec(html)?.[1] || '';

test('page zoom: the map page holds its scale, by the viewport', async () => {
  const viewport = viewportOf(await read('map.html'));
  assert.equal(viewport, MAP_VIEWPORT);
  // maximum-scale=1 is what stops Safari zooming in on a small text box.
  assert.match(viewport, /maximum-scale=1(,|$)/);
  assert.match(viewport, /user-scalable=no/);
  assert.match(viewport, /viewport-fit=cover/, 'the notch handling went with it');
});

test('page zoom: the pages that scroll can still be zoomed for reading', async () => {
  for (const page of ['index.html', 'faq.html', 'about.html', 'account.html', 'privacy.html', 'terms.html']) {
    const viewport = viewportOf(await read(page));
    assert.ok(viewport, `${page} has no viewport`);
    assert.doesNotMatch(viewport, /user-scalable=no|maximum-scale=1(\.0)?(,|$)/, `${page} cannot be zoomed`);
  }
});

test('page zoom: Safari’s page pinch is cancelled, and can be let go again', () => {
  const listeners = new Map();
  const target = {
    addEventListener: (name, handler, options) => listeners.set(name, { handler, options }),
    removeEventListener: (name, handler) => { if (listeners.get(name)?.handler === handler) listeners.delete(name); },
  };
  const undo = holdPageScale(target);
  assert.deepEqual([...listeners.keys()].sort(), ['gesturechange', 'gestureend', 'gesturestart']);
  for (const { handler, options } of listeners.values()) {
    // Passive listeners cannot cancel anything; Safari would ignore it.
    assert.equal(options?.passive, false);
    let cancelled = false;
    handler({ preventDefault: () => { cancelled = true; } });
    assert.equal(cancelled, true);
  }
  undo();
  assert.equal(listeners.size, 0);
  // Nowhere to listen is not an error.
  assert.equal(typeof holdPageScale(null), 'function');
});

test('page zoom: the map page holds it before anything can be tapped, and the CSS backs it', async () => {
  const viewer = await read('assets/js/viewer.js');
  const main = viewer.slice(viewer.indexOf('async function main()'));
  assert.ok(main.indexOf('holdPageScale(document)') > -1, 'main() no longer holds the page scale');
  assert.ok(main.indexOf('holdPageScale(document)') < main.indexOf('cacheDom()'), 'it should be the first thing main() does');

  const css = await read('assets/css/viewer.css');
  assert.match(css, /html, body \{ touch-action: pan-x pan-y; \}/, 'double-tap zoom is back on the map page');
});
