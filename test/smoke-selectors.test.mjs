import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/*
 * The smoke test gates the deploy, and it selects on class names it does not
 * own.
 *
 * Restructuring the identify card removed `.popup-bar` from it. Every unit test
 * passed, the build passed, the page looked right — and the deploy failed
 * thirty seconds into the smoke run, waiting for a button that no longer
 * existed. Two commits sat unshipped and the fixes in them were reported as
 * still broken, which is the worst version of this: not a red build somebody
 * looks at, but a green-looking repository and a stale site.
 *
 * A class the smoke test selects has to exist somewhere the app can produce it.
 *
 * Be clear about what that does and does not cover, because this test was
 * written for a failure it turns out not to catch. `.popup-bar` still exists —
 * the pin and feature popups still use it — so "does this class exist" was true
 * the whole time the identify card had stopped producing it. Only the browser
 * can answer whether `.identify-card .popup-bar` matches anything, and only the
 * smoke run asks.
 *
 * What this does catch is the simpler and commoner half: a class renamed or
 * deleted outright while something else was still looking for it. That is worth
 * a second of `npm test`. It is not a substitute for reading the smoke test
 * when you rename anything it touches, and it is not a substitute for watching
 * the deploy after pushing — which is the step whose absence let two commits
 * sit unshipped while their fixes were reported as not working.
 */

const ROOTS = ['assets/js', 'assets/css'];
const PAGES = ['index.html', 'map.html', 'faq.html'];

/*
 * Classes nobody in this repository writes.
 *
 * The engine's own chrome, and the classes the smoke test creates for itself
 * inside evaluate(). Listed rather than pattern-matched, so adding to it is a
 * decision somebody makes on purpose.
 */
const NOT_OURS = new Set([
  'maplibregl-canvas', 'maplibregl-popup', 'maplibregl-popup-content',
  'maplibregl-ctrl', 'maplibregl-ctrl-group', 'maplibregl-marker',
  'mapboxgl-canvas', 'mapboxgl-popup', 'mapboxgl-popup-content',
  'mapboxgl-ctrl', 'mapboxgl-ctrl-group', 'mapboxgl-marker',
]);

test('smoke: every class the smoke test looks for is one the app can produce', async () => {
  const smoke = await readFile(new URL('../tools/smoke.mjs', import.meta.url), 'utf8');

  let haystack = '';
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!/\.(m?js|css)$/.test(entry.name)) continue;
      haystack += await readFile(full, 'utf8');
    }
  };
  for (const root of ROOTS) await walk(root);
  for (const page of PAGES) haystack += await readFile(new URL(`../${page}`, import.meta.url), 'utf8');

  /*
   * Every string first, then every class inside it.
   *
   * The first attempt matched the quote and the class in one pattern, which
   * finds exactly one class per string: `.identify-card .popup-bar button`
   * yielded `identify-card` and stopped, so the very selector this test was
   * written for slipped through. Written and then broken on purpose to check,
   * which is the only reason it was found.
   *
   * Hyphenated names only, which rules out property access — `.value`,
   * `.length`, `.textContent` — without needing a list of every method name.
   */
  const wanted = new Set();
  for (const [, quoted] of smoke.matchAll(/['"`]([^'"`\n]*)['"`]/g)) {
    for (const [, name] of quoted.matchAll(/\.([a-z]+(?:-[a-z0-9]+)+)/g)) wanted.add(name);
  }

  const missing = [...wanted]
    .filter((name) => !NOT_OURS.has(name))
    .filter((name) => !haystack.includes(name))
    .sort();

  assert.deepEqual(missing, [],
    'the smoke test waits for these and nothing makes them — the deploy fails, not the build');
});
