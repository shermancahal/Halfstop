/**
 * Where the sun and moon are, and when.
 *
 * This exists because the crude sunrise/sunset the details panel had was enough
 * to answer "how long until dark" and nothing else. A photographer needs more
 * and needs it precise: when blue hour starts, how long golden hour lasts, what
 * the moon will be doing and how much of it will be lit, and — the part a map
 * can answer that a table cannot — which way to point.
 *
 * Standard astronomical formulae (Meeus, via the Astronomy Answers
 * formulations). Accurate to roughly a minute for rise and set times and a
 * fraction of a degree for positions, which is far inside the error introduced
 * by the horizon actually having hills on it.
 *
 * Everything is pure arithmetic on a Date. No network, which matters: the
 * details panel is most useful exactly where there is no signal, and this is
 * the part of it that a photographer plans a whole evening around.
 */

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;

/** Obliquity of the ecliptic — the tilt that gives us seasons. */
const OBLIQUITY = 23.4397 * RAD;

/* ------------------------------------------------------------------ time */

const toJulian = (date) => date.valueOf() / DAY_MS - 0.5 + J1970;
const fromJulian = (julian) => new Date((julian + 0.5 - J1970) * DAY_MS);
const toDays = (date) => toJulian(date) - J2000;

/* ------------------------------------------------------------------ frames */

function rightAscension(longitude, latitude) {
  return Math.atan2(
    Math.sin(longitude) * Math.cos(OBLIQUITY) - Math.tan(latitude) * Math.sin(OBLIQUITY),
    Math.cos(longitude),
  );
}

function declination(longitude, latitude) {
  return Math.asin(
    Math.sin(latitude) * Math.cos(OBLIQUITY)
    + Math.cos(latitude) * Math.sin(OBLIQUITY) * Math.sin(longitude),
  );
}

/**
 * Azimuth, measured clockwise from north.
 *
 * The underlying formula gives an angle from due south, which is the
 * astronomer's convention and the opposite of what anyone standing outside
 * with a compass wants. Converted here once, so nothing downstream has to
 * remember.
 */
function azimuthFromNorth(hourAngle, latitude, dec) {
  const fromSouth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(latitude) - Math.tan(dec) * Math.cos(latitude),
  );
  return (fromSouth / RAD + 180 + 360) % 360;
}

function altitude(hourAngle, latitude, dec) {
  return Math.asin(
    Math.sin(latitude) * Math.sin(dec)
    + Math.cos(latitude) * Math.cos(dec) * Math.cos(hourAngle),
  );
}

const siderealTime = (days, westLongitude) => RAD * (280.16 + 360.9856235 * days) - westLongitude;

/* ------------------------------------------------------------------ sun */

const solarMeanAnomaly = (days) => RAD * (357.5291 + 0.98560028 * days);

function eclipticLongitude(meanAnomaly) {
  // Equation of centre, then the longitude of perihelion.
  const centre = RAD * (1.9148 * Math.sin(meanAnomaly)
    + 0.02 * Math.sin(2 * meanAnomaly)
    + 0.0003 * Math.sin(3 * meanAnomaly));
  return meanAnomaly + centre + RAD * 102.9372 + Math.PI;
}

function sunCoords(days) {
  const meanAnomaly = solarMeanAnomaly(days);
  const longitude = eclipticLongitude(meanAnomaly);
  return { dec: declination(longitude, 0), ra: rightAscension(longitude, 0) };
}

/**
 * Where the sun is right now.
 *
 * @returns {{azimuth: number, altitude: number}} degrees; azimuth from north.
 */
export function sunPosition(date, lat, lon) {
  const westLongitude = RAD * -lon;
  const latitude = RAD * lat;
  const days = toDays(date);
  const coords = sunCoords(days);
  const hourAngle = siderealTime(days, westLongitude) - coords.ra;

  return {
    azimuth: azimuthFromNorth(hourAngle, latitude, coords.dec),
    altitude: altitude(hourAngle, latitude, coords.dec) / RAD,
  };
}

/* ---- rise and set ---- */

const J0 = 0.0009;

const julianCycle = (days, westLongitude) => Math.round(days - J0 - westLongitude / (2 * Math.PI));
const approxTransit = (angle, westLongitude, cycle) => J0 + (angle + westLongitude) / (2 * Math.PI) + cycle;
const solarTransitJ = (approx, meanAnomaly, longitude) =>
  J2000 + approx + 0.0053 * Math.sin(meanAnomaly) - 0.0069 * Math.sin(2 * longitude);

function hourAngleFor(elevation, latitude, dec) {
  return Math.acos(
    (Math.sin(elevation) - Math.sin(latitude) * Math.sin(dec))
    / (Math.cos(latitude) * Math.cos(dec)),
  );
}

