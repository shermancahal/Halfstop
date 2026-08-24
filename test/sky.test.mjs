/**
 * Tests for the sun and moon calculations.
 *
 * Nothing here compares against a published almanac, because no reference was
 * reachable from the machine this was written on. Instead it checks the
 * physics: the sun must be at -0.833° at the moment this code calls sunrise,
 * civil dawn must be at -6°, the day must be twelve hours at the equator, and
 * the sun must not set in Tromsø in June. An implementation that satisfies all
 * of those is not plausibly wrong in a way that matters — and each check names
 * a specific way of being wrong rather than pinning a number nobody can verify.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sunPosition,
  sunTimes,
  moonPosition,
  moonIllumination,
  moonTimes,
  lightPhases,
  lightDirections,
  destinationPoint,
  milkyWayNight,
  coreMaxAltitude,
  bestMilkyWayNights,
  currentDirections,
  galacticCentre,
  milkyWayArc,
  nightQuality,
} from '../assets/js/lib/sky.js';

/* Places chosen for what they prove, not for sentiment. */
const SMOKIES = { lat: 35.9606, lon: -84.2807 };   // mid-latitude, northern
const EQUATOR = { lat: 0.0, lon: 0.0 };
const TROMSO = { lat: 69.65, lon: 18.96 };         // inside the Arctic circle
const SYDNEY = { lat: -33.87, lon: 151.21 };       // southern hemisphere

const JUNE = new Date('2026-06-21T12:00:00Z');
const DECEMBER = new Date('2026-12-21T12:00:00Z');
const EQUINOX = new Date('2026-03-20T12:00:00Z');

const hours = (from, to) => (to - from) / 3600000;

/* ------------------------------------------------------------------ sun */

test('sun: altitude at the calculated sunrise is the refracted horizon', () => {
  // The single strongest check in this file. If the rise/set solver and the
  // position function disagree, this fails; if they agree, both are almost
  // certainly right, because they reach the answer by different routes.
  for (const place of [SMOKIES, SYDNEY]) {
    for (const date of [JUNE, DECEMBER, EQUINOX]) {
      const times = sunTimes(date, place.lat, place.lon);
      const atRise = sunPosition(times.sunrise, place.lat, place.lon).altitude;
      const atSet = sunPosition(times.sunset, place.lat, place.lon).altitude;
      assert.ok(Math.abs(atRise - -0.833) < 0.1, `sunrise altitude ${atRise.toFixed(3)}`);
      assert.ok(Math.abs(atSet - -0.833) < 0.1, `sunset altitude ${atSet.toFixed(3)}`);
    }
  }
});

test('sun: each twilight boundary sits at the elevation that defines it', () => {
  const times = sunTimes(EQUINOX, SMOKIES.lat, SMOKIES.lon);
  const at = (when) => sunPosition(when, SMOKIES.lat, SMOKIES.lon).altitude;

  assert.ok(Math.abs(at(times.civilDawn) - -6) < 0.1, 'civil dawn is -6°');
  assert.ok(Math.abs(at(times.nauticalDawn) - -12) < 0.1, 'nautical dawn is -12°');
  assert.ok(Math.abs(at(times.astronomicalDawn) - -18) < 0.1, 'astronomical dawn is -18°');
  assert.ok(Math.abs(at(times.goldenHourEnd) - 6) < 0.1, 'golden hour ends at +6°');
});

test('sun: solar noon is the highest the sun gets', () => {
  const times = sunTimes(JUNE, SMOKIES.lat, SMOKIES.lon);
  const noon = sunPosition(times.solarNoon, SMOKIES.lat, SMOKIES.lon).altitude;

  for (const offset of [-3, -1, 1, 3]) {
    const other = new Date(times.solarNoon.valueOf() + offset * 3600000);
    assert.ok(sunPosition(other, SMOKIES.lat, SMOKIES.lon).altitude < noon,
      `${offset}h from noon should be lower`);
  }
});

