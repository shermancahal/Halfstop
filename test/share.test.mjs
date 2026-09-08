/**
 * Links that leave the device.
 *
 * The app runs at capacitor://localhost. A link built from that origin is not
 * broken in any way a sender can see - it copies, it pastes, it looks like a
 * URL - and it opens nothing at all on the phone it is sent to. That failure
 * has no error and no symptom on the sending side, which is why it is tested
 * here rather than noticed later.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { shareableURL, readSharedPin, pinLinkParts } from '../assets/js/lib/share.js';

const SITE = 'https://app.halfstop.app/';

test('share: a link from the app points at the site, not at the shell', () => {
  const url = shareableURL({
    href: 'capacitor://localhost/map.html?b=byways-topo#view=12/38/-79',
    protocol: 'capacitor:',
    site: SITE,
    search: '?b=byways-topo',
    hash: '#view=12/38/-79',
  });
  assert.equal(url, 'https://app.halfstop.app/map.html?b=byways-topo#view=12/38/-79');
});

test('share: a link from a browser keeps the browser it was copied from', () => {
  // A preview build must hand out preview links, or testing one means testing
  // production by accident.
  const url = shareableURL({
    href: 'https://shermancahal.github.io/Halfstop/map.html?u=metric',
    protocol: 'https:',
    site: SITE,
    search: '?u=metric',
    hash: '#view=9/40/-80',
  });
  assert.equal(url, 'https://shermancahal.github.io/Halfstop/map.html?u=metric#view=9/40/-80');
});

test('share: the view survives the trip, because it is the whole point', () => {
  const { search, hash } = pinLinkParts({ lon: -79.8456, lat: 38.9231, name: 'Bear Rocks' });
  const url = new URL(shareableURL({
    href: 'capacitor://localhost/map.html', protocol: 'capacitor:', site: SITE, search, hash,
  }));
  assert.equal(url.searchParams.get('p'), '38.923100,-79.845600');
  assert.equal(url.searchParams.get('pn'), 'Bear Rocks');
  assert.equal(url.hash, '#view=14/38.92310/-79.84560');
});

/* ------------------------------------------------- what comes back in */

const pin = (query) => readSharedPin(new URLSearchParams(query));

test('share: a pin read back out is the pin that was sent', () => {
  assert.deepEqual(pin('p=38.923100,-79.845600&pn=Bear Rocks'),
    { lat: 38.9231, lon: -79.8456, name: 'Bear Rocks' });
  assert.deepEqual(pin('p=0,0'), { lat: 0, lon: 0, name: '' }, 'null island is a real place');
});

test('share: a coordinate off the globe is refused, not clamped', () => {
  // Clamping would move the map somewhere plausible and leave it there, which
  // is worse than doing nothing: it looks like the link worked.
  assert.equal(pin('p=91,0'), null, 'past the pole');
  assert.equal(pin('p=0,181'), null, 'past the antimeridian');
  assert.equal(pin('p=NaN,4'), null);
  assert.equal(pin('p=38.9'), null, 'one number is not a place');
  assert.equal(pin('p=1,2,3'), null, 'three is not either');
  assert.equal(pin('pn=Bear Rocks'), null, 'a name with no place is nothing');
  assert.equal(pin(''), null);
});

test('share: a name from somebody else cannot run away with the screen', () => {
  const long = pin(`p=1,2&pn=${'x'.repeat(500)}`);
  assert.equal(long.name.length, 80);
  assert.equal(pin('p=1,2&pn=   ').name, '', 'whitespace is not a name');
});
