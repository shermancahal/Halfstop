import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FOG, fromDepression, fogHour, fogName, fogNote, fogBand, fogOutlook, nightHours,
} from '../assets/js/lib/fog.js';

/*
 * A clear, still, cold night with the air near saturation — the textbook
 * radiation-fog setup, and the base every case below varies one ingredient of.
 */
const RADIATION = {
  temperatureC: 6, dewpointC: 5.5, windKmh: 4, skyPercent: 5, night: true,
};

test('fog: saturation is the dominant term', () => {
  assert.ok(fromDepression(0.2) > fromDepression(1.5));
  assert.ok(fromDepression(1.5) > fromDepression(3));
  assert.ok(fromDepression(3) > fromDepression(9));
  // A depression the model has no band for still answers, low.
  assert.ok(fromDepression(20) > 0);
  assert.equal(fromDepression(NaN), 0);
});

test('fog: the textbook radiation night reads as likely', () => {
  const hour = fogHour(RADIATION);
  assert.equal(hour.kind, 'radiation');
  assert.equal(fogBand(hour.chance), 'likely');
  assert.equal(hour.freezing, false);
  assert.match(hour.why, /clear sky/);
});

/*
 * The counter-intuitive rule, and the reason it is worth a test of its own: a
 * dead calm night makes dew, not fog, because nothing lifts the cooling off the
 * grass. A model that only ever rewarded stillness would call every calm night
 * foggy — which is the failure mode this rule exists to avoid.
 */
test('fog: dead calm scores below a light stir, at the same saturation', () => {
  const stirred = fogHour(RADIATION);
  const calm = fogHour({ ...RADIATION, windKmh: 0.5 });
  assert.equal(calm.kind, 'radiation');
  assert.ok(calm.chance < stirred.chance,
    `calm ${calm.chance} should be under stirred ${stirred.chance}`);
});

test('fog: cloud over the top stops it forming in place', () => {
  const clouded = fogHour({ ...RADIATION, skyPercent: 90 });
  assert.notEqual(clouded.kind, 'radiation');
  assert.ok(clouded.chance < fogHour(RADIATION).chance);
});

test('fog: daylight rules out radiation fog, whatever else is right', () => {
  const day = fogHour({ ...RADIATION, night: false });
  assert.notEqual(day.kind, 'radiation');
});

test('fog: saturated air in a gale is not fog', () => {
  const gale = fogHour({ ...RADIATION, windKmh: 45, night: false });
  assert.equal(gale.kind, 'none');
  assert.ok(gale.chance <= 20);
  assert.match(gale.why, /too windy/);
});

test('fog: moist air on the move reads as advection, day or night', () => {
  const moving = fogHour({
    temperatureC: 8, dewpointC: 7.6, windKmh: 18, skyPercent: 80, night: false,
  });
  assert.equal(moving.kind, 'advection');
  assert.match(moving.why, /moving at 18 km\/h/);
});

/*
 * Advection is held below radiation at the same saturation on purpose: whether
 * the ground downwind is colder than the air over it decides advection fog, and
 * the feed does not say. If a change ever makes them equal, this fails.
 */
test('fog: advection is scored less confidently than radiation', () => {
  /*
   * Against the depression band itself, not against a radiation hour. Compared
   * with a radiation hour this passed on the clear-sky bonus alone — the
   * discount could be deleted outright and the test stayed green, which is a
   * test confirming rather than discriminating.
   */
  const moving = fogHour({ ...RADIATION, windKmh: 18, night: false, skyPercent: 80 });
  assert.equal(moving.kind, 'advection');
  assert.ok(moving.chance < fromDepression(RADIATION.temperatureC - RADIATION.dewpointC),
    `advection ${moving.chance} should sit under its own depression band`);
});

test('fog: at or below freezing it is named for what it does to you', () => {
  const icy = fogHour({ ...RADIATION, temperatureC: -3, dewpointC: -3.3 });
  assert.equal(icy.freezing, true);
  assert.equal(icy.kind, 'radiation');
  assert.equal(fogName(icy), 'Freezing ground fog');
  assert.match(fogNote(icy), /ice on the road/);
});

test('fog: a missing ingredient is said, not guessed at', () => {
  const gap = fogHour({ ...RADIATION, dewpointC: null });
  assert.equal(gap.chance, null);
  assert.equal(fogBand(gap.chance), 'unknown');
  assert.match(gap.why, /missing an ingredient/);
});

/*
 * The one place a real forecast of fog exists overrules the model. Both
 * directions are checked, because only overruling upward would let a grid that
 * forecasts ten kilometres of visibility still be reported as foggy.
 */