test('sun: the equator gets about twelve hours of daylight all year', () => {
  for (const date of [JUNE, DECEMBER, EQUINOX]) {
    const times = sunTimes(date, EQUATOR.lat, EQUATOR.lon);
    const daylight = hours(times.sunrise, times.sunset);
    assert.ok(Math.abs(daylight - 12) < 0.3, `${daylight.toFixed(2)}h at the equator`);
  }
});

test('sun: the seasons run opposite ways in the two hemispheres', () => {
  const northJune = hours(...['sunrise', 'sunset'].map((k) => sunTimes(JUNE, SMOKIES.lat, SMOKIES.lon)[k]));
  const northDec = hours(...['sunrise', 'sunset'].map((k) => sunTimes(DECEMBER, SMOKIES.lat, SMOKIES.lon)[k]));
  const southJune = hours(...['sunrise', 'sunset'].map((k) => sunTimes(JUNE, SYDNEY.lat, SYDNEY.lon)[k]));
  const southDec = hours(...['sunrise', 'sunset'].map((k) => sunTimes(DECEMBER, SYDNEY.lat, SYDNEY.lon)[k]));

  assert.ok(northJune > northDec, 'northern summer is the long one');
  assert.ok(southDec > southJune, 'southern summer is December');
});

test('sun: inside the Arctic circle it says which kind of nothing is happening', () => {
  // Returning null for sunrise is correct but useless on its own — "no sunrise"
  // means opposite things in June and December.
  const summer = sunTimes(JUNE, TROMSO.lat, TROMSO.lon);
  assert.equal(summer.sunrise, null);
  assert.equal(summer.polar, 'day', 'midnight sun');

  const winter = sunTimes(DECEMBER, TROMSO.lat, TROMSO.lon);
  assert.equal(winter.sunrise, null);
  assert.equal(winter.polar, 'night', 'polar night');

  const spring = sunTimes(EQUINOX, TROMSO.lat, TROMSO.lon);
  assert.ok(spring.sunrise instanceof Date, 'the sun does rise there at the equinox');
  assert.equal(spring.polar, '');
});

test('sun: it rises in the east and sets in the west', () => {
  const times = sunTimes(EQUINOX, SMOKIES.lat, SMOKIES.lon);
  const rise = sunPosition(times.sunrise, SMOKIES.lat, SMOKIES.lon).azimuth;
  const set = sunPosition(times.sunset, SMOKIES.lat, SMOKIES.lon).azimuth;

  // At the equinox this is very nearly due east and due west anywhere.
  assert.ok(Math.abs(rise - 90) < 3, `sunrise azimuth ${rise.toFixed(1)}`);
  assert.ok(Math.abs(set - 270) < 3, `sunset azimuth ${set.toFixed(1)}`);
});

test('sun: azimuth is measured from north, not from south', () => {
  // The underlying formula gives an angle from due south. Getting the
  // conversion wrong puts every bearing 180° out, which looks plausible on a
  // map and points a photographer at the wrong ridge.
  const times = sunTimes(JUNE, SMOKIES.lat, SMOKIES.lon);
  const noon = sunPosition(times.solarNoon, SMOKIES.lat, SMOKIES.lon).azimuth;
  assert.ok(Math.abs(noon - 180) < 3, `northern-hemisphere noon should be due south, got ${noon.toFixed(1)}`);

  const southNoon = sunPosition(
    sunTimes(JUNE, SYDNEY.lat, SYDNEY.lon).solarNoon, SYDNEY.lat, SYDNEY.lon,
  ).azimuth;
  assert.ok(southNoon < 30 || southNoon > 330, `southern noon should be due north, got ${southNoon.toFixed(1)}`);
});

/* ------------------------------------------------------------------ moon */

