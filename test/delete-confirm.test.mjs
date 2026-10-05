/**
 * Nothing in a folder is deleted on one tap.
 *
 * A folder, a trip's pins and a table selection all asked first; a single pin
 * did not - not from its card, and not from the cross at the end of its row.
 * There is no undo, and a pin can hold a note and photographs kept nowhere
 * else. This reads viewer.js for every call that deletes a pin or a folder
 * and checks that the handler it sits in asks before it gets there, so the
 * next delete button added cannot quietly skip the question.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const viewer = await readFile(new URL('../assets/js/viewer.js', import.meta.url), 'utf8');

test('deleting: every pin and folder delete asks first', () => {
  const calls = [...viewer.matchAll(/state\.folders\.(remove|removeItem|removeItems)\(/g)];
  assert.ok(calls.length >= 5, `found only ${calls.length} deletes - is this looking at the right calls?`);
  const unasked = [];
  for (const call of calls) {
    const handler = viewer.lastIndexOf('onclick', call.index);
    const before = viewer.slice(handler, call.index);
    if (handler < 0 || !/confirm/i.test(before)) {
      unasked.push(viewer.slice(0, call.index).split('\n').length);
    }
  }
  assert.deepEqual(unasked, [], `deletes with no question before them, at viewer.js lines ${unasked.join(', ')}`);
});

test('deleting: the question names the pin, and says it cannot be undone', () => {
  const ask = viewer.slice(viewer.indexOf('function confirmPinDelete'));
  assert.match(ask.slice(0, 600), /window\.confirm\(`Delete \$\{what\}\$\{where\}\? This cannot be undone\.`\)/);
});
