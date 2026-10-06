/**
 * A folder sent as a link.
 *
 * The server half is create_folder_link() and open_folder_link() in
 * supabase/schema.sql, probed against the live database when it went in. What
 * is pinned here is the browser's half: what goes into a link and what is left
 * out, how an id is read off an address, and that the account passes the
 * server's refusals on as the sentences they are.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  LINK_PARAM, LINK_MAX_PLACES, readLinkId, linkCollection, folderLinkParts, linkLastsUntil,
} from '../assets/js/lib/folder-link.js';
import { shareableURL } from '../assets/js/lib/share.js';
import { Account } from '../assets/js/lib/account.js';

const ID = '0123456789abcdef0123456789abcdef';

test('folder link: the id is read off the address, and only a real one', () => {
  assert.equal(readLinkId(new URLSearchParams(`?f=${ID}`)), ID);
  assert.equal(readLinkId(new URLSearchParams(`?f=${ID.toUpperCase()}`)), ID, 'a messaging app that shouts');
  // The message a share sheet copies with the link, stuck onto the end of it
  // by an address bar: the id is still the 32 characters it starts with.
  assert.equal(readLinkId(new URLSearchParams(`?f=${ID}x`)), ID);
  assert.equal(readLinkId(new URLSearchParams(`?f=${ID}Waterfalls:%201543%20places%20sent%20from%20Halfstop.`)), ID);
  assert.equal(readLinkId(new URLSearchParams(`?f=${ID}bear%20falls`)), ID, 'text that starts with hex letters');
  assert.equal(readLinkId(new URLSearchParams(`?f=${ID.slice(0, 31)}`)), '', 'one character short is not an id');
  assert.equal(readLinkId(new URLSearchParams('?f=../../etc')), '');
  assert.equal(readLinkId(new URLSearchParams('?m=byways')), '');
  assert.equal(LINK_PARAM, 'f');
});

test('folder link: it opens the map on the website, from the app as from a browser', () => {
  const parts = folderLinkParts(ID);
  const site = 'https://app.halfstop.app/';
  assert.equal(shareableURL({ href: 'capacitor://localhost/map.html', protocol: 'capacitor:', site, ...parts }),
    `https://app.halfstop.app/map.html?f=${ID}`);
  assert.equal(shareableURL({ href: 'https://app.halfstop.app/map.html?m=x#view=1/2/3', protocol: 'https:', site, ...parts }),
    `https://app.halfstop.app/map.html?f=${ID}`);
});

test('folder link: photographs stay behind, everything else on a pin goes', () => {
  const sent = linkCollection({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature', id: 'a',
      geometry: { type: 'Point', coordinates: [-109.5, 38.6] },
      properties: { name: 'Moab', note: 'Park on the left', color: '#b4441f', photos: [{ id: 'p1' }] },
    }],
  });
  assert.deepEqual(sent.features[0].properties, { name: 'Moab', note: 'Park on the left', color: '#b4441f' });
  assert.equal(sent.features[0].id, 'a');
  assert.deepEqual(linkCollection(null), { type: 'FeatureCollection', features: [] });
  assert.equal(LINK_MAX_PLACES, 2000);
});

test('folder link: the browser and the server agree on the limits', async () => {
  const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  const fn = schema.slice(schema.indexOf('function public.create_folder_link'));
  assert.match(fn, new RegExp(`places > ${LINK_MAX_PLACES}`));
  assert.match(schema, /expires_at\s+timestamptz not null default now\(\) \+ interval '30 days'/);
  assert.match(schema, /grant execute on function public\.open_folder_link\(text\) to anon, authenticated/);
  assert.match(schema, /revoke execute on function public\.create_folder_link\(text, jsonb\) from anon/);
});

test('folder link: how long it lasts is said as a date', () => {
  assert.equal(linkLastsUntil('2026-11-03T18:00:00Z', 'en-US'), 'until November 3');
  assert.equal(linkLastsUntil('not a date'), 'for 30 days');
});

/** An Account wired to a stand-in client that answers rpc() calls. */
function accountWith(answers, { user = { id: 'u1' } } = {}) {
  const calls = [];
  const account = Object.create(Account.prototype);
  account.user = user;
  account.getClient = async () => ({
    rpc: async (name, args) => { calls.push([name, args]); return answers[name]; },
  });
  return { account, calls };
}

test('folder link: making one hands over the name and places, and passes refusals on', async () => {
  const collection = { type: 'FeatureCollection', features: [{}] };
  const { account, calls } = accountWith({
    create_folder_link: { data: { ok: true, id: ID, expires_at: '2026-11-03T00:00:00Z' }, error: null },
  });
  assert.deepEqual(await account.createFolderLink('Moab', collection), { ok: true, id: ID, expiresAt: '2026-11-03T00:00:00Z' });
  assert.deepEqual(calls, [['create_folder_link', { link_name: 'Moab', collection }]]);

  const refused = accountWith({ create_folder_link: { data: { ok: false, error: 'That is fifty links today.' }, error: null } });
  assert.deepEqual(await refused.account.createFolderLink('x', collection), { ok: false, reason: 'That is fifty links today.' });

  const signedOut = accountWith({}, { user: null });
  assert.deepEqual(await signedOut.account.createFolderLink('x', collection), { ok: false, reason: 'Sign in to send a link.' });
  assert.deepEqual(signedOut.calls, []);
});

test('folder link: opening one needs no account, and says plainly when it has expired', async () => {
  const geojson = { type: 'FeatureCollection', features: [] };
  const { account } = accountWith({
    open_folder_link: { data: { ok: true, name: 'Moab', geojson, expires_at: 'x' }, error: null },
  }, { user: null });
  assert.deepEqual(await account.openFolderLink(ID), { ok: true, name: 'Moab', geojson, expiresAt: 'x' });

  const gone = accountWith({ open_folder_link: { data: { ok: false, error: 'That link has expired or was taken back.' }, error: null } });
  assert.match((await gone.account.openFolderLink(ID)).reason, /expired/);

  const down = accountWith({ open_folder_link: { data: null, error: { message: 'fetch failed' } } });
  assert.match((await down.account.openFolderLink(ID)).reason, /could not be opened just now/);
});