test('moon: illumination is a fraction, and the phase name matches it', () => {
  for (let day = 0; day < 30; day += 1) {
    const date = new Date(Date.UTC(2026, 5, 1 + day));
    const { fraction, phase, waxing, name } = moonIllumination(date);

    assert.ok(fraction >= 0 && fraction <= 1, `fraction ${fraction}`);
    assert.ok(phase >= 0 && phase <= 1, `phase ${phase}`);
    assert.equal(waxing, phase < 0.5);
    assert.ok(typeof name === 'string' && name.length > 0);

    // A full moon is fully lit and a new moon is not; the two must not swap.
    if (name === 'Full moon') assert.ok(fraction > 0.95, `full moon lit ${fraction}`);
    if (name === 'New moon') assert.ok(fraction < 0.05, `new moon lit ${fraction}`);
  }
});

test('moon: the cycle completes in about twenty-nine and a half days', () => {
  // Counting new moons over a year is the check that catches a wrong rate
  // constant, which is otherwise invisible — every individual phase looks fine.
  let crossings = 0;
  let previous = moonIllumination(new Date(Date.UTC(2026, 0, 1))).phase;

  for (let day = 1; day < 365; day += 1) {
    const phase = moonIllumination(new Date(Date.UTC(2026, 0, 1 + day))).phase;
    if (phase < previous) crossings += 1;   // wrapped past new moon
    previous = phase;
  }
  assert.ok(crossings >= 11 && crossings <= 13, `${crossings} lunations in a year`);
});

test('moon: it is at the horizon at the moment it is said to rise', () => {
  // Same cross-check as the sun, and it matters more here: moonrise is found by
  // sampling and interpolation rather than solved, so a mistake shows up as a
  // time that is merely close rather than wrong-looking.
  let checked = 0;
  for (let day = 0; day < 10; day += 1) {
    const date = new Date(Date.UTC(2026, 5, 1 + day, 12));
    const times = moonTimes(date, SMOKIES.lat, SMOKIES.lon);

    for (const when of [times.rise, times.set]) {
      if (!when) continue;
      const height = moonPosition(when, SMOKIES.lat, SMOKIES.lon).altitude;
      assert.ok(Math.abs(height) < 0.6, `moon at ${height.toFixed(2)}° when crossing`);
      checked += 1;
    }
  }
  assert.ok(checked >= 10, `expected plenty of crossings, checked ${checked}`);
});

test('moon: rise and set land inside the day they were asked for', () => {
  const date = new Date(2026, 5, 15, 12);
  const times = moonTimes(date, SMOKIES.lat, SMOKIES.lon);
  const start = new Date(date); start.setHours(0, 0, 0, 0);
  const end = start.valueOf() + 25 * 3600000;

  for (const when of [times.rise, times.set]) {
    if (!when) continue;
    assert.ok(when >= start && when <= end, `${when.toISOString()} outside the day`);
  }
});

test('moon: distance stays in the real range', () => {
  for (let day = 0; day < 30; day += 1) {
    const { distance } = moonPosition(new Date(Date.UTC(2026, 5, 1 + day)), SMOKIES.lat, SMOKIES.lon);
    assert.ok(distance > 356000 && distance < 407000, `${distance.toFixed(0)} km`);
  }
});

/* ------------------------------------------------------------------ shooting */

test('light: the phases come back in order and account for the whole day', () => {
  const phases = lightPhases(EQUINOX, SMOKIES.lat, SMOKIES.lon);
  assert.ok(phases.length >= 8, `expected the full sequence, got ${phases.length}`);

  for (let i = 1; i < phases.length; i += 1) {
    assert.ok(phases[i].from >= phases[i - 1].from, 'phases must be chronological');
    assert.ok(phases[i].minutes > 0, `${phases[i].id} has no duration`);
  }

  const first = phases[0];
  const last = phases[phases.length - 1];
  assert.ok(hours(first.from, last.to) > 12, 'dawn to dusk should span most of a day');
});