/**
 * The elevations that define each phase of the day.
 *
 * -0.833° for the sun's own rise and set: half a degree for the disc's radius
 * plus about a third for atmospheric refraction, which lifts the sun into view
 * before it is geometrically up. The twilight definitions are conventions —
 * civil is when you can still read outside, nautical when the horizon is still
 * visible at sea, astronomical when the last of the sun's light leaves the sky.
 */
const ELEVATIONS = [
  { angle: -18, rise: 'astronomicalDawn', set: 'astronomicalDusk' },
  { angle: -12, rise: 'nauticalDawn', set: 'nauticalDusk' },
  { angle: -6, rise: 'civilDawn', set: 'civilDusk' },
  { angle: -4, rise: 'blueHourEnd', set: 'blueHourStart' },
  { angle: -0.833, rise: 'sunrise', set: 'sunset' },
  { angle: 6, rise: 'goldenHourEnd', set: 'goldenHourStart' },
];

/**
 * Every sun event for one day at one place.
 *
 * Times can be null: above the Arctic circle in June there is no sunrise
 * because the sun never sets, and no amount of arithmetic will produce one.
 * `polar` says which of those two situations you are in, so the caller can say
 * something true rather than printing dashes.
 *
 * @returns {{
 *   solarNoon: Date, nadir: Date, polar: ''|'day'|'night',
 *   sunrise: Date|null, sunset: Date|null, ...twilights
 * }}
 */
export function sunTimes(date, lat, lon) {
  const westLongitude = RAD * -lon;
  const latitude = RAD * lat;
  const days = toDays(date);
  const cycle = julianCycle(days, westLongitude);

  const approx = approxTransit(0, westLongitude, cycle);
  const noonAnomaly = solarMeanAnomaly(approx);
  const noonLongitude = eclipticLongitude(noonAnomaly);
  const noonDec = declination(noonLongitude, 0);
  const noonJ = solarTransitJ(approx, noonAnomaly, noonLongitude);

  /**
   * Refine a time until the sun is actually at the elevation claimed.
   *
   * The closed-form solution and the position function are different
   * approximations of the same sky, and they disagree by about forty seconds —
   * enough that solving analytically for -0.833° and then asking where the sun
   * is at that moment gives -0.65°. Which is right hardly matters; that the
   * panel shows a sunrise time and a sun position that contradict each other
   * does.
   *
   * So the analytic answer is only a first guess, and Newton's method on the
   * position function finishes the job. The two now agree by construction, and
   * the elevations mean exactly what they say.
   */
  const refine = (guessJulian, targetElevation) => {
    let time = fromJulian(guessJulian).valueOf();

    for (let pass = 0; pass < 12; pass += 1) {
      const error = sunPosition(new Date(time), lat, lon).altitude - targetElevation;
      if (Math.abs(error) < 1e-5) break;

      const step = 30000;   // half a minute, for a numeric derivative
      const ahead = sunPosition(new Date(time + step), lat, lon).altitude - targetElevation;
      const slope = (ahead - error) / step;
      if (!Number.isFinite(slope) || slope === 0) break;

      const move = error / slope;
      // The sun crosses an elevation twice a day; a runaway step would walk to
      // the other crossing and converge on the wrong one.
      time -= Math.max(-6 * 3600000, Math.min(6 * 3600000, move));
    }

    const result = new Date(time);
    return Number.isFinite(result.valueOf()) ? result : null;
  };

  const result = {
    solarNoon: fromJulian(noonJ),
    nadir: fromJulian(noonJ - 0.5),
    polar: '',
  };

  for (const { angle, rise, set } of ELEVATIONS) {
    const w = hourAngleFor(angle * RAD, latitude, noonDec);
    if (Number.isNaN(w)) {
      // The sun stays above or below this elevation for the whole day.
      result[rise] = null;
      result[set] = null;
      continue;
    }

    const offset = w / (2 * Math.PI);
    result[rise] = refine(noonJ - offset, angle);
    result[set] = refine(noonJ + offset, angle);
  }

  if (!result.sunrise) {
    result.polar = altitude(0, latitude, noonDec) > 0 ? 'day' : 'night';
  }

  return result;
}

/* ------------------------------------------------------------------ moon */

/**
 * The moon's ecliptic position.
 *
 * A short series — the leading terms only. The moon's true motion needs
 * hundreds of terms to track to arc-seconds, but this holds it to a few
 * arc-minutes, which is far better than anyone can point a camera.
 */
