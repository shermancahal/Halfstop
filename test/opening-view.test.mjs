/**
 * Opening the map where the reader is.
 *
 * Two pure pieces decide this between them: whether the link already named a
 * view, and how far to zoom once a fix comes back. The rest of it - asking the
 * browser, waiting, standing down when somebody starts panning - is wired in
 * viewer.js and covered by the smoke suite, which can drive a real map with a
 * real geolocation answer.
 *
 * These two are here because both are easy to get wrong in a way nothing
 * visible reports: a view check that says yes to every link disables the
 * feature outright, and a zoom that ignores accuracy draws an IP-derived
 * guess as though it were a GPS fix.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { linkCarriesView } from '../assets/js/lib/share.js';
import { zoomForAccuracy } from '../assets/js/lib/geo.js';

test('a link carries a view only when it actually names one', () => {
  assert.equal(linkCarriesView('#view=8/35.96/-84.28'), true);
  assert.equal(linkCarriesView('#view=8/35.96/-84.28&other=1'), true);
  assert.equal(linkCarriesView('view=8/35.96/-84.28'), true, 'the leading # is optional');
});

test('a link with no view, or a hash that is not one, does not count', () => {
  // The failure this exists to prevent: any of these read as a view would
  // switch the opening camera off for everybody, silently and forever.
  for (const hash of ['', '#', undefined, null, '#photos', '#viewer=1', '#overview', '#preview=2']) {
    assert.equal(linkCarriesView(hash), false, `${JSON.stringify(hash)} counted as a view`);
  }
});

test('a good fix zooms in as far as the cap allows', () => {
  // Anything a phone outdoors reports - metres to a few hundred metres - is
  // better than the cap needs, so all of it lands on the cap.
  for (const accuracy of [5, 20, 65, 200, 500]) {
    assert.equal(zoomForAccuracy(accuracy, 35.96, 640), 12, `${accuracy} m did not reach the cap`);
  }
});

test('a vague fix is drawn as vague', () => {
  // The IP-address case. 30 km of accuracy at street zoom would name a
  // neighbourhood the reader may be nowhere near.
  const ip = zoomForAccuracy(30000, 35.96, 640);
  assert.ok(ip < 12, `30 km of accuracy still zoomed to ${ip}`);
  assert.ok(ip > 8, `30 km of accuracy zoomed out to ${ip}, which is most of a continent`);

  // And it keeps backing off as the fix gets worse.
  assert.ok(zoomForAccuracy(100000, 35.96, 640) < ip);
  assert.ok(zoomForAccuracy(2000000, 35.96, 640) < zoomForAccuracy(100000, 35.96, 640));
});

test('the accuracy circle covers about half the viewport', () => {
  // The rule the formula is written to: the radius takes a quarter of the
  // smaller side. Checked in metres on the ground rather than by repeating
  // the arithmetic, which would only prove the formula equals itself.
  const accuracy = 30000;
  const latitude = 35.96;
  const side = 640;
  const zoom = zoomForAccuracy(accuracy, latitude, side);

  const metresPerPixel = 156543.03392 * Math.cos(latitude * Math.PI / 180) / 2 ** zoom;
  const radiusInPixels = accuracy / metresPerPixel;
  assert.ok(
    Math.abs(radiusInPixels - side / 4) < 1,
    `the accuracy radius drew ${radiusInPixels.toFixed(1)}px of a ${side}px map`,
  );
});

test('a narrow phone zooms out further than a wide desktop', () => {
  // Same fix, less room to draw it in.
  const phone = zoomForAccuracy(30000, 35.96, 390);
  const desktop = zoomForAccuracy(30000, 35.96, 1100);
  assert.ok(phone < desktop, `phone ${phone} was not further out than desktop ${desktop}`);
});

test('a Mercator pixel shrinks with latitude, and the zoom follows', () => {
  // The same accuracy in metres covers more pixels the further north it is,
  // so the zoom has to back off to keep the circle the same size on screen.
  assert.ok(zoomForAccuracy(30000, 65, 640) < zoomForAccuracy(30000, 5, 640));
});

test('a missing or nonsense accuracy falls back to the cap rather than to NaN', () => {
  // A fix with no accuracy is still a fix. Returning NaN here would hand
  // jumpTo a NaN zoom, which blanks the map.
  for (const accuracy of [undefined, null, NaN, 0, -1, Infinity, '30000']) {
    const zoom = zoomForAccuracy(accuracy, 35.96, 640);
    assert.ok(Number.isFinite(zoom), `${accuracy} produced ${zoom}`);
    assert.equal(zoom, 12, `${accuracy} did not fall back to the cap`);
  }
});

test('a nonsense latitude or viewport still produces a usable zoom', () => {
  for (const latitude of [undefined, NaN, 91, -91, 'north']) {
    assert.ok(Number.isFinite(zoomForAccuracy(30000, latitude, 640)), `latitude ${latitude}`);
  }
  for (const side of [0, -50, NaN, undefined]) {
    assert.ok(Number.isFinite(zoomForAccuracy(30000, 35.96, side)), `viewport ${side}`);
  }
});

test('the zoom never exceeds the cap or drops off the scale', () => {
  for (const accuracy of [1, 10, 1e3, 1e5, 1e7, 1e9]) {
    const zoom = zoomForAccuracy(accuracy, 35.96, 640);
    assert.ok(zoom <= 12 && zoom >= 1, `${accuracy} m produced ${zoom}`);
  }
});