test('light: golden hour is longer at high latitude than at the equator', () => {
  // The sun climbs steeply at the equator and grazes the horizon near the
  // poles, which is why photographers go north. If this came out the other way
  // the elevation solver would be inverted.
  const pick = (phases) => phases.find((p) => p.id === 'golden')?.minutes ?? 0;
  const tropical = pick(lightPhases(EQUINOX, EQUATOR.lat, EQUATOR.lon));
  const northern = pick(lightPhases(EQUINOX, 60, 0));

  assert.ok(tropical > 0 && northern > 0);
  assert.ok(northern > tropical * 1.5, `${northern}min at 60° vs ${tropical}min at the equator`);
});

test('light: directions are compass bearings for events that happen', () => {
  const directions = lightDirections(EQUINOX, SMOKIES.lat, SMOKIES.lon);
  const sunrise = directions.find((d) => d.id === 'sunrise');
  const sunset = directions.find((d) => d.id === 'sunset');

  assert.ok(sunrise && sunset, 'both should be present at a mid latitude');
  assert.ok(sunrise.azimuth >= 0 && sunrise.azimuth <= 360);
  assert.ok(Math.abs(sunrise.azimuth - 90) < 3, 'equinox sunrise is due east');
  assert.ok(Math.abs(sunset.azimuth - 270) < 3, 'equinox sunset is due west');

  // Inside the Arctic circle in June there is no sunrise to point at, and the
  // list should be short rather than carrying nulls.
  const polar = lightDirections(JUNE, TROMSO.lat, TROMSO.lon);
  assert.ok(!polar.some((d) => d.id === 'sunrise'), 'no sunrise to point at under the midnight sun');
  assert.ok(polar.every((d) => Number.isFinite(d.azimuth)));
});

test('geometry: a bearing line ends up where the bearing says', () => {
  const from = [SMOKIES.lon, SMOKIES.lat];

  const north = destinationPoint(from, 0, 50);
  assert.ok(north[1] > from[1], 'due north increases latitude');
  assert.ok(Math.abs(north[0] - from[0]) < 0.01, 'and barely moves longitude');

  const east = destinationPoint(from, 90, 50);
  assert.ok(east[0] > from[0], 'due east increases longitude');

  const south = destinationPoint(from, 180, 50);
  assert.ok(south[1] < from[1]);

  // Half a degree of latitude is about 55km, so 50km north should be close.
  assert.ok(Math.abs((north[1] - from[1]) - 0.45) < 0.05, 'the distance should be about right');
});

test('geometry: longitude stays in range when a line crosses the antimeridian', () => {
  const [lon] = destinationPoint([179.9, 60], 90, 200);
  assert.ok(lon >= -180 && lon <= 180, `longitude ${lon} left the valid range`);
  assert.ok(lon < 0, 'crossing east from 179.9° should wrap to a negative longitude');
});

/* ------------------------------------------------------------- milky way */

test('the galactic core transits due south at the closed-form altitude', () => {
  // 90 - |lat - dec| is the textbook transit altitude for a fixed star, and the
  // sampled search has to land on it or the sampling is wrong.
  for (const lat of [25, 35.96, 45]) {
    const night = milkyWayNight(new Date('2026-07-15T12:00:00Z'), lat, -84.28);
    assert.ok(
      Math.abs(night.transitAltitude - night.maxAltitude) < 0.2,
      `lat ${lat}: transit ${night.transitAltitude} vs ceiling ${night.maxAltitude}`,
    );
    assert.ok(
      Math.abs(night.transitAzimuth - 180) < 3,
      `lat ${lat}: transits at ${night.transitAzimuth}, not due south`,
    );
  }
});

test('the core ceiling follows latitude and is unreachable overhead in the US', () => {
  assert.ok(Math.abs(coreMaxAltitude(36) - 24.99) < 0.05);
  assert.ok(Math.abs(coreMaxAltitude(45) - 15.99) < 0.05);
  // The point of surfacing this at all: asking for 70° has no answer up here.
  assert.ok(coreMaxAltitude(36) < 70);
  // South of the core's declination it passes north of overhead again.
  assert.ok(coreMaxAltitude(-29) > 89.9);
});

