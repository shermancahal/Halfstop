/**
 * Shared links open what they were sent with, even with the message stuck on.
 *
 * Reported as all three kinds of link doing nothing: a view opened over east
 * Tennessee, a pin opened at the right zoom but with nothing on the map, and
 * a folder of 1,543 places opened nothing at all. The copied text was
 *
 *     https://app.halfstop.app/map.html#view=8.46/44.3765/-73.85
 *     This is a broad view sent from Halfstop:
 *
 * - link first, sentence second, as a share sheet copies them - and pasted
 * into an address bar the line break goes and the sentence lands on the end
 * of the address: on the view in the hash, on the folder id in the query.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { cleanViewHash, readSharedPin, linkCarriesView } from '../assets/js/lib/share.js';

test('shared links: a view with the message stuck on the end still says where to look', () => {
  const glued = '#view=8.46/44.3765/-73.85This%20is%20a%20broad%20view%20sent%20from%20Halfstop:';
  assert.equal(cleanViewHash(glued), '#view=8.46/44.3765/-73.85');
  assert.equal(cleanViewHash('#view=14/44.70360/-73.60178This is a view of Kent Falls sent from Halfstop.'),
    '#view=14/44.70360/-73.60178');
  // A full stop from the end of a sentence the link was written into.
  assert.equal(cleanViewHash('#view=14/44.70360/-73.60178.'), '#view=14/44.70360/-73.60178');
  // Bearing and pitch are kept.
  assert.equal(cleanViewHash('#view=9/35.96/-84.28/30/45x'), '#view=9/35.96/-84.28/30/45');
  assert.ok(linkCarriesView(cleanViewHash(glued)));
});

test('shared links: a clean hash, or no view at all, is left exactly as it was', () => {
  for (const hash of ['#view=8.46/44.3765/-73.85', '#view=9/35.96/-84.28&other=1', '', '#photos', '#view=garbage']) {
    assert.equal(cleanViewHash(hash), hash);
  }
});

test('shared links: a pin with text stuck to its coordinates is still that pin', () => {
  assert.deepEqual(readSharedPin(new URLSearchParams('?p=44.703598%2C-73.601780This&pn=Kent+Falls')),
    { lat: 44.703598, lon: -73.60178, name: 'Kent Falls' });
  assert.equal(readSharedPin(new URLSearchParams('?p=north%2Csouth')), null);
  assert.equal(readSharedPin(new URLSearchParams('?p=95%2C10')), null, 'off the globe is still refused');
});

test('shared links: the map is put right before it reads the hash, and a pin arrives on the map', async () => {
  const viewer = await readFile(new URL('../assets/js/viewer.js', import.meta.url), 'utf8');
  const main = viewer.slice(viewer.indexOf('async function main()'));
  const cleaned = main.indexOf('cleanViewHash(location.hash)');
  assert.ok(cleaned > -1, 'the hash is no longer cleaned');
  assert.ok(cleaned < main.indexOf("hash: 'view'"), 'the hash is cleaned after the map has read it');
  assert.ok(cleaned < main.indexOf('linkCarriesView(location.hash)'));

  const arrival = main.slice(main.indexOf('if (initial.pin) {'), main.indexOf('if (initial.pin) {') + 500);
  assert.match(arrival, /showDropPin\(\[lon, lat\], \{ name \}\)/, 'a shared pin is not put on the map');
  assert.match(arrival, /showPointDetails\(\[lon, lat\], name, \{ open: !isNarrow\(\) \}\)/,
    'the details panel takes over a phone screen again');
  assert.match(arrival, /jumpTo\(\{ center: \[lon, lat\]/, 'a pin link without a view does not open on the pin');
});

test('shared links: the sentence reads in either order', async () => {
  const viewer = await readFile(new URL('../assets/js/viewer.js', import.meta.url), 'utf8');
  for (const [, text] of viewer.matchAll(/text: '(This is a [^']*sent from Halfstop[^']*)'/g)) {
    assert.ok(text.endsWith('.'), `"${text}" points at a link that may come before it`);
  }
  assert.doesNotMatch(viewer, /sent from Halfstop:/);
});
