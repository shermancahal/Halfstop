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

/*
 * The two shells do not agree on how they serve the app, and only one of them
 * is caught by looking at the scheme.
 *
 * iOS runs at capacitor://localhost. Android runs at https://localhost -
 * Capacitor's own default, and what capacitor.config.json asks for - which is
 * a perfectly good https URL naming the phone it was copied from. Found by
 * asking what Share would do in an Android build before there was one.
 */
test('share: a link from the Android shell is not a link to the phone', () => {
  const url = shareableURL({
    href: 'https://localhost/map.html?b=byways-topo#view=12/38/-79',
    protocol: 'https:',
    site: SITE,
    search: '?b=byways-topo',
    hash: '#view=12/38/-79',
  });
  assert.equal(url, 'https://app.halfstop.app/map.html?b=byways-topo#view=12/38/-79');
  assert.ok(!url.includes('localhost'), 'the link names the device it was copied from');
});

test('share: every way of saying this machine is the same answer', () => {
  // A share link is for somebody else's phone. None of these name anything on
  // it - including a development server, where the link is just as dead.
  for (const [href, protocol] of [
    ['https://localhost/map.html', 'https:'],
    ['https://localhost:8443/map.html', 'https:'],
    ['http://127.0.0.1:8080/map.html', 'http:'],
    ['http://[::1]:8080/map.html', 'http:'],
  ]) {
    assert.equal(shareableURL({ href, protocol, site: SITE }), `${SITE}map.html`, href);
  }
});

test('share: a hostname that merely contains localhost is somebody else\'s site', () => {
  /*
   * The same trap returns.mjs has a test for: a check written as "contains
   * localhost" would rebuild a perfectly good link, and one written as
   * "startsWith" would wave through localhost.evil.example.
   */
  const url = shareableURL({
    href: 'https://localhost.halfstop.app/map.html', protocol: 'https:', site: SITE,
  });
  assert.equal(url, 'https://localhost.halfstop.app/map.html');
});

test('share: something that is not a URL falls back rather than throwing', () => {
  // Nothing should be able to make Share throw: the worst honest answer is a
  // link to the front page, and the worst dishonest one is a stack trace where
  // a link was expected.
  assert.equal(shareableURL({ href: 'not a url', protocol: 'https:', site: SITE }), `${SITE}map.html`);
  assert.equal(shareableURL({ href: '', protocol: 'https:', site: SITE }), `${SITE}map.html`);
});

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