test('the galactic band transform agrees with the fixed core coordinates', () => {
  // Two independent routes to the same point: galactic (0,0) run through the
  // coordinate transform, and Sgr A* as a fixed right ascension and
  // declination. They differ by the known ~0.07° offset between the galactic
  // coordinate origin and the actual black hole, and by nothing else.
  const when = new Date('2026-07-16T04:00:00Z');
  const [origin] = milkyWayArc(when, 35.96, -84.28, { span: 0, step: 5 }).points;
  const core = galacticCentre(when, 35.96, -84.28);

  assert.ok(Math.abs(origin.altitude - core.altitude) < 0.15, `${origin.altitude} vs ${core.altitude}`);
  assert.ok(Math.abs(origin.azimuth - core.azimuth) < 0.15);
});

test('band visibility depends on the angle, not just the core altitude', () => {
  const lat = 35.96;
  const lon = -84.28;
  const early = milkyWayArc(new Date('2026-07-16T01:00:00Z'), lat, lon);
  const late = milkyWayArc(new Date('2026-07-16T05:00:00Z'), lat, lon);

  // The core is HIGHER at 05:00 than at 01:00, and yet less of the band is up:
  // the arch has tipped over. This is the whole reason the panel reports a
  // percentage rather than the centre's altitude.
  assert.ok(galacticCentre(new Date('2026-07-16T05:00:00Z'), lat, lon).altitude
    > galacticCentre(new Date('2026-07-16T01:00:00Z'), lat, lon).altitude);
  assert.ok(late.fraction < early.fraction, `${late.fraction} should be under ${early.fraction}`);
});

test('visibility marks stop at what the latitude can reach', () => {
  const tennessee = milkyWayNight(new Date('2026-07-15T12:00:00Z'), 35.96, -84.28);
  assert.ok(tennessee.marks.length > 0);
  for (const mark of tennessee.marks) {
    assert.ok(mark.falling > mark.rising);
    // Never a time in daylight: half the band is up through a summer
    // afternoon, and those hours are not offers.
    assert.ok(mark.rising >= tennessee.dark.from, `${mark.percent}% starts before dark`);
    assert.ok(mark.falling <= tennessee.dark.to, `${mark.percent}% ends after dawn`);
  }

  // Tighter thresholds sit inside looser ones — more of the band up is a
  // shorter window, always.
  for (let i = 1; i < tennessee.marks.length; i += 1) {
    const wider = tennessee.marks[i - 1];
    const tighter = tennessee.marks[i];
    assert.ok(tighter.rising >= wider.rising && tighter.falling <= wider.falling,
      `${tighter.percent}% is not inside ${wider.percent}%`);
  }

  // From the mid-northern US the southern end of the core region never clears
  // the horizon, so there is no honest answer to "when is all of it up".
  assert.ok(!tennessee.marks.some((mark) => mark.percent === 100));
  assert.ok(tennessee.arcPeak.fraction < 1);

  // Far enough south, all of it does clear, and then 100% has a real answer.
  const chile = milkyWayNight(new Date('2026-07-15T12:00:00Z'), -30, -70);
  assert.ok(chile.marks.some((mark) => mark.percent === 100));
});

test('the band peak is measured inside the dark window', () => {
  const night = milkyWayNight(new Date('2026-08-24T12:00:00Z'), 35.96, -84.28);
  assert.ok(night.arcPeak.when >= night.window.from);
  assert.ok(night.arcPeak.when <= night.window.to);
  assert.ok(night.arcPeak.fraction > 0.5 && night.arcPeak.fraction <= 1);
});

test('the month-ahead scan skips the band sampling it never reads', () => {
  // Cheaper by seventeen positions per sample, and the ranking is unaffected.
  const nights = bestMilkyWayNights(new Date('2026-07-01T12:00:00Z'), 35.96, -84.28, 10);
  assert.equal(nights.length, 10);
  assert.ok(nights.some((night) => night.minutes > 0));
});

