import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RV_DEFAULTS, RV_RANGES, RV_CAVEAT,
  parseFeetInches, formatFeetInches, readDimension, showDimension, showWeight,
  normaliseProfile, isRV, routingFor, profileRows, explainFailure,
  shortTonsToTonnes, tonnesToShortTons,
} from '../assets/js/lib/rv.js';

/*
 * Every way somebody writes down what is on the door sticker.
 *
 * Refusing four of five spellings is a field people give up on and then drive
 * without — which is worse than a slightly permissive parser, because the whole
 * feature depends on the number being entered at all.
 */
test('rv: feet and inches, however they were typed', () => {
  const expected = (12 * 0.3048) + (6 * 0.0254);
  for (const input of ['12\'6"', "12' 6\"", '12\'6', '12 ft 6 in', '12-6', '12 6']) {
    const metres = parseFeetInches(input);
    assert.ok(Math.abs(metres - expected) < 1e-9, `${input} gave ${metres}`);
  }
});

test('rv: a bare number is feet, because a clearance sign is feet', () => {
  assert.ok(Math.abs(parseFeetInches('12') - (12 * 0.3048)) < 1e-9);
  assert.ok(Math.abs(parseFeetInches('12.5') - (12.5 * 0.3048)) < 1e-9);
});

/*
 * 12'14" is a typo, not a measurement. Reading it as 13'2" would be guessing
 * which digit the reader got wrong, on the one number where being wrong is a
 * roof against a bridge.
 */
test('rv: an impossible inch count is refused rather than carried', () => {
  assert.equal(parseFeetInches('12\'14"'), null);
  assert.equal(parseFeetInches('12\'99"'), null);
});

/*
 * 12'-3" is not a typo and not a negative: it is how a clearance is written on
 * a drawing and on a good many signs. It was written into this suite as a case
 * to reject, which would have refused a correctly-entered height.
 */
test('rv: the hyphen between feet and inches is notation, not a minus sign', () => {
  const expected = (12 * 0.3048) + (3 * 0.0254);
  assert.ok(Math.abs(parseFeetInches('12\'-3"') - expected) < 1e-9);
});

test('rv: nothing in the field is null, not zero', () => {
  assert.equal(parseFeetInches(''), null);
  assert.equal(parseFeetInches(null), null);
  assert.equal(parseFeetInches('tall'), null);
});

test('rv: metres round-trip back to the feet somebody would say', () => {
  assert.equal(formatFeetInches(parseFeetInches('13\'6"')), '13\' 6"');
  assert.equal(formatFeetInches(parseFeetInches('11\'')), '11\'');
  assert.equal(formatFeetInches(NaN), '');
});

test('rv: the metric reader types metres and gets metres', () => {
  assert.equal(readDimension('3.4', { metric: true }), 3.4);
  assert.equal(readDimension('3.4 m', { metric: true }), 3.4);
  assert.equal(showDimension(3.4, { metric: true }), '3.40 m');
  assert.equal(showDimension(3.4), '11\' 2"');
});

test('rv: weight is short tons on one side and tonnes on the other', () => {
  assert.ok(Math.abs(shortTonsToTonnes(1) - 0.90718474) < 1e-9);
  assert.ok(Math.abs(tonnesToShortTons(shortTonsToTonnes(6.5)) - 6.5) < 1e-9);
  assert.equal(showWeight(5.9, { metric: true }), '5.9 t');
  assert.match(showWeight(5.9), /tons$/);
});

/* ------------------------------------------------------------------ profile */

test('rv: a car is a car, and asks for exactly what it always asked for', () => {
  const routing = routingFor({ kind: 'car', heightM: 4 });
  assert.deepEqual(routing, { costing: 'auto' });
  assert.equal(isRV({ kind: 'car' }), false);
  assert.deepEqual(profileRows({ kind: 'car' }), []);
});

test('rv: an RV asks for truck costing carrying its own dimensions', () => {
  const routing = routingFor({
    kind: 'rv', heightM: 4.11, widthM: 2.6, lengthM: 10.7, weightT: 7.2,
  });
  assert.equal(routing.costing, 'truck');
  assert.deepEqual(routing.costing_options.truck, {
    height: 4.11, width: 2.6, length: 10.7, weight: 7.2, hazmat: false,
  });
});

/*
 * Propane is not a placarded load. Setting hazmat would route people around
 * every tunnel closed to tankers, for no reason, and they would learn to
 * distrust the routing rather than the flag.
 */
test('rv: hazmat stays off, whatever is in the propane locker', () => {
  assert.equal(routingFor({ kind: 'rv' }).costing_options.truck.hazmat, false);
});

/*
 * A decimal point in the wrong place produces a vehicle 34 metres tall, and the
 * router answers that with a confident refusal that reads like a road problem.
 * Out-of-range values fall back rather than travelling.
 */
test('rv: a typo does not reach the router', () => {
  const silly = normaliseProfile({ kind: 'rv', heightM: 34, widthM: 0.2, weightT: 900 });
  assert.equal(silly.heightM, RV_DEFAULTS.heightM);
  assert.equal(silly.widthM, RV_DEFAULTS.widthM);
  assert.equal(silly.weightT, RV_DEFAULTS.weightT);
  // And a value inside the range is left exactly alone.
  assert.equal(normaliseProfile({ kind: 'rv', heightM: 3.9 }).heightM, 3.9);
});

test('rv: anything that is not the word rv is a car', () => {
  assert.equal(normaliseProfile({}).kind, 'car');
  assert.equal(normaliseProfile(null).kind, 'car');
  assert.equal(normaliseProfile({ kind: 'RV' }).kind, 'car');
  assert.equal(normaliseProfile({ kind: 'rv' }).kind, 'rv');
});

/*
 * The panel has to be checkable against the door sticker in four seconds. A
 * row set that said "routed for your RV" could not be checked by the person
 * reading it, which is when a wrong number gets caught.
 */
test('rv: the numbers the router was given are spelled back out', () => {
  const rows = profileRows({ kind: 'rv', heightM: 4.11, widthM: 2.59, lengthM: 10.7, weightT: 7.2 });
  assert.deepEqual(rows.map(([label]) => label), ['Height', 'Width', 'Length', 'Weight']);
  assert.equal(rows[0][1], '13\' 6"');
  assert.equal(rows[1][1], '8\' 6"');
});

/* ------------------------------------------------------------------ honesty */

/*
 * The caveat is the feature. Truck costing reads OpenStreetMap, and most low
 * bridges in the United States carry no maxheight tag — so a clean route is not
 * a checked route, and the wording has to say so in the words a driver acts on.
 */
test('rv: the caveat names the gap rather than waving at it', () => {
  assert.match(RV_CAVEAT, /OpenStreetMap/);
  assert.match(RV_CAVEAT, /not recorded there/);
  assert.match(RV_CAVEAT, /not a promise of clearance/);
  assert.match(RV_CAVEAT, /the sign at the structure as the authority/);
});

test('rv: a failed route means something different for an RV, and says so', () => {
  const car = explainFailure('No path could be found.', { kind: 'car' });
  assert.equal(car, 'No path could be found.');

  const rv = explainFailure('No path could be found.', { kind: 'rv' });
  assert.match(rv, /No path could be found\./);
  assert.match(rv, /recorded limit/);
  assert.match(rv, /Try again as a car/);
});

test('rv: a failure with no message still says something usable', () => {
  assert.match(explainFailure('', { kind: 'car' }), /could not find a way/);
});

test('rv: the ranges are exported so a reader can argue with them', () => {
  for (const [low, high] of Object.values(RV_RANGES)) assert.ok(high > low);
});
