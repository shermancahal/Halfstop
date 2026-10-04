/**
 * The "What's new" section on the homepage.
 *
 * Release notes go wrong quietly: an entry added at the bottom instead of the
 * top, or a date typed one way in the attribute and another in the text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const section = index.slice(index.indexOf('id="whats-new"'), index.indexOf('id="roadmap"'));
const dates = [...section.matchAll(/<time datetime="(\d{4}-\d{2}-\d{2})">([^<]+)<\/time>/g)];

test('release notes: there are some, newest first', () => {
  assert.ok(dates.length >= 2, `found ${dates.length} dated entries`);
  const iso = dates.map(([, value]) => value);
  assert.deepEqual(iso, [...iso].sort().reverse(), 'entries out of order');
  assert.equal(new Set(iso).size, iso.length, 'two entries for one day');
});

test('release notes: each date says what its attribute says', () => {
  for (const [, value, text] of dates) {
    const date = new Date(`${value}T12:00:00Z`);
    const said = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    assert.equal(text.trim(), said, value);
  }
});

test('release notes: every entry says something, and the footer links to them', () => {
  const entries = section.split('<article class="release">').slice(1);
  for (const entry of entries) assert.match(entry, /<li>/);
  assert.match(index, /<a href="index\.html#whats-new">What's new<\/a>/);
});