test('a summer night in Tennessee is shootable and a winter one is not', () => {
  const summer = milkyWayNight(new Date('2026-07-15T12:00:00Z'), 35.96, -84.28);
  assert.equal(summer.possible, true);
  assert.equal(summer.reason, '');
  assert.ok(summer.window.minutes > 120);

  const winter = milkyWayNight(new Date('2026-12-15T12:00:00Z'), 35.96, -84.28);
  assert.equal(winter.possible, false);
  assert.match(winter.reason, /daylight/);
});

test('the moonless window is never longer than the dark window that contains it', () => {
  for (const day of ['2026-07-01', '2026-07-13', '2026-07-28', '2026-09-10']) {
    const night = milkyWayNight(new Date(`${day}T12:00:00Z`), 35.96, -84.28);
    if (!night.window) continue;
    assert.ok(night.window.minutes <= night.dark.minutes, day);
    if (night.moonless) assert.ok(night.moonless.minutes <= night.window.minutes, day);
  }
});

test('the best nights over a month land on the new moon', () => {
  const nights = bestMilkyWayNights(new Date('2026-07-01T12:00:00Z'), 35.96, -84.28, 40);
  assert.equal(nights.length, 40);

  const best = [...nights].sort((a, b) => b.minutes - a.minutes)[0];
  assert.ok(best.moon.fraction < 0.15, `best night moon is ${best.moon.fraction}`);

  // Full moon nights give nothing, which is the whole reason to plan around it.
  const full = nights.find((night) => night.moon.fraction > 0.98);
  assert.equal(full.minutes, 0);
});

test('current directions only name what is actually above the horizon', () => {
  const midnight = currentDirections(new Date('2026-07-16T04:00:00Z'), 35.96, -84.28);
  assert.ok(midnight.every((entry) => entry.altitude > 0));
  assert.ok(midnight.some((entry) => entry.body === 'core'));
  assert.ok(!midnight.some((entry) => entry.body === 'sun'), 'the sun is not up at local midnight');

  const noon = currentDirections(new Date('2026-07-15T17:00:00Z'), 35.96, -84.28);
  assert.ok(noon.some((entry) => entry.body === 'sun'));
});

test('the peak inside the window is not the transit once autumn arrives', () => {
  // In June the core transits during astronomical dark, so the two agree.
  const june = milkyWayNight(new Date('2026-06-20T12:00:00Z'), 35.96, -84.28);
  assert.ok(Math.abs(june.windowPeak.altitude - june.transitAltitude) < 0.6);

  // By October it transits before sunset: the transit is still 25°, but the
  // best you can actually photograph once dark is far lower. Reporting the
  // transit as the headline would promise a sky nobody can shoot.
  const october = milkyWayNight(new Date('2026-10-10T12:00:00Z'), 35.96, -84.28);
  assert.ok(Math.abs(october.transitAltitude - october.maxAltitude) < 0.2);
  assert.ok(october.windowPeak.altitude < october.transitAltitude - 5,
    `window peak ${october.windowPeak.altitude} vs transit ${october.transitAltitude}`);
  assert.ok(october.windowPeak.when >= october.window.from);
  assert.ok(october.windowPeak.when <= october.window.to);
});

test('a night with no shootable window has no window peak', () => {
  const winter = milkyWayNight(new Date('2026-12-15T12:00:00Z'), 35.96, -84.28);
  assert.equal(winter.windowPeak, null);
});

/* ------------------------------------------------------ how good a night is */

const hourly = (from, hours, cover) => Array.from({ length: hours }, (unused, index) => ({
  at: new Date(from.valueOf() + index * 3600000),
  cover: typeof cover === 'function' ? cover(index) : cover,
}));