function moonCoords(days) {
  const eclipticLon = RAD * (218.316 + 13.176396 * days);   // mean longitude
  const meanAnomaly = RAD * (134.963 + 13.064993 * days);   // mean anomaly
  const meanDistance = RAD * (93.272 + 13.229350 * days);   // argument of latitude

  const longitude = eclipticLon + RAD * 6.289 * Math.sin(meanAnomaly);
  const latitude = RAD * 5.128 * Math.sin(meanDistance);
  const distance = 385001 - 20905 * Math.cos(meanAnomaly);  // km

  return {
    ra: rightAscension(longitude, latitude),
    dec: declination(longitude, latitude),
    distance,
  };
}

/**
 * Where the moon is right now.
 *
 * The altitude is corrected for refraction near the horizon, the same reason
 * the sun appears to rise early: near the horizon the atmosphere bends light
 * enough to matter, higher up it does not.
 */
export function moonPosition(date, lat, lon) {
  const westLongitude = RAD * -lon;
  const latitude = RAD * lat;
  const days = toDays(date);
  const coords = moonCoords(days);
  const hourAngle = siderealTime(days, westLongitude) - coords.ra;

  let h = altitude(hourAngle, latitude, coords.dec);
  h += RAD * 0.017 / Math.tan(h + RAD * 10.26 / (h / RAD + 5.10));

  return {
    azimuth: azimuthFromNorth(hourAngle, latitude, coords.dec),
    altitude: h / RAD,
    distance: coords.distance,
  };
}

const PHASE_NAMES = [
  'New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous',
  'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent',
];

/**
 * How much of the moon is lit, and which way it is heading.
 *
 * `phase` runs 0 to 1 from new moon through full and back. `fraction` is how
 * much of the disc is lit — those are different numbers, and the one people
 * mean by "percent" is the fraction. Waxing or waning is the half of the cycle,
 * which is what tells you whether tonight will be brighter than last night.
 *
 * @returns {{phase: number, fraction: number, waxing: boolean, name: string, angle: number}}
 */
export function moonIllumination(date = new Date()) {
  const days = toDays(date);
  const sun = sunCoords(days);
  const moon = moonCoords(days);
  const sunDistance = 149598000;   // km, near enough for this

  const elongation = Math.acos(
    Math.sin(sun.dec) * Math.sin(moon.dec)
    + Math.cos(sun.dec) * Math.cos(moon.dec) * Math.cos(sun.ra - moon.ra),
  );
  const inclination = Math.atan2(
    sunDistance * Math.sin(elongation),
    moon.distance - sunDistance * Math.cos(elongation),
  );
  const angle = Math.atan2(
    Math.cos(sun.dec) * Math.sin(sun.ra - moon.ra),
    Math.sin(sun.dec) * Math.cos(moon.dec)
    - Math.cos(sun.dec) * Math.sin(moon.dec) * Math.cos(sun.ra - moon.ra),
  );

  const phase = 0.5 + 0.5 * inclination * (angle < 0 ? -1 : 1) / Math.PI;
  const fraction = (1 + Math.cos(inclination)) / 2;

  return {
    phase,
    fraction,
    waxing: phase < 0.5,
    name: PHASE_NAMES[Math.round(phase * 8) % 8],
    angle,
  };
}

/**
 * Moonrise and moonset for one local day.
 *
 * Found by walking the day in hourly steps and looking for the altitude
 * crossing zero, then refining each crossing by fitting a parabola through
 * three samples. The moon moves fast enough — about half a degree an hour —
 * that a closed-form solution like the sun's does not exist, and it can rise
 * twice in a day or not at all.
 *
 * @returns {{rise: Date|null, set: Date|null, alwaysUp: boolean, alwaysDown: boolean}}
 */
export function moonTimes(date, lat, lon) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);

  const hoursToDate = (hours) => new Date(start.valueOf() + hours * 3600000);
  const heightAt = (hours) => moonPosition(hoursToDate(hours), lat, lon).altitude;

  let previous = heightAt(0);
  let rise = null;
  let set = null;

  for (let hour = 1; hour <= 24; hour += 2) {
    const middle = heightAt(hour);
    const next = heightAt(hour + 1);

    // Fit y = ax² + bx + c through the three samples and solve for the roots.
    const a = (previous + next) / 2 - middle;
    const b = (next - previous) / 2;
    const xe = -b / (2 * a);
    const ye = (a * xe + b) * xe + middle;
    const discriminant = b * b - 4 * a * middle;

    let roots = 0;
    let x1 = 0;
    let x2 = 0;

    if (discriminant >= 0) {
      const delta = Math.sqrt(discriminant) / (Math.abs(a) * 2);
      x1 = xe - delta;
      x2 = xe + delta;
      if (Math.abs(x1) <= 1) roots += 1;
      if (Math.abs(x2) <= 1) roots += 1;
      if (x1 < -1) x1 = x2;
    }

    if (roots === 1) {
      if (previous < 0) rise = hour + x1; else set = hour + x1;
    } else if (roots === 2) {
      rise = hour + (ye < 0 ? x2 : x1);
      set = hour + (ye < 0 ? x1 : x2);
    }

    if (rise !== null && set !== null) break;
    previous = next;
  }

  return {
    rise: rise === null ? null : hoursToDate(rise),
    set: set === null ? null : hoursToDate(set),
    alwaysUp: rise === null && set === null && previous > 0,
    alwaysDown: rise === null && set === null && previous <= 0,
  };
}