test('fog: a published visibility beats the model, in both directions', () => {
  const dry = { temperatureC: 20, dewpointC: 4, windKmh: 3, skyPercent: 0, night: true };
  const overruledUp = fogHour({ ...dry, visibilityM: 400 });
  assert.ok(overruledUp.chance >= 85);
  assert.equal(overruledUp.forecast, true);
  assert.match(overruledUp.why, /visibility forecast at 400 m/);

  const overruledDown = fogHour({ ...RADIATION, visibilityM: 12000 });
  assert.equal(overruledDown.kind, 'none');
  assert.ok(overruledDown.chance <= 10);
  assert.equal(overruledDown.forecast, true);
});

test('fog: a visibility in between leaves the model alone', () => {
  const model = fogHour(RADIATION);
  const middling = fogHour({ ...RADIATION, visibilityM: 3000 });
  assert.equal(middling.chance, model.chance);
  assert.equal(middling.forecast, false);
});

/* ------------------------------------------------------------------ outlook */

const at = (hoursFromNow, base) => new Date(base.valueOf() + hoursFromNow * 3600000);

test('fog: the outlook reports the run around the peak, not every hour over a line', () => {
  const now = new Date('2026-10-12T18:00:00Z');
  const dry = { temperatureC: 15, dewpointC: 4, windKmh: 4, skyPercent: 5, night: true };
  const wet = { ...RADIATION };

  const hours = [
    { at: at(0, now), ...dry },
    { at: at(1, now), ...dry },
    // First foggy run, tonight.
    { at: at(2, now), ...wet },
    { at: at(3, now), ...wet, dewpointC: 5.9 },
    { at: at(4, now), ...wet },
    { at: at(5, now), ...dry },
    { at: at(6, now), ...dry },
    // A second run tomorrow, which must not be joined to the first.
    { at: at(20, now), ...wet },
  ];

  const outlook = fogOutlook(hours, { now });
  assert.equal(outlook.ok, true);
  assert.equal(outlook.hours, 3);
  assert.equal(outlook.from.valueOf(), at(2, now).valueOf());
  assert.equal(outlook.to.valueOf(), at(4, now).valueOf());
  assert.ok(outlook.peak.chance >= 70);
});

test('fog: hours already past and beyond the horizon are dropped', () => {
  const now = new Date('2026-10-12T18:00:00Z');
  const hours = [
    { at: at(-8, now), ...RADIATION },
    { at: at(3, now), ...RADIATION },
    { at: at(100, now), ...RADIATION },
  ];
  const outlook = fogOutlook(hours, { now, horizonHours: 36 });
  assert.equal(outlook.rows.length, 1);
  assert.equal(outlook.rows[0].at.valueOf(), at(3, now).valueOf());
});

test('fog: nothing in range is said rather than answered', () => {
  assert.equal(fogOutlook([], { now: new Date() }).ok, false);
  assert.equal(fogOutlook(null).ok, false);
});

test('fog: a run with no usable ingredients reports why, and keeps the rows', () => {
  const now = new Date('2026-10-12T18:00:00Z');
  const outlook = fogOutlook([{ at: at(1, now), temperatureC: null }], { now });
  assert.equal(outlook.ok, false);
  assert.equal(outlook.rows.length, 1);
  assert.match(outlook.reason, /missing/);
});

/* ------------------------------------------------------------------ night */

/*
 * The hour after midnight belongs to the night that started the evening before,
 * which is the case a per-day sunrise/sunset comparison gets wrong if it is
 * asked about the wrong day. nightHours asks each hour about its own date.
 */
test('fog: night is decided per hour, across a date boundary', () => {
  const sunTimes = (date) => ({
    sunrise: new Date(`${date.toISOString().slice(0, 10)}T12:00:00Z`),
    sunset: new Date(`${date.toISOString().slice(0, 10)}T23:00:00Z`),
  });
  const hours = [
    { at: new Date('2026-10-12T20:00:00Z') },   // afternoon, before sunset
    { at: new Date('2026-10-12T23:30:00Z') },   // after sunset
    { at: new Date('2026-10-13T03:00:00Z') },   // small hours of the next date
    { at: new Date('2026-10-13T15:00:00Z') },   // after that date's sunrise
  ];
  assert.deepEqual(nightHours(hours, 36, -84, sunTimes).map((h) => h.night),
    [false, true, true, false]);
});

test('fog: polar day and polar night are answered without comparing times', () => {
  const hours = [{ at: new Date('2026-06-21T03:00:00Z') }];
  assert.equal(nightHours(hours, 78, 15, () => ({ polar: 'day' }))[0].night, false);
  assert.equal(nightHours(hours, 78, 15, () => ({ polar: 'night' }))[0].night, true);
});

test('fog: the thresholds are exported so a reader can argue with them', () => {
  assert.ok(FOG.radiationWindKmh > FOG.calmKmh);
  assert.ok(FOG.advectionWindKmh[1] > FOG.advectionWindKmh[0]);
  assert.ok(FOG.visibilityClearM > FOG.visibilityFogM);
});