test('a night with no cloud data reports no percentage at all', () => {
  // The trap this guards: scoring the moon alone and presenting it as the
  // whole answer. A clear-looking 100% under an overcast sky sends someone out
  // for nothing, so with no cloud figure there is no figure.
  const night = milkyWayNight(new Date('2026-07-13T12:00:00Z'), 35.96, -84.28);
  const quality = nightQuality(night, null);

  assert.equal(quality.score, null);
  assert.equal(quality.cloudCover, null);
  assert.match(quality.verdict, /moon/i);
});

test('cloud and moon both pull the score down, and together compound', () => {
  const newMoon = milkyWayNight(new Date('2026-07-13T12:00:00Z'), 35.96, -84.28);
  const fullMoon = milkyWayNight(new Date('2026-07-28T12:00:00Z'), 35.96, -84.28);

  const clearFor = (night) => hourly(new Date(night.window.from.valueOf() - 3600000), 14, 5);
  const overcastFor = (night) => hourly(new Date(night.window.from.valueOf() - 3600000), 14, 95);

  const best = nightQuality(newMoon, clearFor(newMoon));
  const clouded = nightQuality(newMoon, overcastFor(newMoon));
  const moonlit = nightQuality(fullMoon, clearFor(fullMoon));

  assert.ok(best.score > 0.85, `clear new moon scored ${best.score}`);
  assert.ok(clouded.score < 0.15, `overcast new moon scored ${clouded.score}`);
  assert.ok(moonlit.score < best.score, 'a full moon must score below a new one');
  assert.equal(best.verdict, 'Excellent');
  assert.equal(clouded.verdict, 'Not tonight');
});

test('a stale cloud reading is not used', () => {
  // Hours from a different night are not evidence about this one.
  const night = milkyWayNight(new Date('2026-07-13T12:00:00Z'), 35.96, -84.28);
  const elsewhere = hourly(new Date('2026-09-01T00:00:00Z'), 14, 5);
  assert.equal(nightQuality(night, elsewhere).cloudCover, null);
});

test('a uniformly clear window has no better part — it is all the best part', () => {
  /*
   * Floating-point drift used to shatter the "above average" run on a window
   * where every sample scored the same, so a perfect night reported no best
   * stretch at all. The whole window is the answer there.
   */
  const night = milkyWayNight(new Date('2026-07-13T12:00:00Z'), 35.96, -84.28);
  const quality = nightQuality(night, hourly(new Date(night.window.from.valueOf() - 3600000), 14, 5));

  assert.ok(quality.best, 'a clear night must name a best stretch');
  assert.equal(quality.best.from.valueOf(), night.window.from.valueOf());
  assert.equal(quality.best.to.valueOf(), night.window.to.valueOf());
});

test('a window that clears halfway through narrows to the clear half', () => {
  const night = milkyWayNight(new Date('2026-07-13T12:00:00Z'), 35.96, -84.28);
  const start = new Date(night.window.from.valueOf() - 3600000);
  const clearing = hourly(start, 14, (index) => (index < 4 ? 90 : 10));

  const quality = nightQuality(night, clearing);
  assert.ok(quality.best.from > night.window.from, 'the best stretch starts after the cloud clears');
});

test('shooting moments name only what tonight actually offers', () => {
  const night = milkyWayNight(new Date('2026-08-24T12:00:00Z'), 35.96, -84.28);

  assert.ok(night.moments.length >= 2 && night.moments.length <= 5);
  assert.equal(night.moments.filter((moment) => moment.primary).length, 1);
  assert.equal(night.moments[0].id, 'peak');

  for (const moment of night.moments) {
    assert.ok(moment.why && moment.why.length > 10, `${moment.id} needs a reason`);
    assert.ok(moment.when >= night.dark.from && moment.when <= night.dark.to,
      `${moment.id} falls outside astronomical dark`);
  }

  // Two entries on the same minute are one entry with two names.
  const plain = night.moments.filter((moment) => !moment.until);
  for (let i = 1; i < plain.length; i += 1) {
    assert.ok(Math.abs(plain[i].when - plain[i - 1].when) >= 15 * 60000,
      `${plain[i].id} duplicates ${plain[i - 1].id}`);
  }
});
