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

/* ------------------------------------------- copying a link that takes time */

import { copyWhenReady } from '../assets/js/lib/share.js';

test('copying a slow link: the write starts inside the tap, before the link exists', async () => {
  // Reported on two bars: the link took most of a minute, and by then the
  // phone refused both the share sheet and the clipboard.
  const writes = [];
  class Item { constructor(parts) { this.parts = parts; } }
  const clipboard = {
    write: async (items) => {
      writes.push(items);
      const blob = await items[0].parts['text/plain'];
      return blob.text();
    },
  };
  let finish;
  const text = new Promise((resolve) => { finish = resolve; });
  const copied = copyWhenReady(text, { clipboard, Item });
  assert.equal(writes.length, 1, 'the clipboard was not asked until the link had been made');

  finish('Waterfalls: 3 places sent from Halfstop. https://app.halfstop.app/map.html?f=abc');
  assert.equal(await copied, true);
  assert.equal(await (await writes[0][0].parts['text/plain']).text(),
    'Waterfalls: 3 places sent from Halfstop. https://app.halfstop.app/map.html?f=abc');
});

test('copying a slow link: a link that could not be made copies nothing, and says so', async () => {
  class Item { constructor(parts) { this.parts = parts; } }
  const clipboard = { write: async (items) => { await items[0].parts['text/plain']; } };
  const copied = copyWhenReady(Promise.reject(new Error('No signal')), { clipboard, Item });
  assert.equal(await copied, false);
});

test('copying a slow link: without that kind of clipboard, the plain kind is tried once it is ready', async () => {
  const written = [];
  assert.equal(await copyWhenReady(Promise.resolve('a link'), {
    clipboard: { writeText: async (value) => { written.push(value); } }, Item: undefined,
  }), true);
  assert.deepEqual(written, ['a link']);
  assert.equal(await copyWhenReady(Promise.resolve('a link'), {
    clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } }, Item: undefined,
  }), false, 'a refused copy said it had copied');
  assert.equal(await copyWhenReady(Promise.resolve('a link'), { clipboard: undefined, Item: undefined }), false);
});

test('copying a slow link: the folder panel starts the copy before it waits, and keeps the link on screen', async () => {
  const viewer = await readFile(new URL('../assets/js/viewer.js', import.meta.url), 'utf8');
  const send = viewer.slice(viewer.indexOf('async function sendFolderLink'), viewer.indexOf('function showMadeLink'));
  const copyAt = send.indexOf('copyWhenReady(');
  const firstAwait = send.indexOf('await ');
  assert.ok(copyAt > -1 && copyAt < firstAwait, 'the copy is started after something was awaited, outside the tap');
  assert.match(send, /showMadeLink\(made,/, 'the made link is not shown with its own Share and Copy');
  // The box it is shown in has to reach the function: it once did not, and
  // Send a link threw before it had done anything.
  assert.match(send, /^async function sendFolderLink\(folder, \{ status, button, made \}\)/);
  assert.match(viewer, /sendFolderLink\(folder, \{ status, button: link, made \}\)/);
  assert.doesNotMatch(send, /offerLink\(/, 'the share sheet is opened after the wait again, which a phone refuses');
});
