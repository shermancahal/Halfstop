/**
 * Asking the browser to keep downloaded maps, and saying whether it agreed.
 *
 * navigator.storage is stood in for: the real one answers from heuristics
 * (installed, bookmarked, how much the site is used) that a test cannot set.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { keepStorage, storageStanding, keptNote } from '../assets/js/lib/offline.js';

function stubStorage({ persisted = false, grants = false, throws = false } = {}) {
  const asked = [];
  return {
    asked,
    async persisted() { if (throws) throw new Error('no'); return persisted; },
    async persist() { asked.push('persist'); if (throws) throw new Error('no'); return grants; },
  };
}

test('keep storage: asks once, and only when not already kept', async () => {
  const already = stubStorage({ persisted: true });
  assert.equal(await keepStorage(already), 'kept');
  assert.deepEqual(already.asked, [], 'no need to ask again');

  const granted = stubStorage({ grants: true });
  assert.equal(await keepStorage(granted), 'kept');
  assert.deepEqual(granted.asked, ['persist']);

  assert.equal(await keepStorage(stubStorage({ grants: false })), 'best-effort');
  assert.equal(await keepStorage(stubStorage({ throws: true })), 'best-effort');
  assert.equal(await keepStorage(undefined), 'unsupported');
  assert.equal(await keepStorage({}), 'unsupported');
});

test('keep storage: reading the standing never asks', async () => {
  const storage = stubStorage({ persisted: false });
  assert.equal(await storageStanding(storage), 'best-effort');
  assert.deepEqual(storage.asked, []);
  assert.equal(await storageStanding(stubStorage({ persisted: true })), 'kept');
  assert.equal(await storageStanding(undefined), 'unsupported');
});

test('keep storage: the note says what the browser decided, and nothing in the app', () => {
  assert.match(keptNote('kept'), /agreed to keep downloads/);
  assert.match(keptNote('best-effort'), /may clear downloads.*Installing Halfstop/);
  assert.doesNotMatch(keptNote('best-effort', { installed: true }), /Installing/, 'already installed');
  assert.equal(keptNote('best-effort', { native: true }), '', 'the app keeps its own storage');
  assert.equal(keptNote('kept', { native: true }), '');
  assert.equal(keptNote('unsupported'), '');
});

test('keep storage: both download buttons ask, and neither waits on the answer', async () => {
  const viewer = await readFile(new URL('../assets/js/viewer.js', import.meta.url), 'utf8');
  const calls = [...viewer.matchAll(/^(.*)\bkeepStorage\(\)/gm)];
  assert.equal(calls.length, 2, 'Download for offline and Re-download');
  for (const [line] of calls) {
    assert.doesNotMatch(line, /await\s+keepStorage/, 'a Firefox prompt must not hold up the download');
    assert.match(line, /appShell\(\)\.native/, 'not asked inside the app');
  }
});