/* ------------------------------------------------------------------ shooting */

/**
 * The light for a day, in the order it happens.
 *
 * Returned as a list rather than an object because that is how it is read: a
 * photographer wants the sequence and the length of each stretch, not to look
 * up "civilDusk" by name. `minutes` is how long the phase lasts, which is the
 * number that decides whether there is time to move to a second location.
 */
export function lightPhases(date, lat, lon) {
  const sun = sunTimes(date, lat, lon);
  const span = (from, to) => (from && to ? Math.round((to - from) / 60000) : null);

  const phases = [
    { id: 'astronomical', name: 'Astronomical twilight', from: sun.astronomicalDawn, to: sun.nauticalDawn },
    { id: 'nautical', name: 'Nautical twilight', from: sun.nauticalDawn, to: sun.civilDawn },
    { id: 'blue', name: 'Blue hour', from: sun.civilDawn, to: sun.blueHourEnd },
    { id: 'sunrise', name: 'Sunrise', from: sun.blueHourEnd, to: sun.sunrise },
    { id: 'golden', name: 'Golden hour', from: sun.sunrise, to: sun.goldenHourEnd },
    { id: 'day', name: 'Daylight', from: sun.goldenHourEnd, to: sun.goldenHourStart },
    { id: 'golden-pm', name: 'Golden hour', from: sun.goldenHourStart, to: sun.sunset },
    { id: 'sunset', name: 'Sunset', from: sun.sunset, to: sun.blueHourStart },
    { id: 'blue-pm', name: 'Blue hour', from: sun.blueHourStart, to: sun.civilDusk },
    { id: 'nautical-pm', name: 'Nautical twilight', from: sun.civilDusk, to: sun.nauticalDusk },
    { id: 'astronomical-pm', name: 'Astronomical twilight', from: sun.nauticalDusk, to: sun.astronomicalDusk },
  ];

  return phases
    .map((phase) => ({ ...phase, minutes: span(phase.from, phase.to) }))
    .filter((phase) => phase.minutes !== null && phase.minutes > 0);
}

/**
 * Which way to point, for each event worth pointing at.
 *
 * The azimuth of the sun and moon at the moment they cross the horizon. This is
 * the thing a table cannot tell you and a map can: whether the sun will set
 * behind that ridge or to the left of it.
 */
export function lightDirections(date, lat, lon) {
  const sun = sunTimes(date, lat, lon);
  const moon = moonTimes(date, lat, lon);

  const at = (when, body) => {
    if (!when) return null;
    const position = body === 'moon' ? moonPosition(when, lat, lon) : sunPosition(when, lat, lon);
    return Math.round(position.azimuth * 10) / 10;
  };

  return [
    { id: 'sunrise', name: 'Sunrise', body: 'sun', at: sun.sunrise, azimuth: at(sun.sunrise, 'sun') },
    { id: 'sunset', name: 'Sunset', body: 'sun', at: sun.sunset, azimuth: at(sun.sunset, 'sun') },
    { id: 'moonrise', name: 'Moonrise', body: 'moon', at: moon.rise, azimuth: at(moon.rise, 'moon') },
    { id: 'moonset', name: 'Moonset', body: 'moon', at: moon.set, azimuth: at(moon.set, 'moon') },
  ].filter((entry) => entry.azimuth !== null);
}

/**
 * A point a given distance and bearing from another, for drawing the lines.
 *
 * Great-circle, because at the length these lines are drawn a flat
 * approximation would visibly bend away from true north at high latitudes —
 * which is exactly where the low sun angles that matter to a photographer are.
 */
export function destinationPoint([lon, lat], bearingDegrees, distanceKm) {
  const radius = 6371.0088;
  const angular = distanceKm / radius;
  const bearing = bearingDegrees * RAD;
  const φ1 = lat * RAD;
  const λ1 = lon * RAD;

  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(angular)
    + Math.cos(φ1) * Math.sin(angular) * Math.cos(bearing),
  );
  const λ2 = λ1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angular) * Math.cos(φ1),
    Math.cos(angular) - Math.sin(φ1) * Math.sin(φ2),
  );

  return [((λ2 / RAD + 540) % 360) - 180, φ2 / RAD];
}
